// Teltrip data layer: resilient version (retries, longer timeout, lower concurrency)

const BASE = process.env.OCS_BASE_URL;
const TOKEN = process.env.OCS_TOKEN;
const DEFAULT_ACCOUNT_ID = parseInt(process.env.OCS_ACCOUNT_ID || "0", 10);
const RANGE_START_YMD = "2025-06-01";

// ---------- utils ----------
const toYMD = (d) => d.toISOString().slice(0, 10);
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
function latestByDate(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr.slice().sort((a,b)=>new Date(a.startDate||0)-new Date(b.startDate||0)).at(-1);
}

// ---------- core fetch with retries ----------
async function callOCSOnce(payload, timeoutMs = 60_000) {
  if (!BASE) throw new Error("OCS_BASE_URL missing");
  if (!TOKEN) throw new Error("OCS_TOKEN missing");
  const url = `${BASE}?token=${encodeURIComponent(TOKEN)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(payload),
      signal: ctrl.signal
    });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}${text ? " :: " + text.slice(0,300) : ""}`);
    return json ?? {};
  } finally {
    clearTimeout(timer);
  }
}

async function sleep(ms){ return new Promise(res=>setTimeout(res, ms)); }
async function callOCS(payload) {
  const tries = 3;
  let attempt = 0, lastErr;
  while (attempt < tries) {
    try {
      return await callOCSOnce(payload);
    } catch (e) {
      lastErr = e;
      attempt++;
      if (attempt >= tries) break;
      await sleep(300 * Math.pow(2, attempt - 1)); // 300ms, 600ms
    }
  }
  throw lastErr;
}

// ---------- small promise pool (lower concurrency to avoid throttling) ----------
async function pMap(list, fn, concurrency = 3) {
  if (!Array.isArray(list) || !list.length) return [];
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

// ---------- template cost (robust) ----------
const templateCostCache = new Map(); // id -> { cost, currency, name }

async function fetchTemplateCost(templateId) {
  if (!templateId) return null;
  if (templateCostCache.has(templateId)) return templateCostCache.get(templateId);

  let tpl = null;
  // try list-by-id (often includes pricing arrays)
  try {
    const r1 = await callOCS({ listPrepaidPackageTemplate: { templateId: Number(templateId) } });
    tpl = r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate?.[0]
       ?? r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate
       ?? null;
  } catch {}
  // fallback get-by-id
  if (!tpl) {
    try {
      const r2 = await callOCS({ getPrepaidPackageTemplate: { prepaidPackageTemplateId: Number(templateId) } });
      tpl = r2?.prepaidPackageTemplate ?? r2?.prepaidPackageTemplates ?? r2?.template ?? null;
    } catch {}
  }

  function asNum(v) {
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
  }

  let candidates = [];
  if (tpl) {
    for (const k of ["oneTimePrice","activationFee","subscriberCost","cost","price","amount"]) {
      if (k in tpl) {
        const n = asNum(tpl[k]); if (n != null) candidates.push({ n, prefer: k !== "cost" ? 1 : 0 });
      }
    }
    for (const k of ["price","pricing","prices","priceList","charges"]) {
      const v = tpl[k];
      if (!v) continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          const t = String(item?.type || item?.kind || item?.chargeType || item?.category || "").toLowerCase();
          const prefer = /(one[_-]?time|onetime|activation|setup|fee)/.test(t) ? 2 : 0;
          const n = asNum(item?.price ?? item?.value ?? item?.amount ?? item?.cost ?? item);
          if (n != null) candidates.push({ n, prefer });
        }
      } else {
        const n = asNum(v); if (n != null) candidates.push({ n, prefer: 0 });
      }
    }
  }

  let costNum = null;
  const posPref = candidates.filter(x => x.n > 0 && x.prefer > 0).sort((a,b)=>a.n-b.n);
  if (posPref.length) costNum = posPref[0].n;
  else {
    const pos = candidates.filter(x => x.n > 0).sort((a,b)=>a.n-b.n);
    if (pos.length) costNum = pos[0].n;
    else if (candidates.find(x => x.n === 0)) costNum = 0;
  }

  const name = tpl?.name ?? tpl?.prepaidpackagetemplatename ?? null;
  const currency = tpl?.currency ?? tpl?.curr ?? null;
  const val = { cost: Number.isFinite(costNum) ? costNum : null, currency: currency || null, name: name || null };
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
  const packageOneTimeCost =
    (typeof p?.cost === "number" ? p.cost : null) ??
    (typeof p?.oneTimePrice === "number" ? p.oneTimePrice : null) ??
    (typeof p?.activationFee === "number" ? p.activationFee : null) ??
    (typeof p?.price?.value === "number" ? p.price.value : null) ?? null;

  return {
    prepaidpackagetemplatename: tpl.prepaidpackagetemplatename ?? tpl.name ?? null,
    prepaidpackagetemplateid: tpl.prepaidpackagetemplateid ?? tpl.id ?? null,
    tsactivationutc: p?.tsactivationutc ?? null,
    tsexpirationutc: p?.tsexpirationutc ?? null,
    pckdatabyte: p?.pckdatabyte ?? null,
    useddatabyte: p?.useddatabyte ?? null,
    packageOneTimeCost
  };
}

