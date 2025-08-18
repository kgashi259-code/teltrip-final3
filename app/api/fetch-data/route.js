// app/api/fetch-data/route.js
import { fetchAllData } from "../../../lib/teltrip";

const BASE = process.env.NEXT_PUBLIC_OCS_BASE || "https://ocs-api.esimvault.cloud/v1";
const TOKEN = process.env.NEXT_PUBLIC_OCS_TOKEN || "HgljQn4Uhe6Ny07qTzYqPLjJ";

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const accountId = Number(body?.accountId);
    if (!accountId) {
      return new Response(JSON.stringify({ error: "Invalid or missing accountId" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const data = await fetchAllData({ accountId, base: BASE, token: TOKEN });
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e?.message || "Unexpected error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

export async function GET(req) {
  // Optional convenience: ?accountId=3432
  const { searchParams } = new URL(req.url);
  const accountId = Number(searchParams.get("accountId"));
  if (!accountId) {
    return new Response(JSON.stringify({ error: "Provide ?accountId=" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  try {
    const data = await fetchAllData({ accountId, base: BASE, token: TOKEN });
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e?.message || "Unexpected error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
