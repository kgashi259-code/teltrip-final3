// /lib/teltrip.js
// Subscribers → latest package → template cost (unchanged) → package-period usage total

const BASE = process.env.OCS_BASE_URL;
const TOKEN = process.env.OCS_TOKEN;
const DEFAULT_ACCOUNT_ID = parseInt(process.env.OCS_ACCOUNT_ID || "0", 10);

// ---------- core fetch ----------
async function callOCS(body) {
  if (!BASE) throw new Error("OCS_BASE_URL missing");
  if (!TOKEN) throw new Error("OCS_TOKEN missing");
  const res = await fetch(`${BASE}?token=${encodeURIComponent(TOKEN)}`, {
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

// ---------- small utils ----------
async function pMap(list, fn, concurrency = 6) {
  if (!Array.isArray(list) || !list.length) return [];
  const out = new Array(list.length); let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, list.length) }, async () => {
      while (i < list.length) { const idx = i++; out[idx] = await fn(list[idx], idx); }
    })
  );
  return out;
}
const toYMD = (d) => d.toISOString().slice(0,10);

// ---------- subscribers ----------
async function getSubscribers(accountId) {
  const r = await callOCS({ listSubscriber: { accountId: Number(accountId) } });
  return (
    r?.listSubscriberRsp?.subscriber ||
    r?.listSubscriber?.subscriberList ||
    r?.subscriberList ||
    []
  );
}

// ---------- latest package (gets template + bytes + ts + possible one-time fee on package) ----------
async function getLatestPackage(subscriberId) {
  const r = await callOCS({ listSubscriberPrepaidPackages: { subscriberId: Number(subscriberId) } });
  const pkgs =
    r?.listSubscriberPrepaidPackagesRsp?.packages ||
    r?.listSubscriberPrepaidPackages?.packages ||
    r?.packages || [];
  if (!Array.isArray(pkgs) || !pkgs.length) return null;

  pkgs.sort((a,b)=> new Date(a?.tsactivationutc || 0) - new Date(b?.tsactivationutc || 0));
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

// ---------- template cost (UNCHANGED logic; tries both verbs; robust pick; caches) ----------
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
    if (Array.isArray(o)) {
      for (const it of o) {
        if (it && typeof it === "object") {
          const t = String(it.type || it.kind || it.chargeType || it.category || "").toLowerCase();
          const one = /(one[_-]?time|onetime|activation|setup|fee)/.test(t);
          if (it.price && typeof it.price === "object") take(it.price, one ? "one" : "general");
          take(it.oneTime ?? it.amount ?? it.cost ?? it.price ?? it.value, one ? "one" : "general");
        }
        walk(it, d+1);
      }
      return;
    }
    for (const [k,v] of Object.entries(o)){
      const lk = k.toLowerCase();
      if (lk==="price"||lk==="prices"||lk==="pricing"||lk==="pricelist"||lk==="charges"){ take(v,"general"); continue; }
      if (/^(activationfee|setupfee)$/.test(lk)){ take(v,"one"); continue; }
      if (/(cost|price|amount|one[_-]?time|onetime|activation|setup|subscriber(cost)?|fee|value)/i.test(k)){
        const one = /(one[_-]?time|onetime|activation|setup|fee)/i.test(k);
        take(v, one ? "one" : "general");
      } else if (v && typeof v === "object") {
        walk(v, d+1);
      }
    }
  };
  walk(tpl);
  const onePos = oneTime.filter(isPos).sort((a,b)=>a-b);
  if (onePos.length) return onePos[0];
  const genPos = general.filter(isPos).sort((a,b)=>a-b);
  if (genPos.length) return genPos[0];
  if (oneTime.includes(0)) return 0;
  if (general.includes(0)) return 0;
  return null;
}
async function getTemplateCost(templateId) {
  const id = Number(templateId); if (!id) return null;
  if (tplCache.has(id)) return tplCache.get(id);
  let tpl = null;
  try {
    const r1 = await callOCS({ listPrepaidPackageTemplate: { templateId: id } });
    tpl = r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate?.[0]
      || r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate || null;
  } catch {}
  if (!tpl) {
    try {
      const r2 = await callOCS({ getPrepaidPackageTemplate: { prepaidPackageTemplateId: id } });
      tpl = r2?.prepaidPackageTemplate || r2?.template || r2?.prepaidPackageTemplates?.[0] || null;
    } catch {}
  }
  const cost =
    (tpl && (
      pickCostFromTemplate(tpl) ??
      tpl.cost ?? tpl.price ?? tpl.amount ?? tpl.oneTimePrice ?? tpl.subscriberCost ??
      tpl?.price?.value
    )) ?? null;
  const val = Number.isFinite(Number(cost)) ? Number(cost) : null;
  tplCache.set(id, val);
  return val;
}

