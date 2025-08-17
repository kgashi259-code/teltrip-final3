// lib/teltrip.js
// Teltrip data layer: subscribers + packages + aggregated usage (Jun 1 → today)
// Fix: robust template cost detection + debug logs (TELTRIP_DEBUG=1)

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
  const url = `${BASE}?token=${encodeURIComponent(TOKEN)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      signal: controller.signal
    });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}${text ? " :: " + text.slice(0,300) : ""}`);
    return json ?? {};
  } finally {
    clearTimeout(timer);
  }
}

// ---------- worker pool ----------
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
function logOnce(key, ...args) {
  if (!DEBUG) return;
  const mark = `__LOGGED_${key}`;
  if (logOnce[mark]) return;
  logOnce[mark] = true;
  console.log(...args); // logs show in /api/fetch-data logs
}
const asKey = (id) => (id == null ? null : (Number.isFinite(Number(id)) ? String(Number(id)) : String(id)));

// ---------- robust cost picker ----------
function pickNumericCostFromTemplate(tpl) {
  if (!tpl || typeof tpl !== "object") return null;
  const hits = [];
  const keyRe = /(cost|price|amount|oneTime|subscriberCost)/i;

  function walk(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 5) return; // stop too deep
    for (const [k, v] of Object.entries(obj)) {
      if (v == null) continue;
      if (typeof v === "number" && keyRe.test(k) && Number.isFinite(v)) hits.push(v);
      else if (typeof v === "string" && keyRe.test(k)) {
        const num = Number(v.replace(/[^0-9.]/g, ""));
        if (Number.isFinite(num)) hits.push(num);
      } else if (typeof v === "object") {
        walk(v, depth + 1);
      }
    }
  }
  walk(tpl);

  if (hits.length) {
    // choose the smallest positive as one-time price (usually the fee, not bundles)
    const sorted = hits.filter(n => n >= 0).sort((a,b)=>a-b);
    return sorted[0] ?? null;
  }
  return null;
}

// ---------- template lookups ----------
const templateCostCache = new Map(); // key -> { cost, currency, name }

async function fetchTemplateCost(templateIdIn) {
  const key = asKey(templateIdIn);
  if (!key) return null;
  if (templateCostCache.has(key)) return templateCostCache.get(key);

  let tpl = null;

  // Try documented list-by-id
  try {
    const r1 = await callOCS({ listPrepaidPackageTemplate: { templateId: Number(key) } });
    tpl = r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate?.[0]
       ?? r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate
       ?? null;
    if (tpl) logOnce(`tpl_ok1_${key}`, "[TPL] listPrepaidPackageTemplate OK", key);
  } catch (e) {
    logOnce(`tpl_err1_${key}`, "[TPL] listPrepaidPackageTemplate failed", key, e?.message);
  }

  // Fallback get-by-id variant
  if (!tpl) {
    try {
      const r2 = await callOCS({ getPrepaidPackageTemplate: { prepaidPackageTemplateId: Number(key) } });
      tpl = r2?.prepaidPackageTemplate ?? r2?.template ?? r2?.prepaidPackageTemplates?.[0] ?? null;
      if (tpl) logOnce(`tpl_ok2_${key}`, "[TPL] getPrepaidPackageTemplate OK", key);
    } catch (e) {
      logOnce(`tpl_err2_${key}`, "[TPL] getPrepaidPackageTemplate failed", key, e?.message);
    }
  }

  // Debug dump (once) to see real shape
  if (tpl) logOnce(`tpl_dump_${key}`, "[TPL] dump", key, JSON.stringify(tpl).slice(0, 1200));

  // Normalize
  let cost =
    Number((tpl && (tpl.cost ?? tpl.price ?? tpl.amount ?? tpl.subscriberCost)) ?? NaN);
  if (!Number.isFinite(cost)) cost = pickNumericCostFromTemplate(tpl);

  const val = {
    cost: Number.isFinite(cost) ? cost : null,
    currency: tpl?.currency ?? tpl?.curr ?? null,
    name: tpl?.prepaidpackagetemplatename ?? tpl?.name ?? tpl?.templateName ?? null
  };
  templateCostCache.set(key, val);
  return val;
}

