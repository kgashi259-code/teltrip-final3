// lib/teltrip.js
// Minimal change: keep cost logic; fix weekly usage via subscriberUsageOverPeriod.

const BASE = process.env.OCS_BASE_URL;
const TOKEN = process.env.OCS_TOKEN;
const DEFAULT_ACCOUNT_ID = parseInt(process.env.OCS_ACCOUNT_ID || "0", 10);

// ---------- helpers ----------
const toYMD = (d) => d.toISOString().slice(0, 10);
function last7Days() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 6); // inclusive 7-day window
  return { start: toYMD(start), end: toYMD(end) };
}

async function callOCS(body) {
  const url = `${BASE}?token=${encodeURIComponent(TOKEN)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(`OCS ${res.status} ${res.statusText} :: ${text?.slice?.(0,200) || ""}`);
  return json ?? {};
}

// ---------- subscribers ----------
async function listSubscribers(accountId) {
  const r = await callOCS({ listSubscriber: { accountId: Number(accountId) } });
  return r?.listSubscriber?.subscriberList || [];
}

// ---------- (existing) cost logic - unchanged ----------
const tplCostCache = new Map();
async function getTemplateCost(templateId) {
  const id = Number(templateId);
  if (!id) return null;
  if (tplCostCache.has(id)) return tplCostCache.get(id);

  // try listPrepaidPackageTemplate
  let tpl = null;
  try {
    const r1 = await callOCS({ listPrepaidPackageTemplate: { templateId: id } });
    tpl = r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate?.[0]
       || r1?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate;
  } catch {}
  // fallback getPrepaidPackageTemplate
  if (!tpl) {
    try {
      const r2 = await callOCS({ getPrepaidPackageTemplate: { prepaidPackageTemplateId: id } });
      tpl = r2?.prepaidPackageTemplate || r2?.template;
    } catch {}
  }
  let cost = null;
  if (tpl) {
    // permissive pick
    const n = Number(
      tpl.oneTimePrice ?? tpl.activationFee ?? tpl.subscriberCost ??
      tpl.cost ?? tpl.price ?? tpl?.price?.value
    );
    cost = Number.isFinite(n) ? n : null;
  }
  tplCostCache.set(id, cost);
  return cost;
}

async function getLatestPackage(subscriberId) {
  const r = await callOCS({ listSubscriberPrepaidPackages: { subscriberId: Number(subscriberId) } });
  const pkgs = r?.listSubscriberPrepaidPackages?.packages || [];
  if (!pkgs.length) return null;
  pkgs.sort((a,b)=> new Date(a.tsactivationutc||0) - new Date(b.tsactivationutc||0));
  const p = pkgs.at(-1);
  const t = p?.packageTemplate || {};
  return {
    prepaidpackagetemplatename: t.prepaidpackagetemplatename ?? t.name ?? null,
    prepaidpackagetemplateid: Number(t.prepaidpackagetemplateid ?? t.id) || null,
    // handy fallbacks if you display them elsewhere
    pckdatabyte: p?.pckdatabyte ?? null,
    useddatabyte: p?.useddatabyte ?? null,
    packageOneTimeCost:
      (typeof p?.cost === "number" ? p.cost : null) ??
      (typeof p?.oneTimePrice === "number" ? p.oneTimePrice : null) ??
      (typeof p?.activationFee === "number" ? p.activationFee : null) ??
      (typeof p?.price?.value === "number" ? p.price.value : null) ?? null,
  };
}

// ---------- weekly usage (fix) ----------
async function getWeeklyUsageBytes(subscriberId) {
  const { start, end } = last7Days(); // must be <= 1 week (API rule)
  const r = await callOCS({
    subscriberUsageOverPeriod: {
      subscriber: { subscriberId: Number(subscriberId) },
      period: { start, end },
    },
  });
  // bytes are in total.quantityPerType["33"] (33 = Data)
  const total = r?.subscriberUsageOverPeriod?.total || {};
  const qpt = total?.quantityPerType || {};
  const raw = qpt["33"];
  const bytes = Number.isFinite(raw) ? raw : Number(raw);
  return Number.isFinite(bytes) ? bytes : 0;
}

// ---------- main export ----------
export async function fetchAllData(accountIdParam) {
  const accountId = Number(accountIdParam || DEFAULT_ACCOUNT_ID || 0);
  if (!BASE || !TOKEN || !accountId) throw new Error("Missing OCS config or accountId");

  const subs = await listSubscribers(accountId);

  const rows = [];
  for (const s of subs) {
    const subscriberId = s?.subscriberId ?? s?.imsiList?.[0]?.subscriberId ?? null;
    if (!subscriberId) continue;

    // base row (keep your existing fields)
    const row = {
      iccid: s?.imsiList?.[0]?.iccid ?? null,
      imsi:  s?.imsiList?.[0]?.imsi  ?? null,
      phoneNumber: s?.phoneNumberList?.[0]?.phoneNumber ?? null,
      subscriberStatus: s?.status?.[0]?.status ?? s?.subscriberStatus ?? null,
      simStatus: s?.sim?.status ?? null,
      esim: s?.sim?.esim ?? null,
      activationCode: s?.sim?.activationCode ?? null,
      activationDate: s?.activationDate ?? null,
      lastUsageDate: s?.lastUsageDate ?? null,
      prepaid: s?.prepaid ?? null,
      balance: s?.balance ?? null,
      account: s?.account ?? null,
      reseller: s?.reseller ?? null,
      lastMcc: s?.lastMcc ?? null,
      lastMnc: s?.lastMnc ?? null,

      prepaidpackagetemplatename: null,
      prepaidpackagetemplateid: null,

      // the two columns in question:
      subscriberUsageOverPeriod: 0,     // filled below
      subscriberOneTimeCost: null,      // cost stays as before
    };

    // latest package (for names + cost fallback)
    try {
      const pkg = await getLatestPackage(subscriberId);
      if (pkg) {
        row.prepaidpackagetemplatename = pkg.prepaidpackagetemplatename;
        row.prepaidpackagetemplateid   = pkg.prepaidpackagetemplateid;
        // package one-time fee fallback if template cost not found
        if (pkg.packageOneTimeCost != null) row._pkgFee = pkg.packageOneTimeCost;
      }
    } catch {}

    // cost via template (unchanged behavior)
    try {
      if (row.prepaidpackagetemplateid) {
        const c = await getTemplateCost(row.prepaidpackagetemplateid);
        if (c != null) row.subscriberOneTimeCost = c;
      }
      if (row.subscriberOneTimeCost == null && row._pkgFee != null) {
        row.subscriberOneTimeCost = row._pkgFee;
      }
    } catch {}
    delete row._pkgFee;

    // FIX: weekly usage bytes
    try {
      row.subscriberUsageOverPeriod = await getWeeklyUsageBytes(subscriberId);
    } catch {
      row.subscriberUsageOverPeriod = 0;
    }

    rows.push(row);
  }

  return rows;
}