// ---------- usage for a package period ----------
async function getPackageUsageTotal(subscriberId, startUtc, endUtc) {
  // Build YMDs from package timestamps
  const startYmd = startUtc ? toYMD(new Date(startUtc)) : toYMD(new Date());
  const endYmd   = endUtc   ? toYMD(new Date(endUtc))   : toYMD(new Date());

  // API: total.quantityPerType["33"] = data bytes
  const r = await callOCS({
    subscriberUsageOverPeriod: {
      subscriber: { subscriberId: Number(subscriberId) },
      period: { start: startYmd, end: endYmd }
    }
  });

  const total =
    r?.subscriberUsageOverPeriod?.total ||
    r?.subscriberUsageOverPeriodRsp?.total || {};

  const qpt = total?.quantityPerType || {};
  const raw = qpt["33"];
  const bytes = Number.isFinite(raw) ? raw : Number(raw);

  return Number.isFinite(bytes) ? bytes : 0;
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

    const subTplName = s?.prepaidpackagetemplatename ?? s?.prepaidPackageTemplateName ?? null;
    const subTplId =
      Number(s?.prepaidpackagetemplateid) ||
      Number(s?.prepaidPackageTemplateId) ||
      Number(s?.templateId) || null;

    return {
      iccid,
      imsi,
      phoneNumber: phone,
      subscriberStatus: s?.subscriberStatus ?? null,
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

      subscriberUsageOverPeriod: null, // <-- we fix this
      subscriberOneTimeCost: null,     // cost logic unchanged, see below

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
        r._pkgOneTime     = pkg.packageOneTimeCost ?? null;
      }
    } catch {}

    // 2) cost (unchanged)
    try {
      if (r.prepaidpackagetemplateid != null) {
        const cost = await getTemplateCost(r.prepaidpackagetemplateid);
        if (cost != null && cost > 0) r.subscriberOneTimeCost = cost;
      }
    } catch {}
    if ((r.subscriberOneTimeCost == null || r.subscriberOneTimeCost === 0) && r._pkgOneTime != null) {
      r.subscriberOneTimeCost = r._pkgOneTime;
    }

    // 3) usage total for the package period
    try {
      const total = await getPackageUsageTotal(
        r._sid,
        r.tsactivationutc,                         // start = package activation
        r.tsexpirationutc || new Date().toISOString() // end = package expiry or today
      );
      r.subscriberUsageOverPeriod = Number.isFinite(total) ? total : null;

      // fallback: if API returns nothing, use package used bytes
      if ((r.subscriberUsageOverPeriod == null || r.subscriberUsageOverPeriod === 0) &&
          Number.isFinite(r.useddatabyte)) {
        r.subscriberUsageOverPeriod = r.useddatabyte;
      }
    } catch {
      if (Number.isFinite(r.useddatabyte)) r.subscriberUsageOverPeriod = r.useddatabyte;
    }

    delete r._sid;
    delete r._pkgOneTime;
  }

  return rows;
}
