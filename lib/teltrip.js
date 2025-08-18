// Teltrip data layer: subscribers + packages + aggregated usage (Jun 1 → today)
// subscriberOneTimeCost now comes from Template cost (robust lookup).

const BASE = process.env.OCS_BASE_URL;
const TOKEN = process.env.OCS_TOKEN;
const DEFAULT_ACCOUNT_ID = parseInt(process.env.OCS_ACCOUNT_ID || "0", 10);
const RANGE_START_YMD = "2025-06-01";

function must(v, name) { if (!v) throw new Error(`${name} missing`); return v; }
const toYMD = (d) => d.toISOString().slice(0, 10);

// ---------- core fetch ----------
async function callOCS(payload) {
  must(BASE, "OCS_BASE_URL"); must(TOKEN, "OCS_TOKEN");
  const url = `${BASE}?token=${encodeURIComponent(TOKEN)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
    signal: controller.signal
  }).finally(() => clearTimeout(timer));
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}${text ? " :: " + text.slice(0,300) : ""}`);
  return json ?? {};
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
const templateCostCache = new Map(); // id -> { cost, currency, name }

async function fetchTemplateCost(templateId) {
  if (!templateId) return null;
  if (templateCostCache.has(templateId)) return templateCostCache.get(templateId);

  // helper: extract a usable number from common/nested shapes
  const pickCost = (tpl) => {
    if (!tpl || typeof tpl !== "object") return null;
    const direct = tpl.oneTimePrice ?? tpl.activationFee ?? tpl.subscriberCost ?? tpl.cost ?? tpl.price ?? tpl.amount;
    const tryNum = (v) => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const n = Number(v.replace(/[^0-9.]/g, ""));
        if (Number.isFinite(n)) return n;
      }
      if (v && typeof v === "object") {
        const n = Number(v.value ?? v.amount ?? v.cost ?? v.price);
        if (Number.isFinite(n)) return n;
      }
      return null;
    };
    let n = tryNum(direct);
    if (n != null) return n;

    // shallow nested holders and arrays (e.g., prices/pricing lists)
    const buckets = [tpl.price, tpl.pricing, tpl.priceList, tpl.prices, tpl.charges];
    for (const b of buckets) {
      if (!b) continue;
      const val = Array.isArray(b)
        ? b
            .map((it) => {
              // prefer items marked one-time/activation/setup
              const t = String(it?.type || it?.kind || it?.chargeType || it?.category || "").toLowerCase();
              const prefer = /(one[_-]?time|onetime|activation|setup|fee)/.test(t);
              const num = tryNum(it?.price ?? it?.value ?? it?.amount ?? it?.cost ?? it);
              return { prefer, num };
            })
            .filter((x) => x.num != null)
        : [{ prefer: false, num: tryNum(b) }];
      // pick preferred positive first, then any positive, then zero
      const posPrefer = val.filter((x) => x.prefer && x.num > 0).map((x) => x.num).sort((a,b)=>a-b);
      if (posPrefer.length) return posPrefer[0];
      const pos = val.filter((x) => x.num > 0).map((x) => x.num).sort((a,b)=>a-b);
      if (pos.length) return pos[0];
      const zeros = val.find((x) => x.num === 0);
      if (zeros) return 0;
    }
    return null;
  };

  // Try both API shapes: list-by-id first, then get-by-id
  let tpl = null;
  try {
    const r1 = await callOCS({ listPrepaidPackageTemplate: { templateId: Number(templateId) } });
    tpl = r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate?.[0]
       ?? r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate
       ?? null;
  } catch {}

  if (!tpl) {
    try {
      const r2 = await callOCS({ getPrepaidPackageTemplate: { prepaidPackageTemplateId: Number(templateId) } });
      tpl = r2?.prepaidPackageTemplate ?? r2?.prepaidPackageTemplates ?? r2?.template ?? null;
    } catch {}
  }

  const costNum = pickCost(tpl);
  const name = tpl?.name ?? tpl?.prepaidpackagetemplatename ?? null;
  const currency = tpl?.currency ?? tpl?.curr ?? null;

  const val = {
    cost: Number.isFinite(costNum) ? costNum : null,
    currency: currency || null,
    name: name || null
  };
  templateCostCache.set(templateId, val);
  return val;
}

