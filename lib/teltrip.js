// app/page.js
"use client";

import React, { useMemo, useState } from "react";

const BASE = process.env.NEXT_PUBLIC_OCS_BASE || "https://ocs-api.esimvault.cloud/v1";
const TOKEN = process.env.NEXT_PUBLIC_OCS_TOKEN || "";
const DEFAULT_ACCOUNT_ID = process.env.NEXT_PUBLIC_DEFAULT_ACCOUNT_ID
  ? Number(process.env.NEXT_PUBLIC_DEFAULT_ACCOUNT_ID)
  : 0;

// Change if needed (used for "since" totals)
const RANGE_START_YMD = "2025-06-01";

// ---------- tiny helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (v) => (v === null || v === undefined || Number.isNaN(v) ? "" : String(v));
const bytesToGB = (b) => (typeof b === "number" ? (b / 1024 / 1024 / 1024).toFixed(3) : "");

// ---------- OCS call with simple retry ----------
async function callOCS(payload, { retries = 2, retryDelayMs = 800 } = {}) {
  const url = `${BASE}?token=${encodeURIComponent(TOKEN)}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp.ok) {
      // some deployments return 200 with JSON body even for logical errors
      const data = await resp.json().catch(() => ({}));
      return data;
    }
    if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
  }
  throw new Error("OCS request failed after retries");
}

// ---------- cache for template costs ----------
const templateCostCache = new Map(); // key: templateId, val: { cost, ts }

// NOTE: adapt the method name/shape if your OCS differs. You mentioned "4.1.1 By template Id".
async function fetchTemplateCost(templateId) {
  if (!templateId) return null;

  if (templateCostCache.has(templateId)) {
    return templateCostCache.get(templateId);
  }

  // Try common shapes; keep whichever your OCS supports.
  const candidates = [
    { getPrepaidPackageTemplateById: { prepaidpackagetemplateid: templateId } },
    { getPrepaidPackageTemplate: { prepaidpackagetemplateid: templateId } },
    { getPrepaidPackageTemplate: { id: templateId } },
  ];

  let tpl = null;
  for (const payload of candidates) {
    try {
      const r = await callOCS(payload);
      // Try to detect cost in a few likely paths
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

// ---------- packages (include expired) ----------
async function fetchPackagesForSubscriber(subscriberId) {
  // includeExpired/includeInactive are harmless if the backend ignores them
  const payload = {
    listSubscriberPrepaidPackages: {
      subscriberId,
      includeExpired: true,
      includeInactive: true,
      pageSize: 500, // if supported
      page: 1,
    },
  };
  const r = await callOCS(payload);
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
    .sort(
      (a, b) => new Date(a.tsactivationutc || 0) - new Date(b.tsactivationutc || 0)
    );

  const latest = history.at(-1) || null;
  return { latest, history };
}

async function resolvePackageCost(pkg) {
  if (!pkg) return null;
  if (typeof pkg.packageOneTimeCost === "number") return pkg.packageOneTimeCost;
  if (pkg.prepaidpackagetemplateid) {
    const tpl = await fetchTemplateCost(pkg.prepaidpackagetemplateid);
    if (tpl?.cost != null) return tpl.cost;
  }
  return null;
}

// ---------- subscribers (with pagination if supported) ----------
async function fetchAllSubscribers(accountId) {
  const all = [];
  let page = 1;
  const pageSize = 500; // Raise/lower if your OCS allows
  // Try a paged loop; if backend ignores, this will just get page 1.
  for (;;) {
    const r = await callOCS({
      listSubscriber: {
        accountId,
        page,
        pageSize,
      },
    });
    const arr =
      r?.listSubscriber?.subscribers ??
      r?.listSubscriber ??
      r?.subscribers ??
      [];
    if (!arr.length) break;
    all.push(
      ...arr.map((s) => ({
        _sid:
          s?.subscriberId ?? s?.subscriberid ?? s?.id ?? s?.SID ?? s?.iccid ?? null,
        ICCID: s?.ICCID ?? s?.iccid ?? null,
        activationDate: s?.activationDate ?? null,
        lastUsageDate: s?.lastUsageDate ?? null,
      }))
    );
    // stop if fewer than a full page (or if backend doesn't page)
    if (arr.length < pageSize) break;
    page += 1;
    // be polite
    await sleep(120);
  }
  return all;
}

export default function OCSDashboard() {
  const [accountId, setAccountId] = useState(
    DEFAULT_ACCOUNT_ID ? String(DEFAULT_ACCOUNT_ID) : ""
  );
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");

  const totalRows = rows.length;
  const totals = useMemo(() => {
    let allTime = 0;
    let since = 0;
    let activePacks = 0;
    let expiredPacks = 0;

    for (const r of rows) {
      allTime += r.accountingOneTimeCostAllTime || 0;
      since += r.accountingOneTimeCostSinceRange || 0;
      activePacks += r.packagesActiveCount || 0;
      expiredPacks += r.packagesExpiredCount || 0;
    }
    return { allTime, since, activePacks, expiredPacks };
  }, [rows]);

  const loadData = async () => {
    setError("");
    if (!TOKEN) {
      setError("Missing NEXT_PUBLIC_OCS_TOKEN.");
      return;
    }
    if (!BASE) {
      setError("Missing NEXT_PUBLIC_OCS_BASE.");
      return;
    }
    const acc = Number(accountId);
    if (!acc) {
      setError("Enter a valid accountId.");
      return;
    }

    setLoading(true);
    try {
      // 1) get subscribers
      const subs = await fetchAllSubscribers(acc);

      // 2) for each subscriber, get packages (expired included) and compute accounting
      const out = [];
      // throttle: process in batches of 10 to avoid hammering OCS
      const batchSize = 10;
      for (let i = 0; i < subs.length; i += batchSize) {
        const slice = subs.slice(i, i + batchSize);
        const chunk = await Promise.all(
          slice.map(async (r) => {
            try {
              const { latest, history } = await fetchPackagesForSubscriber(r._sid);

              // Keep UI fields from the latest package (your current table style)
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

              // ---- Accounting over all packages (expired included) ----
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

                const cost = await resolvePackageCost(pkg);
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

              // also expose resolved latest package cost if you want it shown per-row
              let subscriberOneTimeCost = null;
              if (latest) subscriberOneTimeCost = await resolvePackageCost(latest);

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
        // small delay per batch to be nice to OCS
        await sleep(150);
      }

      setRows(out);
    } catch (e) {
      setError(e?.message || "Unexpected error.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui" }}>
      <h1 style={{ fontSize: 24, marginBottom: 12 }}>OCS Dashboard (with expired packages)</h1>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "220px 140px 140px auto",
          gap: 12,
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <div>
          <label style={{ display: "block", fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
            Account ID
          </label>
          <input
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            placeholder="e.g., 3432"
            style={{
              width: "100%",
              padding: "8px 10px",
              background: "#0b1020",
              color: "#e9eefc",
              border: "1px solid #2a3354",
              borderRadius: 8,
            }}
          />
        </div>

        <div>
          <label style={{ display: "block", fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
            Range start (for 'since' total)
          </label>
          <input
            defaultValue={RANGE_START_YMD}
            readOnly
            style={{
              width: "100%",
              padding: "8px 10px",
              background: "#101630",
              color: "#c3c9e8",
              border: "1px solid #2a3354",
              borderRadius: 8,
              opacity: 0.8,
            }}
          />
        </div>

        <button
          onClick={loadData}
          disabled={loading}
          style={{
            height: 40,
            borderRadius: 10,
            border: "1px solid #2a3354",
            background: loading ? "#1f2750" : "#1a2144",
            color: "#e9eefc",
            cursor: loading ? "default" : "pointer",
          }}
        >
          {loading ? "Loading…" : "Fetch"}
        </button>

        <div style={{ justifySelf: "end", opacity: 0.8 }}>
          {totalRows ? `Rows: ${totalRows}` : ""}
        </div>
      </div>

      {error ? (
        <div
          style={{
            background: "#3b1e2a",
            color: "#ffd7de",
            padding: 12,
            borderRadius: 8,
            border: "1px solid #6b2a3e",
            marginBottom: 16,
          }}
        >
          {error}
        </div>
      ) : null}

      {/* Summary */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 12,
          marginBottom: 16,
        }}
      >
        <Card label="One-time cost (All-time)" value={`${totals.allTime.toFixed(2)} €`} />
        <Card label={`One-time cost (Since ${RANGE_START_YMD})`} value={`${totals.since.toFixed(2)} €`} />
        <Card label="Packages Active (count)" value={String(totals.activePacks)} />
        <Card label="Packages Expired (count)" value={String(totals.expiredPacks)} />
      </div>

      {/* Table header */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            "1.2fr 1.6fr 1.2fr 1.2fr 1.4fr 1.4fr 1.2fr 1.2fr 1.2fr 1.4fr 1.4fr",
          gap: 8,
          padding: "10px 8px",
          background: "#131938",
          border: "1px solid #2a3354",
          borderRadius: 10,
          fontSize: 13,
          fontWeight: 600,
          color: "#c9d3ff",
        }}
      >
        <div>ICCID</div>
        <div>Activation</div>
        <div>Last Usage</div>
        <div>Template ID</div>
        <div>Template Name</div>
        <div>Latest Package Cost (€)</div>
        <div>Pkg Data (GB)</div>
        <div>Used (GB)</div>
        <div>Active Cnt</div>
        <div>Expired Cnt</div>
        <div>Accounting (Since) €</div>
      </div>

      {/* Rows */}
      <div style={{ marginTop: 6 }}>
        {rows.map((r, i) => (
          <div
            key={i}
            style={{
              display: "grid",
              gridTemplateColumns:
                "1.2fr 1.6fr 1.2fr 1.2fr 1.4fr 1.4fr 1.2fr 1.2fr 1.2fr 1.4fr 1.4fr",
              gap: 8,
              padding: "10px 8px",
              borderBottom: "1px solid #1e2546",
              fontSize: 12.5,
              color: r._err ? "#ff9aa7" : "#dde4ff",
              background: i % 2 ? "#0f1430" : "#0b1020",
            }}
          >
            <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {fmt(r.ICCID)}
            </div>
            <div>{fmt(r.activationDate || r.tsactivationutc)}</div>
            <div>{fmt(r.lastUsageDate)}</div>
            <div>{fmt(r.prepaidpackagetemplateid)}</div>
            <div style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {fmt(r.prepaidpackagetemplatename)}
            </div>
            <div>
              {typeof r.subscriberOneTimeCost === "number"
                ? r.subscriberOneTimeCost.toFixed(2)
                : ""}
            </div>
            <div>{bytesToGB(r.pckdatabyte)}</div>
            <div>{bytesToGB(r.useddatabyte)}</div>
            <div>{fmt(r.packagesActiveCount)}</div>
            <div>{fmt(r.packagesExpiredCount)}</div>
            <div>
              {typeof r.accountingOneTimeCostSinceRange === "number"
                ? r.accountingOneTimeCostSinceRange.toFixed(2)
                : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Card({ label, value }) {
  return (
    <div
      style={{
        background: "#0b1020",
        border: "1px solid #2a3354",
        borderRadius: 12,
        padding: 12,
        color: "#e9eefc",
      }}
    >
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
