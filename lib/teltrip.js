// /lib/teltrip.js
// Minimal, stable data layer: subscriber rows + subscriberOneTimeCost

const BASE = process.env.OCS_BASE_URL;     // e.g. https://ocs-api.esimvault.cloud/v1
const TOKEN = process.env.OCS_TOKEN;       // token string
const DEFAULT_ACCOUNT_ID = parseInt(process.env.OCS_ACCOUNT_ID || "0", 10);

// ─────────────────────────────────────────────────────────────────────────────
// Core OCS call (token via query string – matches your working setup)
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

// ─────────────────────────────────────────────────────────────────────────────
// Fetch all subscribers for an account
async function getSubscribers(accountId) {
  const r = await callOCS({ listSubscriber: { accountId: Number(accountId) } });
  // support both shapes we’ve seen
  return (
    r?.listSubscriberRsp?.subscriber ||
    r?.listSubscriber?.subscriberList ||
    r?.subscriberList ||
    []
  );
}

// Latest package per subscriber → gives us template id/name + data/ts
async function getLatestPackage(subscriberId) {
  const r = await callOCS({ listSubscriberPrepaidPackages: { subscriberId: Number(subscriberId) } });
  const pkgs =
    r?.listSubscriberPrepaidPackagesRsp?.packages ||
    r?.listSubscriberPrepaidPackages?.packages ||
    r?.packages || [];
  if (!Array.isArray(pkgs) || pkgs.length === 0) return null;

  // sort by activation ts, pick latest
  pkgs.sort((a, b) => new Date(a?.tsactivationutc || 0) - new Date(b?.tsactivationutc || 0));
  const p = pkgs[pkgs.length - 1];

  const tpl = p?.packageTemplate || p?.template || p || {};
  const templateId =
    Number(tpl.prepaidpackagetemplateid) ||
    Number(tpl.prepaidPackageTemplateId) ||
    Number(tpl.templateId) || null;

  return {
    prepaidpackagetemplatename:
      tpl.prepaidpackagetemplatename || tpl.name || tpl.templateName || null,
    prepaidpackagetemplateid: Number.isFinite(templateId) ? templateId : null,
    tsactivationutc: p?.tsactivationutc || null,
    tsexpirationutc: p?.tsexpirationutc || null,
    pckdatabyte: p?.pckdatabyte ?? p?.packageDataByte ?? null,
    useddatabyte: p?.useddatabyte ?? p?.usedDataByte ?? null,
  };
}

// Template cost by templateId (tries both API verbs + common fields)
const tplCache = new Map();
async function getTemplateCost(templateId) {
  if (!templateId) return null;
  if (tplCache.has(templateId)) return tplCache.get(templateId);

  let tpl = null;

  // 1) documented list-by-id
  try {
    const r1 = await callOCS({ listPrepaidPackageTemplate: { templateId: Number(templateId) } });
    tpl = r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate?.[0]
       || r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate
       || null;
  } catch {}

  // 2) fallback get-by-id
  if (!tpl) {
    try {
      const r2 = await callOCS({ getPrepaidPackageTemplate: { prepaidPackageTemplateId: Number(templateId) } });
      tpl = r2?.prepaidPackageTemplate || r2?.template || r2?.prepaidPackageTemplates?.[0] || null;
    } catch {}
  }

  // Pick a numeric cost from common keys / nested price holder
  let cost = null;
  if (tpl) {
    const direct =
      tpl.cost ?? tpl.price ?? tpl.amount ?? tpl.oneTimePrice ?? tpl.subscriberCost ?? null;
    if (typeof direct === "number" && Number.isFinite(direct)) {
      cost = direct;
    } else if (typeof direct === "string") {
      const n = Number(direct.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(n)) cost = n;
    } else if (typeof direct === "object" && direct) {
      const n = Number(direct.value ?? direct.amount ?? direct.cost ?? direct.price);
      if (Number.isFinite(n)) cost = n;
    }

    // fallback: shallow nested scan
    if (cost == null) {
      const priceObj = tpl.price || tpl.pricing || tpl.priceList || null;
      if (priceObj && typeof priceObj === "object") {
        const n = Number(priceObj.value ?? priceObj.amount ?? priceObj.cost ?? priceObj.price);
        if (Number.isFinite(n)) cost = n;
      }
    }
  }

  const val = Number.isFinite(Number(cost)) ? Number(cost) : null;
  tplCache.set(templateId, val);
  return val;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: main fetch used by /api/fetch-data
export async function fetchAllData(accountIdParam) {
  const accountId = Number(accountIdParam || DEFAULT_ACCOUNT_ID || 0);
  if (!accountId) throw new Error("Provide accountId (env OCS_ACCOUNT_ID or ?accountId=)");

  const subs = await getSubscribers(accountId);

  // Build initial rows from subscriber object
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
      subscriberUsageOverPeriod: null,      // you can fill later if needed
      subscriberOneTimeCost: null,
      _sid: s?.subscriberId ?? s?.id ?? null,
    };
  });

  // Enrich with latest package + template cost
  for (const r of rows) {
    if (!r._sid) continue;

    // 1) latest package (reliable templateId)
    try {
      const pkg = await getLatestPackage(r._sid);
      if (pkg) {
        if (r.prepaidpackagetemplatename == null) r.prepaidpackagetemplatename = pkg.prepaidpackagetemplatename;
        if (r.prepaidpackagetemplateid == null)   r.prepaidpackagetemplateid   = pkg.prepaidpackagetemplateid;
        r.tsactivationutc = pkg.tsactivationutc;
        r.tsexpirationutc = pkg.tsexpirationutc;
        r.pckdatabyte     = pkg.pckdatabyte;
        r.useddatabyte    = pkg.useddatabyte;
      }
    } catch {
      // keep row, just skip enrichment
    }

    // 2) template cost
    if (r.prepaidpackagetemplateid != null) {
      try {
        const cost = await getTemplateCost(r.prepaidpackagetemplateid);
        if (cost != null) r.subscriberOneTimeCost = cost;
      } catch {
        // ignore cost errors, keep row
      }
    }

    delete r._sid;
  }

  return rows;
}