// ---------- packages ----------
async function fetchPackagesFor(subscriberId) {
  const resp = await callOCS({ listSubscriberPrepaidPackages: { subscriberId } });
  const pkgs = resp?.listSubscriberPrepaidPackages?.packages || [];
  if (!pkgs.length) return null;
  pkgs.sort((a,b)=> new Date(a.tsactivationutc||0) - new Date(b.tsactivationutc||0));
  const p = pkgs.at(-1);
  const tpl = p?.packageTemplate || {};
  return {
    prepaidpackagetemplatename: tpl.prepaidpackagetemplatename ?? tpl.name ?? null,
    prepaidpackagetemplateid: tpl.prepaidpackagetemplateid ?? tpl.id ?? null,
    tsactivationutc: p?.tsactivationutc ?? null,
    tsexpirationutc: p?.tsexpirationutc ?? null,
    pckdatabyte: p?.pckdatabyte ?? null,
    useddatabyte: p?.useddatabyte ?? null
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
  const total = resp?.subscriberUsageOverPeriod?.total || {};
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

  const subsResp = await callOCS({ listSubscriber: { accountId } });
  const subscribers = subsResp?.listSubscriber?.subscriberList || [];

  const rows = subscribers.map((s) => {
    const imsi = s?.imsiList?.[0]?.imsi ?? null;
    const iccid = s?.imsiList?.[0]?.iccid ?? s?.sim?.iccid ?? null;
    const phone = s?.phoneNumberList?.[0]?.phoneNumber ?? null;
    const st = latestByDate(s?.status) || null;
    return {
      iccid,
      imsi,
      phoneNumber: phone,
      activationDate: s?.activationDate ?? null,
      lastUsageDate: s?.lastUsageDate ?? null,
      subscriberStatus: st?.status ?? null,
      simStatus: s?.sim?.status ?? null,
      esim: s?.sim?.esim ?? null,
      smdpServer: s?.sim?.smdpServer ?? null,
      activationCode: s?.sim?.activationCode ?? null,
      prepaid: s?.prepaid ?? null,
      balance: s?.balance ?? null,
      account: s?.account ?? null,
      reseller: s?.reseller ?? null,
      lastMcc: s?.lastMcc ?? null,
      lastMnc: s?.lastMnc ?? null,

      // package
      prepaidpackagetemplatename: null,
      prepaidpackagetemplateid: null,
      tsactivationutc: null,
      tsexpirationutc: null,
      pckdatabyte: null,
      useddatabyte: null,
      subscriberOneTimeCost: null,   // from template cost

      // totals since 2025-06-01
      totalBytesSinceJun1: null,
      resellerCostSinceJun1: null,

      _sid: s?.subscriberId ?? null
    };
  });

  await pMap(rows, async (r) => {
    if (!r._sid) return;

    // 1) packages
    try {
      const pkg = await fetchPackagesFor(r._sid);
      if (pkg) Object.assign(r, pkg);
    } catch {}

    // 2) get template cost by ID (override subscriberOneTimeCost)
    try {
      if (r.prepaidpackagetemplateid) {
        const tpl = await fetchTemplateCost(r.prepaidpackagetemplateid);
        if (tpl?.cost != null) {
          r.subscriberOneTimeCost = tpl.cost;
          // (optional) r.packageCurrency = tpl.currency;
        }
        // prefer template name if present
        if (tpl?.name && !r.prepaidpackagetemplatename) {
          r.prepaidpackagetemplatename = tpl.name;
        }
      }
    } catch {}

    // 3) aggregated usage & reseller cost (Jun 1 → today)
    try {
      const aggr = await fetchAggregatedUsage(r._sid);
      r.totalBytesSinceJun1   = aggr.sumBytes;
      r.resellerCostSinceJun1 = aggr.sumResCost;
    } catch {}

    delete r._sid;
  }, 6);

  return rows;
}
