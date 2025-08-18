// /app/api/fetch-data/route.js
import { NextResponse } from "next/server";
import { fetchAllData } from "../../../lib/teltrip";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const accountId = url.searchParams.get("accountId") || undefined;

    // pagination + knobs
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit") || 50)));
    const cursor = Math.max(0, Number(url.searchParams.get("cursor") || 0));
    const includeUsage = url.searchParams.get("includeUsage") === "1";
    const usageFrom = url.searchParams.get("usageFrom") || ""; // e.g. "2025-06-01"

    const { rows, nextCursor } = await fetchAllData(accountId, {
      limit,
      cursor,
      includeUsage,
      usageFrom,
    });

    return NextResponse.json({ ok: true, data: rows, nextCursor });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
