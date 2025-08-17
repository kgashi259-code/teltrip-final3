// /pages/api/fetch-data.js
// or /app/api/fetch-data/route.js if you're using the App Router

import { NextResponse } from "next/server";

const BASE_URL = process.env.OCS_BASE_URL;
const TOKEN = process.env.OCS_TOKEN;

async function ocsFetch(body) {
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OCS error ${res.status}: ${text}`);
  }
  return res.json();
}

// 🔍 helper to fetch cost from template
async function fetchPackageCost(templateId) {
  if (!templateId) return 0;
  const data = await ocsFetch({
    listPrepaidPackageTemplate: { templateId: Number(templateId) },
  });
  const templates = data.listPrepaidPackageTemplateRsp?.prepaidPackageTemplate || [];
  return templates.length > 0 ? templates[0].cost : 0;
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const accountId = searchParams.get("accountId");

    // 1. fetch subscribers
    const subsData = await ocsFetch({
      listSubscriber: { accountId: Number(accountId) },
    });
    const subs = subsData.listSubscriberRsp?.subscriber || [];

    // 2. enrich with cost
    const enriched = await Promise.all(
      subs.map(async (s) => {
        const cost = await fetchPackageCost(s.prepaidPackageTemplateId);
        return {
          ...s,
          subscriberOneTimeCost: cost, // ✅ FIXED
        };
      })
    );

    return NextResponse.json({ ok: true, data: enriched });
  } catch (err) {
    console.error("❌ fetch-data API error:", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
