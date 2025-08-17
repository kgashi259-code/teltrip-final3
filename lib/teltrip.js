// lib/teltrip.js
// Teltrip data layer: subscribers + packages + aggregated usage (Jun 1 → today)
// subscriberOneTimeCost is read from prepaid package template cost.

const BASE = process.env.OCS_BASE_URL;
const TOKEN = process.env.OCS_TOKEN;
const DEFAULT_ACCOUNT_ID = parseInt(process.env.OCS_ACCOUNT_ID || "0", 10);
const RANGE_START_YMD = "2025-06-01";
const DEBUG = process.env.TELTRIP_DEBUG === "1";

function must(v, name) { if (!v) throw new Error(`${name} missing`); return v; }
const toYMD = (d) => d.toISOString().slice(0, 10);

// ---------- core fetch ----------
async function callOCS(payload) {
  must(BASE, "OCS_BASE_URL"); must(TOKEN, "OCS_TOKEN");
  // Your API expects token in query param (kept as-is)
  const url = `${BASE}?token=${encodeURIComponent(TOKEN)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  let text = "";
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal
    });
    text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}${text ? " :: " + text.slice(0,300) : ""}`);
    return json ?? {};
  } finally {
    clearTimeout(timer);
  }
}

// ---------- small worker pool ----------
async function pMap(list, fn, concurrency = 5) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, list.length) }, async () => {
      while (i < list.length) {
        const idx = i++;
        out[idx] = await fn(list[idx], idx);
      }
    })
  );
  return out;
}

function latestByDate(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr.slice().sort((a,b)=>new Date(a.startDate||0)-new Date(b.startDate||0)).at(-1);
}

// ---------- template cost (robust) ----------
const templateCostCache = new Map(); // key: String(templateId) -> { cost, currency, name }

function logOnce(key, ...args) {
  if (!DEBUG) return;
  const mark = `__LOGGED_${key}`;
  if (logOnce[mark]) return;
  logOnce[mark] = true;
  // eslint-disable-next-line no-console
  console.log(...args);
}

function toTemplateIdKey(id) {
  if (id == null) return null;
  const n = Number(id);
  return Number.isFinite(n) ? String(n) : String(id);
}

/**
 * Try both documented and alt shapes for template lookups + responses.
 * Returns { cost|null, currency|null, name|null }
 */
async function fetchTemplateCost(templateIdIn) {
  const key = toTemplateIdKey(templateIdIn);
  if (!key) return null;
  if (templateCostCache.has(key)) return templateCostCache.get(key);

  // Primary: listPrepaidPackageTemplate { templateId }
  let tpl = null;
  try {
    const resp1 = await callOCS({ listPrepaidPackageTemplate: { templateId: Number(key) } });
    tpl =
      resp1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate?.[0] ??
      resp1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate ??
      null;
    if (tpl) {
      logOnce(`tpl_ok_${key}`, "[TPL] listPrepaidPackageTemplate OK for", key, tpl);
    }
  } catch (e) {
    logOnce(`tpl_err1_${key}`, "[TPL] listPrepaidPackageTemplate failed for", key, e?.message);
  }

  // Fallback: getPrepaidPackageTemplate { prepaidPackageTemplateId }
  if (!tpl) {
    try {
      const resp2 = await callOCS({ getPrepaidPackageTemplate: { prepaidPackageTemplateId: Number(key) } });
      tpl =
        resp2?.prepaidPackageTemplate ??
        resp2?.template ??
        resp2?.prepaidPackageTemplates?.[0] ??
        null;
      if (tpl) {
        logOnce(`tpl_ok2_${key}`, "[TPL] getPrepaidPackageTemplate OK for", key, tpl);
      }
    } catch (e) {
      logOnce(`tpl_err2_${key}`, "[TPL] getPrepaidPackageTemplate failed for", key, e?.message);
    }
  }

  // Normalize fields
  const costNum = Number(
    (tpl && (tpl.cost ?? tpl.price ?? tpl.amount ?? tpl.subscriberCost)) ?? NaN
  );
  const name =
    tpl?.prepaidpackagetemplatename ??
    tpl?.name ??
    tpl?.templateName ??
    null;
  const currency = tpl?.currency ?? tpl?.curr ?? null;

  const val = {
    cost: Number.isFinite(costNum) ? costNum : null,
    currency: currency || null,
    name: name || null
  };

  templateCostCache.set(key, val);
  return val;
}

