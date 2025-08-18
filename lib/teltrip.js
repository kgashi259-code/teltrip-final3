// /lib/teltrip.js
// Subscribers → latest package → template cost → WEEKLY usage (filled)

const BASE = process.env.OCS_BASE_URL;
const TOKEN = process.env.OCS_TOKEN;
const DEFAULT_ACCOUNT_ID = parseInt(process.env.OCS_ACCOUNT_ID || "0", 10);

// ─── Core OCS POST (token via query, matches your setup)
async function callOCS(body) {
  if (!BASE) throw new Error("OCS_BASE_URL missing");
  if (!TOKEN) throw new Error("OCS_TOKEN missing");
  const url = `${BASE}?token=${encodeURIComponent(TOKEN)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(`OCS ${res.status} ${res.statusText}${text ? " :: " + text.slice(0,300) : ""}`);
  return json ?? {};
}

// ─── Small promise pool
async function pMap(list, fn, concurrency = 6) {
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

// ─── Subscribers
async function getSubscribers(accountId) {
  const r = await callOCS({ listSubscriber: { accountId: Number(accountId) } });
  return (
    r?.listSubscriberRsp?.subscriber ||
    r?.listSubscriber?.subscriberList ||
    r?.subscriberList ||
    []
  );
}

// ─── Latest package per subscriber (gives template + data + ts + possible one-time fee on package)
async function getLatestPackage(subscriberId) {
  const r = await callOCS({ listSubscriberPrepaidPackages: { subscriberId: Number(subscriberId) } });
  const pkgs =
    r?.listSubscriberPrepaidPackagesRsp?.packages ||
    r?.listSubscriberPrepaidPackages?.packages ||
    r?.packages || [];
  if (!Array.isArray(pkgs) || !pkgs.length) return null;

  pkgs.sort((a,b)=> new Date(a?.tsactivationutc||0) - new Date(b?.tsactivationutc||0));
  const p = pkgs[pkgs.length - 1];

  const tpl = p?.packageTemplate || p?.template || p || {};
  const tplId =
    Number(tpl.prepaidpackagetemplateid) ||
    Number(tpl.prepaidPackageTemplateId) ||
    Number(tpl.templateId) || null;

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

// ─── Template cost (tries both verbs; robust pick; caches)
const tplCache = new Map();
function pickCostFromTemplate(tpl) {
  if (!tpl || typeof tpl !== "object") return null;
  const oneTime = [], general = [];
  const isPos = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;
  const take = (val, bucket="general") => {
    let num=null;
    if (typeof val==="number"&&Number.isFinite(val)) num=val;
    else if (typeof val==="string"){ const n=Number(val.replace(/[^0-9.]/g,"")); if (Number.isFinite(n)) num=n; }
    else if (val&&typeof val==="object"){ const n=Number(val.value??val.amount??val.cost??val.price); if (Number.isFinite(n)) num=n; }
    if (num==null) return; (bucket==="one"?oneTime:general).push(num);
  };
  const walk = (o, d=0) => {
    if (!o || d>6) return;
    if (Array.isArray(o)) { for (const it of o){ if (it&&typeof it==="object"){ const t=String(it.type||it.kind||it.chargeType||it.category||"").toLowerCase(); const one=/(one[_-]?time|onetime|activation|setup|fee)/.test(t); if (it.price&&typeof it.price==="object") take(it.price, one?"one":"general"); take(it.oneTime??it.amount??it.cost??it.price??it.value, one?"one":"general"); } walk(it,d+1);} return; }
    for (const [k,v] of Object.entries(o)){ const lk=k.toLowerCase();
      if (lk==="price"||lk==="prices"||lk==="pricing"||lk==="pricelist"||lk==="charges"){ take(v,"general"); continue; }
      if (/^(activationfee|setupfee)$/.test(lk)){ take(v,"one"); continue; }
      if (/(cost|price|amount|one[_-]?time|onetime|activation|setup|subscriber(cost)?|fee|value)/i.test(k)){ const one=/(one[_-]?time|onetime|activation|setup|fee)/i.test(k); take(v, one?"one":"general"); }
      else if (v&&typeof v==="object") walk(v,d+1);
    }
  };
  walk(tpl);
  const onePos=oneTime.filter(isPos).sort((a,b)=>a-b); if (onePos.length) return onePos[0];
  const genPos=general.filter(isPos).sort((a,b)=>a-b); if (genPos.length) return genPos[0];
  if (oneTime.includes(0)) return 0; if (general.includes(0)) return 0; return null;
}
async function getTemplateCost(templateId) {
  const id = Number(templateId); if (!id) return null;
  if (tplCache.has(id)) return tplCache.get(id);
  let tpl=null;
  try { const r1=await callOCS({ listPrepaidPackageTemplate:{ templateId:id } });
        tpl=r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate?.[0]
         || r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate || null; } catch {}
  if (!tpl){ try { const r2=await callOCS({ getPrepaidPackageTemplate:{ prepaidPackageTemplateId:id } });
        tpl=r2?.prepaidPackageTemplate || r2?.template || r2?.prepaidPackageTemplates?.[0] || null; } catch {} }
  const cost = (tpl && (pickCostFromTemplate(tpl) ?? tpl.cost ?? tpl.price ?? tpl.amount ?? tpl.oneTimePrice ?? tpl.subscriberCost ?? tpl?.price?.value)) ?? null;
  const val = Number.isFinite(Number(cost)) ? Number(cost) : null;
  tplCache.set(id, val);
  return val;
}

// ─── Weekly usage
const RANGE_START_YMD = "2025-06-01";
const toYMD = (d) => d.toISOString().slice(0,10);
function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function parseYMD(s){ const [y,m,d]=s.split("-").map(Number); return new Date(Date.UTC(y,m-1,d)); }
function* weekWindows(startYMD, endYMD){
  let s=parseYMD(startYMD); const end=parseYMD(endYMD);
  while (s<=end){ const e=addDays(s,6); const ec=e>end?end:e; yield {start:toYMD(s), end:toYMD(ec)}; s=addDays(ec,1); }
}
async function getUsageWindow(subscriberId, startYMD, endYMD) {
  // try common shapes
  const payloadA = { subscriberUsageOverPeriod: { subscriber:{ subscriberId:Number(subscriberId) }, period:{ start:startYMD, end:endYMD } } };
  const payloadB = { subscriberUsageOverPeriod: { subscriber:{ subscriberId:Number(subscriberId) }, period:{ startDate:startYMD, endDate:endYMD } } };
  let r = await callOCS(payloadA);
  if (!r?.subscriberUsageOverPeriod && !r?.subscriberUsageOverPeriodRsp) {
    r = await callOCS(payloadB); // fallback naming
  }
  const total = r?.subscriberUsageOverPeriod?.total || r?.subscriberUsageOverPeriodRsp?.total || {};
  const qty = total?.quantityPerType || {};
  const bytes = typeof qty["33"] === "number" ? qty["33"] : null; // data
  return { start:startYMD, end:endYMD, bytes: Number.isFinite(bytes) ? bytes : 0 };
}
async function getWeeklyUsage(subscriberId) {
  const today = toYMD(new Date());
  const wins = Array.from(weekWindows(RANGE_START_YMD, today));
  const items = await pMap(wins, (w)=>getUsageWindow(subscriberId, w.start, w.end), 5);
  const total = items.reduce((s,it)=>s + (Number.isFinite(it.bytes)?it.bytes:0), 0);
  return { items, total };
}

// ─── PUBLIC: used by /app/api/fetch-data/route.js
export async function fetchAllData(accountIdParam) {
  const accountId = Number(accountIdParam || DEFAULT_ACCOUNT_ID || 0);
  if (!accountId) throw new Error("Provide accountId (env OCS_ACCOUNT_ID or ?accountId=)");

  const subs = await getSubscribers(accountId);

  const rows = subs.map((s) => {
    const iccid = s?.imsiList?.[0]?.iccid ?? s?.sim?.iccid ?? s?.iccid ?? null;
    const imsi  = s?.imsiList?.[0]?.imsi  ?? s?.imsi ?? null;
    const phone = s?.phoneNumberList?.[0]?.phoneNumber ?? s?.phoneNumber ?? null;

    const stArr = Array.isArray(s?.status) ? s.status : [];
    const lastStatus = stArr.length ? stArr[stArr.length - 1] : null;

    const subTplName = s?.prepaidpackagetemplatename ?? s?.prepaidPackageTemplateName ?? null;
    const subTplId =
      Number(s?.prepaidpackagetemplateid) ||
      Number(s?.prepaidPackageTemplateId) ||
      Number(s?.templateId) || null;

    return {
      iccid,
      imsi,
      phoneNumber: phone,
      subscriberStatus: lastStatus?.status ?? s?.subscriberStatus ?? null,
      simStatus: s?.sim?.status ?? s?.simStatus ?? null,
      esim: s?.sim?.esim ?? s?.esim ?? null,
      activationCode: s?.sim?.activationCode ?? s?.activationCode ?? null,

      activationDate: s?.activationDate ?? null,
      lastUsageDate: s?.lastUsageDate ?? null,

      prepaid: s?.prepaid ?? null,
      balance: s?.balance ?? null,
      account: s?.account ?? null,
      reseller: s?.reseller ?? null,
      lastMcc: s?.lastMcc ?? null,
      lastMnc: s?.lastMnc ?? null,

      prepaidpackagetemplatename: subTplName ?? null,
      prepaidpackagetemplateid: Number.isFinite(subTplId) ? subTplId : null,

      tsactivationutc: null,
      tsexpirationutc: null,
      pckdatabyte: null,
      useddatabyte: null,

      // NEW: array of weekly usage
      usageWeekly: [],                 // [{start,end,bytes}]
      subscriberUsageOverPeriod: null, // total bytes since RANGE_START_YMD
      subscriberOneTimeCost: null,

      _sid: s?.subscriberId ?? s?.id ?? null,
    };
  });

  for (const r of rows) {
    if (!r._sid) continue;

    // 1) latest package
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
        r._packageOneTimeCost = pkg.packageOneTimeCost ?? null;
      }
    } catch {}

    // 2) template cost
    try {
      if (r.prepaidpackagetemplateid != null) {
        const cost = await getTemplateCost(r.prepaidpackagetemplateid);
        if (cost != null && cost > 0) r.subscriberOneTimeCost = cost;
      }
    } catch {}
    if ((r.subscriberOneTimeCost == null || r.subscriberOneTimeCost === 0) && r._packageOneTimeCost != null) {
      r.subscriberOneTimeCost = r._packageOneTimeCost;
    }

    // 3) WEEKLY usage + total
    try {
      const { items, total } = await getWeeklyUsage(r._sid);
      r.usageWeekly = items;                 // array for your weekly view
      r.subscriberUsageOverPeriod = total;   // total bytes since 2025-06-01
      // If your UI wants lastUsageDate when subscriber didn’t have it:
      if (!r.lastUsageDate && items.length) r.lastUsageDate = items[items.length - 1].end;
    } catch {}

    delete r._sid;
    delete r._packageOneTimeCost;
  }

  return rows;
}
