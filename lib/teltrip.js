
const BASE = process.env.OCS_BASE_URL;
const TOKEN = process.env.OCS_TOKEN;
const ACCOUNT_ID = parseInt(process.env.OCS_ACCOUNT_ID || "0", 10);
const RANGE_START_YMD = "2025-06-01";

function must(v, name) { if (!v) throw new Error(`${name} missing`); return v; }
const toYMD = (d) => d.toISOString().slice(0, 10);

async function callOCS(payload) {
  must(BASE, "OCS_BASE_URL"); must(TOKEN, "OCS_TOKEN");
  const url = `${BASE}?token=${encodeURIComponent(TOKEN)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
  return json ?? {};
}

async function fetchData(accountId = ACCOUNT_ID) {
  const nowYMD = toYMD(new Date());

  // 1. Get Subscribers (ICCID + lastUsageDate)
  const subsResp = await callOCS({ listSubscriber: { accountId } });
  const subscribers = (subsResp.listSubscriber?.subscriberList || []).map(sub => ({
    iccid: sub.imsiList?.[0]?.iccid,
    lastUsageDate: sub.lastUsageDate,
    subscriberId: sub.subscriberId
  }));

  // 2. Get Prepaid Package Templates (prepaidpackagetemplatename + cost)
  const templatesResp = await callOCS({ listPrepaidPackageTemplate: { resellerId: 0 } });
  const templateMap = Object.fromEntries(
    (templatesResp.listPrepaidPackageTemplate?.template || []).map(t => [
      t.id,
      { name: t.prepaidPackageTemplateName, cost: t.cost }
    ])
  );

  // 3. Get Prepaid Packages (per subscriber)
  const enrichedSubscribers = await Promise.all(
    subscribers.map(async (sub) => {
      const prepaidResp = await callOCS({ listSubscriberPrepaidPackages: { subscriberId: sub.subscriberId } });
      const pck = prepaidResp.listSubscriberPrepaidPackages?.subscriberPrepaidPackageList?.[0];
      return {
        ...sub,
        pckdatabyte: pck?.pckDataByte,
        useddatabyte: pck?.usedDataByte,
        tsactivationutc: pck?.tsActivationUtc,
        tsexpirationutc: pck?.tsExpirationUtc,
        template: templateMap[pck?.prepaidPackageTemplateId] || {}
      };
    })
  );

  // 4. Get Usage Costs (weekly resellerCost)
  const usageBySubscriber = await Promise.all(
    enrichedSubscribers.map(async (sub) => {
      const usageResp = await callOCS({
        subscriberUsageOverPeriod: {
          subscriberId: sub.subscriberId,
          startYmd: RANGE_START_YMD,
          endYmd: nowYMD,
          period: "WEEK"
        }
      });
      const costs = (usageResp.subscriberUsageOverPeriod?.usageList || []).map(x => parseFloat(x.resellerCost || 0));
      const resellerCost = costs.reduce((sum, cost) => sum + cost, 0);
      return { ...sub, resellerCost: resellerCost.toFixed(2) };
    })
  );

  return usageBySubscriber;
}

export { fetchData };
