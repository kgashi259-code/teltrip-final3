
// Teltrip data layer: streamlined version for essential fields only

const BASE = process.env.OCS_BASE_URL;
const TOKEN = process.env.OCS_TOKEN;
const DEFAULT_ACCOUNT_ID = parseInt(process.env.OCS_ACCOUNT_ID || "0", 10);
const RANGE_START_YMD = "2025-06-01";

function must(v, name) { if (!v) throw new Error(`${name} missing`); return v; }
const toYMD = (d) => d.toISOString().slice(0, 10);

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

function latestByDate(arr) {
  if (!Array.isArray(arr) || !arr.length) return null;
  return arr.slice().sort((a,b)=>new Date(a.startDate||0)-new Date(b.startDate||0)).at(-1);
}

async function fetchAllData(accountId = DEFAULT_ACCOUNT_ID) {
  const { listSubscriber } = await callOCS({ listSubscriber: { accountId } });
  const subscribers = listSubscriber?.subscriberList || [];

  const results = await Promise.all(subscribers.map(async (s) => {
    const iccid = s?.imsiList?.[0]?.iccid || null;
    const subscriberId = s?.subscriberId;
    const lastUsageDate = s?.lastUsageDate || null;

    if (!subscriberId || !iccid) return null;

    const [pkgResp, usageResp] = await Promise.all([
      callOCS({ listSubscriberPrepaidPackages: { subscriberId } }),
      callOCS({ subscriberUsageOverPeriod: {
        subscriberId,
        startDateYMD: RANGE_START_YMD,
        endDateYMD: toYMD(new Date())
      } })
    ]);

    const packageInfo = pkgResp?.listSubscriberPrepaidPackages?.subscriberPrepaidPackage?.[0] || {};
    const prepaidPackageTemplateId = packageInfo?.prepaidPackageTemplateId;
    const tsactivationutc = packageInfo?.tsactivationutc || null;
    const tsexpirationutc = packageInfo?.tsexpirationutc || null;
    const pckdatabyte = packageInfo?.pckdatabyte || null;
    const useddatabyte = packageInfo?.useddatabyte || null;

    let prepaidTemplateName = null;
    let cost = null;
    if (prepaidPackageTemplateId) {
      const tplResp = await callOCS({ listPrepaidPackageTemplate: { templateId: prepaidPackageTemplateId } });
      const tpl = tplResp?.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate?.[0];
      prepaidTemplateName = tpl?.prepaidPackageTemplateName || null;
      cost = tpl?.oneTimeCost || tpl?.activationCost || tpl?.setupCost || tpl?.cost || null;
    }

    const weekly = usageResp?.subscriberUsageOverPeriod?.usageList || [];
    const resellerCost = weekly.reduce((sum, u) => sum + (parseFloat(u?.resellerCost || 0)), 0);

    return {
      iccid,
      lastUsageDate,
      prepaidTemplateName,
      cost,
      pckdatabyte,
      useddatabyte,
      tsactivationutc,
      tsexpirationutc,
      totalResellerCost: resellerCost
    };
  }));

  return results.filter(Boolean);
}

export { fetchAllData };
