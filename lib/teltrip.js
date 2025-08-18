// /lib/teltrip.js
// Subscribers → latest package → template cost → usage total (subscriberUsageOverPeriod)

const BASE = process.env.OCS_BASE_URL;
const TOKEN = process.env.OCS_TOKEN;
const DEFAULT_ACCOUNT_ID = parseInt(process.env.OCS_ACCOUNT_ID || "0", 10);

// ---------- core fetch ----------
async function callOCS(body) {
  if (!BASE) throw new Error("OCS_BASE_URL missing");
  if (!TOKEN) throw new Error("OCS_TOKEN missing");
  const res = await fetch(`${BASE}?token=${encodeURIComponent(TOKEN)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    cache: "no-store", body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(`OCS ${res.status} ${res.statusText}${text ? " :: " + text.slice(0,300) : ""}`);
  return json ?? {};
}

// ---------- utils ----------
async function pMap(list, fn, concurrency = 6) {
  if (!Array.isArray(list) || !list.length) return [];
  const out = new Array(list.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (i < list.length) { const idx = i++; out[idx] = await fn(list[idx], idx); }
  }));
  return out;
}
const toYMD = (d) => d.toISOString().slice(0, 10);
function addDays(base, n) { const d = new Date(base); d.setDate(d.getDate() + n); return d; }
function parseYMD(s) { const [y,m,d]=s.split("-").map(Number); return new Date(Date.UTC(y, m-1, d)); }
function* weekWindows(startYMD, endYMD){
  let s = parseYMD(startYMD); const end = parseYMD(endYMD);
  while (s <= end) { const e = addDays(s, 6); const ec = e > end ? end : e; yield { start: toYMD(s), end: toYMD(ec) }; s = addDays(ec, 1); }
}

// ---------- subscribers ----------
async function getSubscribers(accountId) {
  const r = await callOCS({ listSubscriber: { accountId: Number(accountId) } });
  return r?.listSubscriberRsp?.subscriber || r?.listSubscriber?.subscriberList || r?.subscriberList || [];
}

// ---------- latest package ----------
async function getLatestPackage(subscriberId) {
  const r = await callOCS({ listSubscriberPrepaidPackages: { subscriberId: Number(subscriberId) } });
  const pkgs = r?.listSubscriberPrepaidPackagesRsp?.packages || r?.listSubscriberPrepaidPackages?.packages || r?.packages || [];
  if (!Array.isArray(pkgs) || !pkgs.length) return null;
  pkgs.sort((a,b)=> new Date(a?.tsactivationutc || 0) - new Date(b?.tsactivationutc || 0));
  const p = pkgs[pkgs.length - 1];
  const tpl = p?.packageTemplate || p?.template || p || {};
  const tplId = Number(tpl.prepaidpackagetemplateid) || Number(tpl.prepaidPackageTemplateId) || Number(tpl.templateId) || null;

  const pkgOneTime =
    (typeof p?.cost === "number" ? p.cost : null) ??
    (typeof p?.oneTimePrice === "number" ? p.oneTimePrice : null) ??
    (typeof p?.activationFee === "number" ? p.activationFee : null) ??
    (typeof p?.price?.value === "number" ? p.price.value : null) ?? null;

  return {
    prepaidpackagetemplatename: tpl.prepaidpackagetemplatename || tpl.name || tpl.templateName || null,
    prepaidpackagetemplateid: Number.isFinite(tplId) ? tplId : null,
    tsactivationutc: p?.tsactivationutc || null,
    tsexpirationutc: p?.tsexpirationutc || null,
    pckdatabyte: p?.pckdatabyte ?? p?.packageDataByte ?? null,
    useddatabyte: p?.useddatabyte ?? p?.usedDataByte ?? null,
    packageOneTimeCost: pkgOneTime,
  };
}

// ---------- template cost (tries both verbs; robust pick; cache) ----------
const tplCache = new Map();
function pickCostFromTemplate(tpl) {
  if (!tpl || typeof tpl !== "object") return null;
  const nums = [];
  const push = (v) => {
    let n = null;
    if (typeof v === "number" && Number.isFinite(v)) n = v;
    else if (typeof v === "string") { const x = Number(v.replace(/[^0-9.]/g, "")); if (Number.isFinite(x)) n = x; }
    else if (v && typeof v === "object") { const x = Number(v.value ?? v.amount ?? v.cost ?? v.price); if (Number.isFinite(x)) n = x; }
    if (n != null) nums.push(n);
  };
  const walk = (o, d=0) => {
    if (!o || d>5) return;
    if (Array.isArray(o)) { for (const it of o) walk(it, d+1); return; }
    for (const [k,v] of Object.entries(o)) {
      if (/(one[_-]?time|activation|setup|fee|cost|price|amount|value)/i.test(k)) push(v);
      else if (v && typeof v === "object") walk(v, d+1);
    }
  };
  walk(tpl);
  const pos = nums.filter(n=>n>0).sort((a,b)=>a-b);
  return pos[0] ?? nums[0] ?? null;
}
async function getTemplateCost(templateId) {
  const id = Number(templateId); if (!id) return null;
  if (tplCache.has(id)) return tplCache.get(id);
  let tpl = null;
  try {
    const r1 = await callOCS({ listPrepaidPackageTemplate: { templateId: id } });
    tpl = r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate?.[0] || r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate || null;
  } catch {}
  if (!tpl) {
    try {
      const r2 = await callOCS({ getPrepaidPackageTemplate: { prepaidPackageTemplateId: id } });
      tpl = r2?.prepaidPackageTemplate || r2?.template || r2?.prepaidPackageTemplates?.[0] || null;
    } catch {}
  }
  const cost = (tpl && (pickCostFromTemplate(tpl) ?? tpl.cost ?? tpl.price ?? tpl.amount ?? tpl.oneTimePrice ?? tpl.subscriberCost ?? tpl?.price?.value)) ?? null;
  const val = Number.isFinite(Number(cost)) ? Number(cost) : null;
  tplCache.set(id, val); return val;
}

// ---------- usage over period (sum of weekly windows) ----------
async function fetchUsageWindow(subscriberId, startYMD, endYMD) {
  // API: input { subscriberUsageOverPeriod: { subscriber:{subscriberId}, period:{start,end} } }
  // Output: ... total.quantityPerType["33"] holds DATA bytes. :contentReference[oaicite:2]{index=2} :contentReference[oaicite:3]{index=3}
  let r = await callOCS({ subscriberUsageOverPeriod: { subscriber: { subscriberId: Number(subscriberId) }, period: { start: startYMD, end: endYMD } } });
  const total = r?.subscriberUsageOverPeriod?.total || r?.subscriberUsageOverPeriodRsp?.total || {};
  const qpt = total?.quantityPerType || {};
  const raw = qpt?.["33"]; // data usage type 33. :contentReference[oaicite:4]{index=4}
  const bytes = Number.isFinite(raw) ? raw : Number(raw);
  return Number.isFinite(bytes) ? bytes : 0;
}

async function getUsageTotal(subscriberId, pkg) {
  // Period: from package activation (if known) or last 28 days, chunked in ≤1-week windows (API constraint). :contentReference[oaicite:5]{index=5}
  const end = new Date();
  const start = pkg?.tsactivationutc ? new Date(pkg.tsactivationutc) : addDays(end, -27);
  const wins = Array.from(weekWindows(toYMD(start), toYMD(end)));
  let total = 0;
  for (const w of wins) total += await fetchUsageWindow(subscriberId, w.start, w.end);
  return total;
}

// ---------- main ----------
export async function fetchAllData(accountIdParam) {
  const accountId = Number(accountIdParam || DEFAULT_ACCOUNT_ID || 0);
  if (!accountId) throw new Error("Provide accountId (env OCS_ACCOUNT_ID or ?accountId=)");

  const subs = await getSubscribers(accountId);

  const rows = subs.map((s) => {
    const iccid = s?.imsiList?.[0]?.iccid ?? s?.sim?.iccid ?? s?.iccid ?? null;
    const imsi  = s?.imsiList?.[0]?.imsi  ?? s?.imsi ?? null;
    const phone = s?.phoneNumberList?.[0]?.phoneNumber ?? s?.phoneNumber ?? null;

    const tplName = s?.prepaidpackagetemplatename ?? s?.prepaidPackageTemplateName ?? null;
    const tplId =
      Number(s?.prepaidpackagetemplateid) ||
      Number(s?.prepaidPackageTemplateId) ||
      Number(s?.templateId) || null;

    return {
      iccid,
      imsi,
      phoneNumber: phone,
      activationDate: s?.activationDate ?? null,
      lastUsageDate: s?.lastUsageDate ?? null,
      subscriberStatus: s?.subscriberStatus ?? null,
      simStatus: s?.sim?.status ?? s?.simStatus ?? null,
      esim: s?.sim?.esim ?? s?.esim ?? null,
      activationCode: s?.sim?.activationCode ?? s?.activationCode ?? null,
      prepaid: s?.prepaid ?? null,
      balance: s?.balance ?? null,
      account: s?.account ?? null,
      reseller: s?.reseller ?? null,
      lastMcc: s?.lastMcc ?? null,
      lastMnc: s?.lastMnc ?? null,

      prepaidpackagetemplatename: tplName ?? null,
      prepaidpackagetemplateid: Number.isFinite(tplId) ? tplId : null,

      tsactivationutc: null,
      tsexpirationutc: null,
      pckdatabyte: null,
      useddatabyte: null,

      subscriberUsageOverPeriod: null,
      subscriberOneTimeCost: null,

      _sid: s?.subscriberId ?? s?.id ?? null,
    };
  });

  for (const r of rows) {
    if (!r._sid) continue;

    // latest package
    let pkg = null;
    try {
      pkg = await getLatestPackage(r._sid);
      if (pkg) {
        if (r.prepaidpackagetemplatename == null) r.prepaidpackagetemplatename = pkg.prepaidpackagetemplatename;
        if (r.prepaidpackagetemplateid == null)   r.prepaidpackagetemplateid   = pkg.prepaidpackagetemplateid;
        r.tsactivationutc = pkg.tsactivationutc;
        r.tsexpirationutc = pkg.tsexpirationutc;
        r.pckdatabyte     = pkg.pckdatabyte;
        r.useddatabyte    = pkg.useddatabyte;
        r._pkgOneTime     = pkg.packageOneTimeCost ?? null;
      }
    } catch {}

    // template cost
    try {
      if (r.prepaidpackagetemplateid != null) {
        const cost = await getTemplateCost(r.prepaidpackagetemplateid);
        if (cost != null && cost > 0) r.subscriberOneTimeCost = cost;
      }
    } catch {}
    if ((r.subscriberOneTimeCost == null || r.subscriberOneTimeCost === 0) && r._pkgOneTime != null) {
      r.subscriberOneTimeCost = r._pkgOneTime;
    }

    // usage total (bytes)
    try {
      const total = await getUsageTotal(r._sid, { tsactivationutc: r.tsactivationutc });
      r.subscriberUsageOverPeriod = Number.isFinite(total) ? total : null;
      // fallback: if still null/0 and we have current package usage, show that
      if ((r.subscriberUsageOverPeriod == null || r.subscriberUsageOverPeriod === 0) && Number.isFinite(r.useddatabyte))
        r.subscriberUsageOverPeriod = r.useddatabyte;
    } catch {
      if (Number.isFinite(r.useddatabyte)) r.subscriberUsageOverPeriod = r.useddatabyte;
    }

    delete r._sid; delete r._pkgOneTime;
  }

  return rows;
}
