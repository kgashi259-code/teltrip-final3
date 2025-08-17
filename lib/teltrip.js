// lib/teltrip.js
// Teltrip data layer for dashboard (cost fix + robust parsing + light debug)

const BASE = process.env.OCS_BASE_URL;
const TOKEN = process.env.OCS_TOKEN;
const DEFAULT_ACCOUNT_ID = parseInt(process.env.OCS_ACCOUNT_ID || "0", 10);
const DEBUG = process.env.TELTRIP_DEBUG === "1";

function must(v, name) { if (!v) throw new Error(`${name} missing`); return v; }
function logOnce(key, ...args) {
  if (!DEBUG) return;
  const mark = `__ONCE_${key}`;
  if (logOnce[mark]) return;
  logOnce[mark] = true;
  // Logs show in /api/fetch-data function logs
  console.log(...args);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core OCS caller (token via query, as in your project)
async function callOCS(payload) {
  must(BASE, "OCS_BASE_URL"); must(TOKEN, "OCS_TOKEN");
  const url = `${BASE}?token=${encodeURIComponent(TOKEN)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store"
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}${text ? " :: " + text.slice(0,300) : ""}`);
  return json ?? {};
}

// Small promise pool
async function pMap(arr, fn, concurrency = 6) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const out = new Array(arr.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, arr.length) }, async () => {
      while (i < arr.length) {
        const idx = i++;
        out[idx] = await fn(arr[idx], idx);
      }
    })
  );
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
function normalizeTemplateId(raw) {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function pickCostFromTemplate(tpl) {
  if (!tpl || typeof tpl !== "object") return null;

  // Quick direct keys
  const directKeys = ["cost", "price", "amount", "oneTimePrice", "subscriberCost", "fee", "value"];
  for (const k of directKeys) {
    if (tpl[k] != null) {
      const v = tpl[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const n = Number(v.replace(/[^0-9.]/g, ""));
        if (Number.isFinite(n)) return n;
      }
      if (typeof v === "object" && v) {
        // e.g. price: { value: 5 }
        const n = Number(v.value ?? v.amount ?? v.cost ?? v.price);
        if (Number.isFinite(n)) return n;
      }
    }
  }

  // Deep scan including arrays; prefer ONE_TIME/activation items if present
  const hits = [];
  const keyRe = /(cost|price|amount|one[_-]?time|subscriber(cost)?|fee|value)/i;

  function take(val) {
    if (val == null) return;
    if (typeof val === "number" && Number.isFinite(val)) hits.push(val);
    else if (typeof val === "string") {
      const n = Number(val.replace(/[^0-9.]/g, ""));
      if (Number.isFinite(n)) hits.push(n);
    } else if (typeof val === "object") {
      // nested price holder
      const n = Number(val.value ?? val.amount ?? val.cost ?? val.price);
      if (Number.isFinite(n)) hits.push(n);
    }
  }

  function walk(o, depth = 0) {
    if (o == null || depth > 6) return;

    if (Array.isArray(o)) {
      for (const item of o) {
        if (item && typeof item === "object") {
          const t = String(item.type || item.kind || item.chargeType || item.category || "").toLowerCase();
          if (/(one[_-]?time|onetime|activation|setup)/.test(t)) {
            // Common nested: { type:'ONE_TIME', price:{ value:5, currency:'EUR' } }
            if (item.price && typeof item.price === "object") {
              take(item.price.value ?? item.price.amount ?? item.price.cost ?? item.price);
            }
            take(item.oneTime ?? item.amount ?? item.cost ?? item.price ?? item.value);
          }
        }
        walk(item, depth + 1);
      }
      return;
    }

    if (typeof o === "object") {
      for (const [k, v] of Object.entries(o)) {
        if (v == null) continue;

        if (keyRe.test(k)) {
          take(v);
          continue;
        }
        if (k === "price" || k === "prices" || k === "pricing" || k === "priceList") {
          take(v);
          continue;
        }
        if (typeof v === "object") walk(v, depth + 1);
      }
    }
  }

  walk(tpl);

  if (hits.length) {
    const nonNeg = hits.filter((n) => n >= 0);
    if (nonNeg.length) return nonNeg.sort((a, b) => a - b)[0]; // smallest non-negative as one-time fee
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Template cost lookup (tries both API verbs; caches result)
const tplCache = new Map(); // id -> { cost, name, currency, raw }

async function fetchTemplateCost(templateId) {
  const id = normalizeTemplateId(templateId);
  if (!id) return null;
  if (tplCache.has(id)) return tplCache.get(id);

  let tpl = null;

  // 1) Documented: listPrepaidPackageTemplate { templateId }
  try {
    const r1 = await callOCS({ listPrepaidPackageTemplate: { templateId: id } });
    tpl = r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate?.[0]
       ?? r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate
       ?? null;
    if (tpl) logOnce(`tpl_ok_list_${id}`, "[TPL] listPrepaidPackageTemplate OK", id);
  } catch (e) {
    logOnce(`tpl_err_list_${id}`, "[TPL] listPrepaidPackageTemplate failed", id, e?.message);
  }

  // 2) Fallback: getPrepaidPackageTemplate { prepaidPackageTemplateId }
  if (!tpl) {
    try {
      const r2 = await callOCS({ getPrepaidPackageTemplate: { prepaidPackageTemplateId: id } });
      tpl = r2?.prepaidPackageTemplate ?? r2?.template ?? r2?.prepaidPackageTemplates?.[0] ?? null;
      if (tpl) logOnce(`tpl_ok_get_${id}`, "[TPL] getPrepaidPackageTemplate OK", id);
    } catch (e) {
      logOnce(`tpl_err_get_${id}`, "[TPL] getPrepaidPackageTemplate failed", id, e?.message);
    }
  }

  if (tpl && DEBUG) {
    try { logOnce(`tpl_dump_${id}`, "[TPL] dump", id, JSON.stringify(tpl).slice(0, 800)); } catch {}
  }

  const cost = pickCostFromTemplate(tpl);
  const val = {
    cost: Number.isFinite(cost) ? cost : null,
    name: tpl?.prepaidpackagetemplatename ?? tpl?.name ?? tpl?.templateName ?? null,
    currency: tpl?.currency ?? tpl?.curr ?? null,
    raw: tpl || null
  };
  tplCache.set(id, val);
  return val;
}

// ─────────────────────────────────────────────────────────────────────────────
// Packages for a subscriber → pick the latest to get template info
async function fetchLatestPackage(subscriberId) {
  const resp = await callOCS({ listSubscriberPrepaidPackages: { subscriberId } });
  const pkgs =
    resp?.listSubscriberPrepaidPackagesRsp?.packages ??
    resp?.listSubscriberPrepaidPackages?.packages ??
    resp?.packages ?? [];
  if (!Array.isArray(pkgs) || !pkgs.length) return null;

  pkgs.sort((a,b)=> new Date(a.tsactivationutc||0) - new Date(b.tsactivationutc||0));
  const p = pkgs.at(-1);

  const tpl = p?.packageTemplate ?? p?.template ?? p ?? {};
  const templateId =
    normalizeTemplateId(tpl.prepaidpackagetemplateid) ??
    normalizeTemplateId(tpl.prepaidPackageTemplateId) ??
    normalizeTemplateId(tpl.templateId) ?? null;

  return {
    prepaidpackagetemplatename: tpl.prepaidpackagetemplatename ?? tpl.name ?? tpl.templateName ?? null,
    prepaidpackagetemplateid: templateId,
    tsactivationutc: p?.tsactivationutc ?? null,
    tsexpirationutc: p?.tsexpirationutc ?? null,
    pckdatabyte: p?.pckdatabyte ?? p?.packageDataByte ?? null,
    useddatabyte: p?.useddatabyte ?? p?.usedDataByte ?? null
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN: fetchAllData(accountId) → rows consumed by /api/fetch-data
export async function fetchAllData(accountIdParam) {
  const accountId = parseInt(accountIdParam || DEFAULT_ACCOUNT_ID || "0", 10);
  if (!accountId) throw new Error("Provide accountId (env OCS_ACCOUNT_ID or ?accountId=)");

  // listSubscriber
  const subsResp = await callOCS({ listSubscriber: { accountId } });
  const subscribers =
    subsResp?.listSubscriberRsp?.subscriber ??
    subsResp?.listSubscriber?.subscriberList ??
    subsResp?.subscriberList ?? [];

  const rows = subscribers.map((s) => {
    const iccid = s?.imsiList?.[0]?.iccid ?? s?.sim?.iccid ?? s?.iccid ?? null;
    const imsi  = s?.imsiList?.[0]?.imsi  ?? s?.imsi ?? null;

    // try to read template hints already present on subscriber
    const subTplName = s?.prepaidpackagetemplatename ?? s?.prepaidPackageTemplateName ?? null;
    const subTplId   = normalizeTemplateId(
      s?.prepaidpackagetemplateid ?? s?.prepaidPackageTemplateId ?? s?.templateId
    );

    return {
      iccid,
      imsi,
      activationDate: s?.activationDate ?? null,
      lastUsageDate: s?.lastUsageDate ?? null,

      prepaidpackagetemplatename: subTplName ?? null,
      prepaidpackagetemplateid: subTplId ?? null,

      tsactivationutc: null,
      tsexpirationutc: null,
      pckdatabyte: null,
      useddatabyte: null,

      subscriberOneTimeCost: null,

      _sid: s?.subscriberId ?? s?.id ?? null
    };
  });

  // Enrich per subscriber
  await pMap(rows, async (r) => {
    if (!r._sid) return;

    // 1) ensure we have a template id/name from latest package
    try {
      const pkg = await fetchLatestPackage(r._sid);
      if (pkg) {
        if (r.prepaidpackagetemplatename == null) r.prepaidpackagetemplatename = pkg.prepaidpackagetemplatename;
        if (r.prepaidpackagetemplateid == null)   r.prepaidpackagetemplateid   = pkg.prepaidpackagetemplateid;
        r.tsactivationutc = pkg.tsactivationutc;
        r.tsexpirationutc = pkg.tsexpirationutc;
        r.pckdatabyte     = pkg.pckdatabyte;
        r.useddatabyte    = pkg.useddatabyte;
      }
    } catch (e) {
      logOnce(`pkg_fail_${r._sid}`, "[PKG] fetchLatestPackage failed", r._sid, e?.message);
    }

    // 2) fetch template cost by id
    try {
      if (r.prepaidpackagetemplateid != null) {
        const tpl = await fetchTemplateCost(r.prepaidpackagetemplateid);
        if (tpl?.cost != null) {
          r.subscriberOneTimeCost = tpl.cost;
        } else {
          logOnce(`tpl_nocost_${r.prepaidpackagetemplateid}`, "[ROW] template applied but cost not found", r.prepaidpackagetemplateid);
        }
        if (tpl?.name && !r.prepaidpackagetemplatename) r.prepaidpackagetemplatename = tpl.name;
        logOnce(`row_tpl_${r.prepaidpackagetemplateid}`, "[ROW] template applied", r.prepaidpackagetemplateid, r.subscriberOneTimeCost);
      } else {
        logOnce(`row_no_tpl_${r._sid}`, "[ROW] missing prepaidpackagetemplateid for subscriber", r._sid);
      }
    } catch (e) {
      logOnce(`tpl_fail_${r._sid}`, "[ROW] template fetch failed", r._sid, e?.message);
    }

    delete r._sid;
  }, 6);

  return rows;
}
