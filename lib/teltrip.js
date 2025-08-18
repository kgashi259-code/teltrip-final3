// lib/teltrip.js

// --- Config ---
export const RANGE_START_YMD = "2025-06-01";

// --- Utils ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callOCS(base, token, payload, { retries = 2, retryDelayMs = 800 } = {}) {
  const url = `${base}?token=${encodeURIComponent(token)}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Next.js edge/node runtime fetch is fine here
    });
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      return data;
    }
    if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
  }
  throw new Error("OCS request failed after retries");
}

// --- Template Cost Cache ---
const templateCostCache = new Map(); // key: templateId -> { cost }

async function fetchTemplateCost(base, token, templateId) {
  if (!templateId) return null;
  if (templateCostCache.has(templateId)) return templateCostCache.get(templateId);

  const candidates = [
    { getPrepaidPackageTemplateById: { prepaidpackagetemplateid: templateId } },
    { getPrepaidPackageTemplate: { prepaidpackagetemplateid: templateId } },
    { getPrepaidPackageTemplate: { id: templateId } },
  ];

  let tpl = null;
  for (const payload of candidates) {
    try {
      const r = await callOCS(base, token, payload);
      const node =
        r?.getPrepaidPackageTemplateById ??
        r?.getPrepaidPackageTemplate ??
        r?.template ??
        r;

      const cost =
        typeof node?.cost === "number"
          ? node.cost
          : typeof node?.oneTimePrice === "number"
          ? node.oneTimePrice
          : typeof node?.activationFee === "number"
          ? node.activationFee
          : typeof node?.price?.value === "number"
          ? node.price.value
          : null;

      tpl = { cost };
      break;
    } catch {
      // try next candidate
    }
  }

  if (!tpl) tpl = { cost: null };
  templateCostCache.set(templateId, tpl);
  return tpl;
}

async function resolvePackageCost(base, token, pkg) {
  if (!pkg) return null;
  if (typeof pkg.packageOneTimeCost === "number") return pkg.packageOneTimeCost;
  if (pkg.prepaidpackagetemplateid) {
    const tpl = await fetchTemplateCost(base, token, pkg.prepaidpackagetemplateid);
    if (tpl?.cost != null) return tpl.cost;
  }
  return null;
}

// --- Subscribers (paged if supported) ---
async function fetchAllSubscribers(base, token, accountId) {
  const all = [];
  let page = 1;
  const pageSize = 500;

  for (;;) {
    const r = await callOCS(base, token, {
      listSubscriber: { accountId, page, pageSize },
    });
    const arr =
      r?.listSubscriber?.subscribers ??
      r?.listSubscriber ??
      r?.subscribers ??
      [];
    if (!arr.length) break;

    all.push(
      ...arr.map((s) => ({
        _sid: s?.subscriberId ?? s?.subscriberid ?? s?.id ?? s?.SID ?? s?.iccid ?? null,
        ICCID: s?.ICCID ?? s?.iccid ?? null,
        activationDate: s?.activationDate ?? null,
        lastUsageDate: s?.lastUsageDate ?? null,
      }))
    );

    if (arr.length < pageSize) break;
    page += 1;
    await sleep(120);
  }
  return all;
}

// --- Packages (include expired) ---
async function fetchPackagesForSubscriber(base, token, subscriberId) {
  const payload = {
    listSubscriberPrepaidPackages: {
      subscriberId,
      includeExpired: true,
      includeInactive: true,
      pageSize: 500,
      page: 1,
    },
  };
  const r = await callOCS(base, token, payload);

  const items =
    r?.listSubscriberPrepaidPackages?.packages ??
    r?.listSubscriberPrepaidPackages ??
    r?.packages ??
    [];

  const history = items
    .map((p) => {
      const tpl = p?.packageTemplate || p?.template || {};
      return {
        prepaidpackagetemplatename:
          tpl.prepaidpackagetemplatename ?? tpl.name ?? null,
        prepaidpackagetemplateid:
          tpl.prepaidpackagetemplateid ?? tpl.id ?? null,
        tsactivationutc: p?.tsactivationutc ?? p?.activationTime ?? null,
        tsexpirationutc: p?.tsexpirationutc ?? p?.expirationTime ?? null,
        pckdatabyte: p?.pckdatabyte ?? p?.dataBytes ?? null,
        useddatabyte: p?.useddatabyte ?? p?.usedBytes ?? null,
        packageOneTimeCost:
          (typeof p?.cost === "number" ? p.cost : null) ??
          (typeof p?.oneTimePrice === "number" ? p.oneTimePrice : null) ??
          (typeof p?.activationFee === "number" ? p.activationFee : null) ??
          (typeof p?.price?.value === "number" ? p.price.value : null) ??
          null,
      };
    })
    .sort((a, b) => new Date(a.tsactivationutc || 0) - new Date(b.tsactivationutc || 0));

  const latest = history.at(-1) || null;
  return { latest, history };
}

// --- OPTIONAL: list all reseller accounts (for a dropdown) ---
export async function listResellerAccounts(base, token) {
  const r = await callOCS(base, token, { listResellerAccount: {} });
  // Normalize a few possible shapes
  const arr = r?.listResellerAccount?.accounts ?? r?.accounts ?? r ?? [];
  return arr.map((a) => ({
    accountId: a?.accountId ?? a?.id ?? null,
    name: a?.name ?? a?.accountName ?? "",
  }));
}

// --- MAIN: fetchAllData (exported) ---
export async function fetchAllData({ accountId, base, token }) {
  if (!base) throw new Error("Missing OCS base URL");
  if (!token) throw new Error("Missing OCS token");
  if (!accountId) throw new Error("Missing accountId");

  const subs = await fetchAllSubscribers(base, token, Number(accountId));
  const out = [];

  // Gentle throttling to avoid hammering OCS
  const batchSize = 10;
  for (let i = 0; i < subs.length; i += batchSize) {
    const slice = subs.slice(i, i + batchSize);
    const chunk = await Promise.all(
      slice.map(async (r) => {
        try {
          const { latest, history } = await fetchPackagesForSubscriber(base, token, r._sid);

          // UI fields from latest package
          if (latest) {
            Object.assign(r, {
              prepaidpackagetemplatename: latest.prepaidpackagetemplatename,
              prepaidpackagetemplateid: latest.prepaidpackagetemplateid,
              tsactivationutc: latest.tsactivationutc,
              tsexpirationutc: latest.tsexpirationutc,
              pckdatabyte: latest.pckdatabyte,
              useddatabyte: latest.useddatabyte,
            });
          }

          // Accounting over full history (expired included)
          let totalOneTimeAllTime = 0;
          let totalOneTimeSinceRange = 0;
          let packagesActiveCount = 0;
          let packagesExpiredCount = 0;
          const now = new Date();

          for (const pkg of history) {
            const expired = pkg.tsexpirationutc
              ? new Date(pkg.tsexpirationutc) < now
              : false;
            if (expired) packagesExpiredCount++;
            else packagesActiveCount++;

            const cost = await resolvePackageCost(base, token, pkg);
            if (typeof cost === "number") {
              totalOneTimeAllTime += cost;
              if (
                pkg.tsactivationutc &&
                new Date(pkg.tsactivationutc) >= new Date(RANGE_START_YMD)
              ) {
                totalOneTimeSinceRange += cost;
              }
            }
          }

          let subscriberOneTimeCost = null;
          if (latest) subscriberOneTimeCost = await resolvePackageCost(base, token, latest);

          return {
            ...r,
            subscriberOneTimeCost,
            packagesActiveCount,
            packagesExpiredCount,
            accountingOneTimeCostAllTime: totalOneTimeAllTime,
            accountingOneTimeCostSinceRange: totalOneTimeSinceRange,
          };
        } catch {
          return { ...r, _err: true };
        }
      })
    );
    out.push(...chunk);
    await sleep(150);
  }

  // Totals summary
  const totals = out.reduce(
    (acc, r) => {
      acc.allTime += r.accountingOneTimeCostAllTime || 0;
      acc.since += r.accountingOneTimeCostSinceRange || 0;
      acc.activePacks += r.packagesActiveCount || 0;
      acc.expiredPacks += r.packagesExpiredCount || 0;
      return acc;
    },
    { allTime: 0, since: 0, activePacks: 0, expiredPacks: 0 }
  );

  return { rows: out, totals, rangeStart: RANGE_START_YMD };
}
