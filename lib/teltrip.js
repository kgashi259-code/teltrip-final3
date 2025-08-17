// lib/teltrip.js
// Teltrip data layer: subscribers + packages + aggregated usage (Jun 1 → today)
// subscriberOneTimeCost pulled from prepaid package template cost.

const BASE = process.env.OCS_BASE_URL;
const TOKEN = process.env.OCS_TOKEN;
const DEFAULT_ACCOUNT_ID = parseInt(process.env.OCS_ACCOUNT_ID || "0", 10);
const RANGE_START_YMD = "2025-06-01";

function must(v, name) { if (!v) throw new Error(`${name} missing`); return v; }
const toYMD = (d) => d.toISOString().slice(0, 10);

// ─────────────────────────────────────────────────────────────────────────────
// Core OCS POST (token via query, as in your project)
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

// Small worker pool
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

// ─────────────────────────────────────────────────────────────────────────────
// Template cost lookup (primary: listPrepaidPackageTemplate; fallback: getPrepaidPackageTemplate)
const templateCostCache = new Map(); // id -> { cost, currency, name }

function pickCostFromTemplate(tpl) {
  if (!tpl || typeof tpl !== "object") return null;

  // direct/common
  const direct =
    tpl.cost ?? tpl.price ?? tpl.amount ?? tpl.oneTimePrice ?? tpl.subscriberCost ?? null;
  if (typeof direct === "number" && Number.isFinite(direct)) return direct;
  if (typeof direct === "string") {
    const n = Number(direct.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  if (direct && typeof direct === "object") {
    const n = Number(direct.value ?? direct.amount ?? direct.cost ?? direct.price);
    if (Number.isFinite(n)) return n;
  }

  // shallow nested holders
  const holders = [tpl.price, tpl.pricing, tpl.priceList];
  for (const h of holders) {
    if (h && typeof h === "object") {
      const n = Number(h.value ?? h.amount ?? h.cost ?? h.price);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

async function fetchTemplateCost(templateId) {
  if (!templateId) return null;
  if (templateCostCache.has(templateId)) return templateCostCache.get(templateId);

  // Primary (docs): listPrepaidPackageTemplate
  let tpl = null;
  try {
    const resp = await callOCS({ listPrepaidPackageTemplate: { templateId: Number(templateId) } });
    tpl = resp?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate?.[0]
       ?? resp?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate
       ?? null;
  } catch {}

  // Fallback: getPrepaidPackageTemplate
  if (!tpl) {
    try {
      const resp2 = await callOCS({ getPrepaidPackageTemplate: { prepaidPackageTemplateId: Number(templateId) } });
      tpl = resp2?.prepaidPackageTemplate ?? resp2?.template ?? resp2?.prepaidPackageTemplates?.[0] ?? null;
    } catch {}
  }

  const cost = pickCostFromTemplate(tpl);
  const name = tpl?.prepaidpackagetemplatename ?? tpl?.name ?? null;
  const currency = tpl?.currency ?? tpl?.curr ?? null;

  const val = {
    cost: Number.isFinite(Number(cost)) ? Number(cost) : null,
    currency: currency || null,
    name: name || null
  };
  templateCostCache.set(templateId, val);
  return val;
}

// ─────────────────────────────────────────────────────────────────────────────
// Packages (support both ...Rsp and non-Rsp shapes)
async function fetchPackagesFor(subscriberId) {
  const resp = await callOCS({ listSubscriberPrepaidPackages: { subscriberId } });
  const pkgs =
    resp?.listSubscriberPrepaidPackagesRsp?.packages ||
    resp?.listSubscriberPrepaidPackages?.packages ||
    resp?.packages || [];
  if (!Array.isArray(pkgs) || !pkgs.length) return null;

  pkgs.sort((a,b)=> new Date(a.tsactivationutc||0) - new Date(b.tsactivationutc||0));
  const p = pkgs.at(-1);

  const tpl = p?.packageTemplate ?? p?.template ?? p ?? {};
  const templateId =
    tpl.prepaidpackagetemplateid ??
    tpl.prepaidPackageTemplateId ??
    tpl.templateId ??
    tpl.id ??
    null;

  return {
    prepaidpackagetemplatename: tpl.prepaidpackagetemplatename ?? tpl.name ?? null,
    prepaidpackagetemplateid: templateId,
    tsactivationutc: p?.tsactivationutc ?? null,
    tsexpirationutc: p?.tsexpirationutc ?? null,
    pckdatabyte: p?.pckdatabyte ?? p?.packageDataByte ?? null,
    useddatabyte: p?.useddatabyte ?? p?.usedDataByte ?? null
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage windows (unchanged)
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
    resp?.subscriberUsageOverPeriod?.total ||
    resp?.subscriberUsageOverPeriodRsp?.total ||
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

// ─────────────────────────────────────────────────────────────────────────────
// Main
export async function fetchAllData(accountIdParam) {
  const accountId = parseInt(accountIdParam || DEFAULT_ACCOUNT_ID || "0", 10);
  if (!accountId) throw new Error("Provide accountId (env OCS_ACCOUNT_ID or ?accountId=)");

  // Subscribers (support both shapes)
  const subsResp = await callOCS({ listSubscriber: { accountId } });
  const subscribers =
    subsResp?.listSubscriberRsp?.subscriber ||
    subsResp?.listSubscriber?.subscriberList ||
    subsResp?.subscriberList ||
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

      // package (filled below)
      prepaidpackagetemplatename: null,
      prepaidpackagetemplateid: null,
      tsactivationutc: null,
      tsexpirationutc: null,
      pckdatabyte: null,
      useddatabyte: null,

      // cost
      subscriberOneTimeCost: null,

      // totals since 2025-06-01
      totalBytesSinceJun1: null,
      resellerCostSinceJun1: null,

      _sid: s?.subscriberId ?? s?.id ?? null
    };
  });

  await pMap(rows, async (r) => {
    if (!r._sid) return;

    // 1) latest package → ensures we have templateId/name
    try {
      const pkg = await fetchPackagesFor(r._sid);
      if (pkg) Object.assign(r, pkg);
    } catch {}

    // 2) template cost → fill subscriberOneTimeCost
    try {
      if (r.prepaidpackagetemplateid) {
        const tpl = await fetchTemplateCost(r.prepaidpackagetemplateid);
        if (tpl?.cost != null) r.subscriberOneTimeCost = tpl.cost;
        if (tpl?.name && !r.prepaidpackagetemplatename) r.prepaidpackagetemplatename = tpl.name;
      }
    } catch {}

    // 3) aggregated usage (optional; unchanged)
    try {
      const aggr = await fetchAggregatedUsage(r._sid);
      r.totalBytesSinceJun1   = aggr.sumBytes;
      r.resellerCostSinceJun1 = aggr.sumResCost;
    } catch {}

    delete r._sid;
  }, 6);

  return rows;
}