// ---------- usage ----------
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
  for (const win of windows) {
    try {
      const { bytes, resellerCost } = await fetchUsageWindow(subscriberId, win.start, win.end);
      if (Number.isFinite(bytes))        sumBytes += bytes;
      if (Number.isFinite(resellerCost)) sumResCost += resellerCost;
    } catch {
      // skip window on failure (retry logic already applied per-call)
    }
  }
  return { sumBytes, sumResCost };
}

// ---------- main ----------
export async function fetchAllData(accountIdParam) {
  const accountId = parseInt(accountIdParam || DEFAULT_ACCOUNT_ID || "0", 10);
  if (!accountId) throw new Error("Provide accountId (env OCS_ACCOUNT_ID or ?accountId=)");

  const subsResp = await callOCS({ listSubscriber: { accountId } });
  const subscribers =
    subsResp?.listSubscriber?.subscriberList ||
    subsResp?.listSubscriberRsp?.subscriber ||
    subsResp?.subscriberList || [];

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
      activationCode: s?.sim?.activationCode ?? s?.activationCode ?? null,
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

      // cost
      subscriberOneTimeCost: null,

      // totals since 2025-06-01
      totalBytesSinceJun1: null,
      resellerCostSinceJun1: null,

      _sid: s?.subscriberId ?? s?.id ?? null
    };
  });

  // Lower concurrency to avoid throttling and complete all rows
  await pMap(rows, async (r) => {
    if (!r._sid) return;

    // 1) packages
    try {
      const pkg = await fetchPackagesFor(r._sid);
      if (pkg) Object.assign(r, pkg);
    } catch {}

    // 2) template cost
    try {
      if (r.prepaidpackagetemplateid) {
        const tpl = await fetchTemplateCost(r.prepaidpackagetemplateid);
        if (tpl?.cost != null) {
          r.subscriberOneTimeCost = tpl.cost;
        }
        if (tpl?.name && !r.prepaidpackagetemplatename) {
          r.prepaidpackagetemplatename = tpl.name;
        }
      }
    } catch {}

    // fallback to package one-time if template cost missing/0
    if ((r.subscriberOneTimeCost == null || r.subscriberOneTimeCost === 0) && typeof r.packageOneTimeCost === 'number') {
      r.subscriberOneTimeCost = r.packageOneTimeCost;
    }

    // 3) aggregated usage & reseller cost
    try {
      const aggr = await fetchAggregatedUsage(r._sid);
      r.totalBytesSinceJun1   = aggr.sumBytes;
      r.resellerCostSinceJun1 = aggr.sumResCost;
    } catch {}

    delete r._sid;
  }, 3);

  return rows;
}