// ---------- packages ----------
/**
 * listSubscriberPrepaidPackages → pick latest package and normalize fields
 */
async function fetchPackagesFor(subscriberId) {
  const resp = await callOCS({ listSubscriberPrepaidPackages: { subscriberId } });

  // Try multiple possible shapes
  const pkgs =
    resp?.listSubscriberPrepaidPackages?.packages ??
    resp?.listSubscriberPrepaidPackagesRsp?.packages ??
    resp?.packages ??
    [];

  if (!Array.isArray(pkgs) || !pkgs.length) return null;

  pkgs.sort((a,b)=> new Date(a.tsactivationutc||0) - new Date(b.tsactivationutc||0));
  const p = pkgs.at(-1);

  // Template object sometimes nested, sometimes flattened
  const tpl = p?.packageTemplate ?? p?.template ?? p ?? {};

  // Normalize template id/name/data fields
  const templateIdRaw =
    tpl.prepaidpackagetemplateid ??
    tpl.prepaidPackageTemplateId ??
    tpl.templateId ??
    tpl.id ??
    null;

  return {
    prepaidpackagetemplatename:
      tpl.prepaidpackagetemplatename ?? tpl.name ?? tpl.templateName ?? null,
    prepaidpackagetemplateid: templateIdRaw,
    tsactivationutc: p?.tsactivationutc ?? null,
    tsexpirationutc: p?.tsexpirationutc ?? null,
    pckdatabyte: p?.pckdatabyte ?? p?.packageDataByte ?? null,
    useddatabyte: p?.useddatabyte ?? p?.usedDataByte ?? null
  };
}

// ---------- usage windows ----------
function addDays(base, n) { const d = new Date(base); d.setDate(d.getDate() + n); return d; }
function parseYMD(s) { const [y,m,d]=s.split("-").map(Number); return new Date(Date.UTC(y, m-1, d)); }
function* weekWindows(startYMD, endYMD) {
  let start = parseYMD(startYMD);
  const endHard = parseYMD(endYMD);
  while (start <= endHard) {
    const end = addDays(start, 6);
    const endClamped = end > endHard ? endHard : end;
    yield { start: toYMD(start), end: toYMD(endClamped) };
    start = addDays(endClamped, 1);
  }
}

async function fetchUsageWindow(subscriberId, startYMD, endYMD) {
  const resp = await callOCS({
    subscriberUsageOverPeriod: {
      subscriber: { subscriberId },
      period: { start: startYMD, end: endYMD }
    }
  });
  const total =
    resp?.subscriberUsageOverPeriod?.total ??
    resp?.subscriberUsageOverPeriodRsp?.total ??
    {};
  const qty = total?.quantityPerType || {};
  const bytes = typeof qty["33"] === "number" ? qty["33"] : null; // data
  const resellerCost = Number.isFinite(total?.resellerCost) ? total.resellerCost : null;
  return { bytes, resellerCost };
}

async function fetchAggregatedUsage(subscriberId) {
  const todayYMD = toYMD(new Date());
  const windows = Array.from(weekWindows(RANGE_START_YMD, todayYMD));
  let sumBytes = 0, sumResCost = 0;
  await pMap(windows, async (win) => {
    const { bytes, resellerCost } = await fetchUsageWindow(subscriberId, win.start, win.end);
    if (Number.isFinite(bytes))        sumBytes += bytes;
    if (Number.isFinite(resellerCost)) sumResCost += resellerCost;
  }, 6);
  return { sumBytes, sumResCost };
}

