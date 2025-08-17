// /lib/teltrip.js
// Minimal/stable data layer: subscribers → latest package → template cost (+ package fallback)

const BASE = process.env.OCS_BASE_URL;     // e.g. https://ocs-api.esimvault.cloud/v1
const TOKEN = process.env.OCS_TOKEN;       // bearer/token (project already uses token in query)
const DEFAULT_ACCOUNT_ID = parseInt(process.env.OCS_ACCOUNT_ID || "0", 10);

// ─────────────────────────────────────────────────────────────────────────────
// Core OCS POST (token via query, matches your existing setup)
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
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(`OCS ${res.status} ${res.statusText}${text ? " :: " + text.slice(0,300) : ""}`);
  return json ?? {};
}

// Simple promise pool
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

// ─────────────────────────────────────────────────────────────────────────────
// Subscribers
async function getSubscribers(accountId) {
  const r = await callOCS({ listSubscriber: { accountId: Number(accountId) } });
  return (
    r?.listSubscriberRsp?.subscriber ||
    r?.listSubscriber?.subscriberList ||
    r?.subscriberList ||
    []
  );
}

// Latest package per subscriber (gets reliable templateId/name + bytes + ts)
async function getLatestPackage(subscriberId) {
  const r = await callOCS({ listSubscriberPrepaidPackages: { subscriberId: Number(subscriberId) } });
  const pkgs =
    r?.listSubscriberPrepaidPackagesRsp?.packages ||
    r?.listSubscriberPrepaidPackages?.packages ||
    r?.packages || [];
  if (!Array.isArray(pkgs) || !pkgs.length) return null;

  pkgs.sort((a, b) => new Date(a?.tsactivationutc || 0) - new Date(b?.tsactivationutc || 0));
  const p = pkgs[pkgs.length - 1];

  const tpl = p?.packageTemplate || p?.template || p || {};
  const tplId =
    Number(tpl.prepaidpackagetemplateid) ||
    Number(tpl.prepaidPackageTemplateId) ||
    Number(tpl.templateId) || null;

  // One-time price sometimes sits on the package itself
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

// ─────────────────────────────────────────────────────────────────────────────
// Template cost lookup (tries both verbs; robust cost pick; caches)
const tplCache = new Map();

function pickCostFromTemplate(tpl) {
  if (!tpl || typeof tpl !== "object") return null;

  const oneTime = [];
  const general = [];
  const isPos = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

  const take = (val, bucket = "general") => {
    let num = null;
    if (typeof val === "number" && Number.isFinite(val)) num = val;
    else if (typeof val === "string") {
      const n = Number(val.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(n)) num = n;
    } else if (val && typeof val === "object") {
      const n = Number(val.value ?? val.amount ?? val.cost ?? val.price);
      if (Number.isFinite(n)) num = n;
    }
    if (num == null) return;
    (bucket === "one" ? oneTime : general).push(num);
  };

  const walk = (o, depth = 0) => {
    if (!o || depth > 6) return;

    if (Array.isArray(o)) {
      for (const item of o) {
        if (item && typeof item === "object") {
          const t = String(item.type || item.kind || item.chargeType || item.category || "").toLowerCase();
          const isOne = /(one[_-]?time|onetime|activation|setup|fee)/.test(t);
          if (item.price && typeof item.price === "object") take(item.price, isOne ? "one" : "general");
          take(item.oneTime ?? item.amount ?? item.cost ?? item.price ?? item.value, isOne ? "one" : "general");
        }
        walk(item, depth + 1);
      }
      return;
    }

    for (const [k, v] of Object.entries(o)) {
      const lk = k.toLowerCase();
      if (lk === "price" || lk === "prices" || lk === "pricing" || lk === "pricelist" || lk === "charges") {
        take(v, "general");
        continue;
      }
      if (/^(activationfee|setupfee)$/.test(lk)) { take(v, "one"); continue; }
      if (/(cost|price|amount|one[_-]?time|onetime|activation|setup|subscriber(cost)?|fee|value)/i.test(k)) {
        const isOne = /(one[_-]?time|onetime|activation|setup|fee)/i.test(k);
        take(v, isOne ? "one" : "general");
      } else if (v && typeof v === "object") {
        walk(v, depth + 1);
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
  const id = Number(templateId);
  if (!id) return null;
  if (tplCache.has(id)) return tplCache.get(id);

  let tpl = null;

  // A) documented
  try {
    const r1 = await callOCS({ listPrepaidPackageTemplate: { templateId: id } });
    tpl = r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate?.[0]
       || r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate
       || null;
  } catch {}

  // B) fallback
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

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: used by /app/api/fetch-data/route.js
export async function fetchAllData(accountIdParam) {
  const accountId = Number(accountIdParam || DEFAULT_ACCOUNT_ID || 0);
  if (!accountId) throw new Error("Provide accountId (env OCS_ACCOUNT_ID or ?accountId=)");

  const subs = await getSubscribers(accountId);

  // Build initial rows from subscriber object (keep your keys)
  const rows = subs.map((s) => {
    const iccid = s?.imsiList?.[0]?.iccid ?? s?.sim?.iccid ?? s?.iccid ?? null;
    const subTplName = s?.prepaidpackagetemplatename ?? s?.prepaidPackageTemplateName ?? null;
    const subTplId =
      Number(s?.prepaidpackagetemplateid) ||
      Number(s?.prepaidPackageTemplateId) ||
      Number(s?.templateId) || null;

    return {
      iccid,
      lastUsageDate: s?.lastUsageDate ?? null,
      prepaidpackagetemplatename: subTplName ?? null,
      activationDate: s?.activationDate ?? null,
      tsactivationutc: null,
      tsexpirationutc: null,
      prepaidpackagetemplateid: Number.isFinite(subTplId) ? subTplId : null,
      pckdatabyte: null,
      useddatabyte: null,
      subscriberUsageOverPeriod: null, // unchanged
      subscriberOneTimeCost: null,
      _sid: s?.subscriberId ?? s?.id ?? null,
    };
  });

  // Enrich per subscriber
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
      }
    } catch { /* keep row even if package fails */ }

    // 2) template cost (primary)
    try {
      if (r.prepaidpackagetemplateid != null) {
        const cost = await getTemplateCost(r.prepaidpackagetemplateid);
        if (cost != null && cost > 0) r.subscriberOneTimeCost = cost;
      }
    } catch { /* ignore */ }

    // 3) fallback: package one-time cost if template gave 0/null
    if ((r.subscriberOneTimeCost == null || r.subscriberOneTimeCost === 0) && pkg?.packageOneTimeCost != null) {
      r.subscriberOneTimeCost = pkg.packageOneTimeCost;
    }

    delete r._sid;
  }

  return rows;
}