// ---------- packages ----------
async function fetchPackagesFor(subscriberId) {
  const resp = await callOCS({ listSubscriberPrepaidPackages: { subscriberId } });

  const pkgs =
    resp?.listSubscriberPrepaidPackages?.packages ??
    resp?.listSubscriberPrepaidPackagesRsp?.packages ??
    resp?.packages ?? [];

  if (!Array.isArray(pkgs) || !pkgs.length) return null;

  pkgs.sort((a,b)=> new Date(a.tsactivationutc||0) - new Date(b.tsactivationutc||0));
  const p = pkgs.at(-1);

  const tpl = p?.packageTemplate ?? p?.template ?? p ?? {};
  const templateIdRaw =
    tpl.prepaidpackagetemplateid ??
    tpl.prepaidPackageTemplateId ??
    tpl.templateId ??
    tpl.id ?? null;

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
    resp?.subscriberUsageOverPeriodRsp?.total ?? {};
  const qty = total?.quantityPerType || {};
  const bytes = typeof qty["33"] === "number" ? qty["33"] : null;
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

  const subsResp = await callOCS({ listSubscriber: { accountId } });
  const subscribers =
    subsResp?.listSubscriber?.subscriberList ??
    subsResp?.listSubscriberRsp?.subscriber ??
    subsResp?.subscriberList ?? [];

  const rows = subscribers.map((s) => {
    const imsi = s?.imsiList?.[0]?.imsi ?? s?.imsi ?? null;
    const iccid = s?.imsiList?.[0]?.iccid ?? s?.sim?.iccid ?? s?.iccid ?? null;
    const phone = s?.phoneNumberList?.[0]?.phoneNumber ?? s?.phoneNumber ?? null;
    const st = latestByDate(s?.status) || null;

    const subTplName = s?.prepaidpackagetemplatename ?? s?.prepaidPackageTemplateName ?? null;
    const subTplId   = s?.prepaidpackagetemplateid   ?? s?.prepaidPackageTemplateId   ?? s?.templateId ?? null;

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

      // package (may be filled from listSubscriber or by packages call)
      prepaidpackagetemplatename: subTplName,
      prepaidpackagetemplateid: subTplId,
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

    // 1) latest package info (to ensure template id)
    try {
      const pkg = await fetchPackagesFor(r._sid);
      if (pkg) {
        if (r.prepaidpackagetemplatename == null) r.prepaidpackagetemplatename = pkg.prepaidpackagetemplatename;
        if (r.prepaidpackagetemplateid == null)   r.prepaidpackagetemplateid   = pkg.prepaidpackagetemplateid;
        r.tsactivationutc = pkg.tsactivationutc;
        r.tsexpirationutc = pkg.tsexpirationutc;
        r.pckdatabyte     = pkg.pckdatabyte;
        r.useddatabyte    = pkg.useddatabyte;
      }
    } catch (e) {
      logOnce(`pkg_fail_${r._sid}`, "[PKG] fetchPackagesFor failed", r._sid, e?.message);
    }

    // 2) template cost by ID → robust parse
    try {
      if (r.prepaidpackagetemplateid != null) {
        const tpl = await fetchTemplateCost(r.prepaidpackagetemplateid);
        if (tpl?.cost != null) r.subscriberOneTimeCost = tpl.cost;
        if (tpl?.name && !r.prepaidpackagetemplatename) r.prepaidpackagetemplatename = tpl.name;
        logOnce(`row_tpl_${r.prepaidpackagetemplateid}`, "[ROW] template applied", r.prepaidpackagetemplateid, r.subscriberOneTimeCost);
      } else {
        logOnce(`row_no_tpl_${r._sid}`, "[ROW] missing prepaidpackagetemplateid for subscriber", r._sid);
      }
    } catch (e) {
      logOnce(`row_tpl_fail_${r._sid}`, "[ROW] template fetch failed", r._sid, e?.message);
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