// ---------- main ----------
export async function fetchAllData(accountIdParam) {
  const accountId = parseInt(accountIdParam || DEFAULT_ACCOUNT_ID || "0", 10);
  if (!accountId) throw new Error("Provide accountId (env OCS_ACCOUNT_ID or ?accountId=)");

  // listSubscriber → note: your API has different shapes across accounts/vendors
  const subsResp = await callOCS({ listSubscriber: { accountId } });
  const subscribers =
    subsResp?.listSubscriber?.subscriberList ??
    subsResp?.listSubscriberRsp?.subscriber ??
    subsResp?.subscriberList ??
    [];

  const rows = subscribers.map((s) => {
    const imsi = s?.imsiList?.[0]?.imsi ?? s?.imsi ?? null;
    const iccid = s?.imsiList?.[0]?.iccid ?? s?.sim?.iccid ?? s?.iccid ?? null;
    const phone = s?.phoneNumberList?.[0]?.phoneNumber ?? s?.phoneNumber ?? null;
    const st = latestByDate(s?.status) || null;
    return {
      iccid,
      imsi,
      phoneNumber: phone,
      activationDate: s?.activationDate ?? null,
      lastUsageDate: s?.lastUsageDate ?? null,
      subscriberStatus: st?.status ?? s?.subscriberStatus ?? null,
      simStatus: s?.sim?.status ?? s?.simStatus ?? null,
      esim: s?.sim?.esim ?? s?.esim ?? null,
      smdpServer: s?.sim?.smdpServer ?? null,
      activationCode: s?.sim?.activationCode ?? null,
      prepaid: s?.prepaid ?? null,
      balance: s?.balance ?? null,
      account: s?.account ?? null,
      reseller: s?.reseller ?? null,
      lastMcc: s?.lastMcc ?? null,
      lastMnc: s?.lastMnc ?? null,

      // package (filled later)
      prepaidpackagetemplatename: null,
      prepaidpackagetemplateid: null,
      tsactivationutc: null,
      tsexpirationutc: null,
      pckdatabyte: null,
      useddatabyte: null,
      subscriberOneTimeCost: null,

      // totals since 2025-06-01
      totalBytesSinceJun1: null,
      resellerCostSinceJun1: null,

      _sid: s?.subscriberId ?? s?.id ?? null
    };
  });

  await pMap(rows, async (r) => {
    if (!r._sid) return;

    // 1) latest package info → ensures we capture template id correctly
    try {
      const pkg = await fetchPackagesFor(r._sid);
      if (pkg) Object.assign(r, pkg);
    } catch (e) {
      logOnce(`pkg_fail_${r._sid}`, "[PKG] fetchPackagesFor failed", r._sid, e?.message);
    }

    // 2) template cost by ID
    try {
      if (r.prepaidpackagetemplateid != null) {
        const tpl = await fetchTemplateCost(r.prepaidpackagetemplateid);
        if (tpl?.cost != null) r.subscriberOneTimeCost = tpl.cost;
        if (tpl?.name && !r.prepaidpackagetemplatename) r.prepaidpackagetemplatename = tpl.name;
        logOnce(`tpl_row_${r.prepaidpackagetemplateid}`, "[ROW] template applied", r.prepaidpackagetemplateid, r.subscriberOneTimeCost);
      } else {
        logOnce(`no_tpl_${r._sid}`, "[ROW] missing prepaidpackagetemplateid for subscriber", r._sid);
      }
    } catch (e) {
      logOnce(`tpl_fail_${r._sid}`, "[ROW] template fetch failed", r._sid, e?.message);
    }

    // 3) aggregated usage & reseller cost (Jun 1 → today)
    try {
      const aggr = await fetchAggregatedUsage(r._sid);
      r.totalBytesSinceJun1   = aggr.sumBytes;
      r.resellerCostSinceJun1 = aggr.sumResCost;
    } catch (e) {
      logOnce(`aggr_fail_${r._sid}`, "[AGGR] usage aggregation failed", r._sid, e?.message);
    }

    delete r._sid;
  }, 6);

  return rows;
}
