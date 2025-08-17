import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BASE = process.env.OCS_BASE_URL;
const TOKEN = process.env.OCS_TOKEN;

function getResellerId(req) {
  const url = new URL(req.url);
  const q = url.searchParams.get("resellerId");
  if (q && /^\d+$/.test(q)) return Number(q);
  if (process.env.OCS_RESELLER_ID && /^\d+$/.test(process.env.OCS_RESELLER_ID)) {
    return Number(process.env.OCS_RESELLER_ID);
  }
  return undefined;
}

async function callOCS(body) {
  if (!BASE || !TOKEN) throw new Error("Missing OCS env");
  const r = await fetch(`${BASE}?token=${encodeURIComponent(TOKEN)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store"
  });
  const txt = await r.text();
  let json = null; try { json = txt ? JSON.parse(txt) : null; } catch {}
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}${txt ? " :: "+txt.slice(0,300) : ""}`);
  return json ?? {};
}

function flattenResellerAccounts(resp) {
  // Expected shape:
  // resp.listResellerAccount.reseller[] -> { id, name, account: [{ id, name, ... }, ...] }
  const resellers = resp?.listResellerAccount?.reseller;
  if (!Array.isArray(resellers)) return [];
  const out = [];
  for (const r of resellers) {
    const accounts = Array.isArray(r?.account) ? r.account : [];
    for (const a of accounts) {
      const id = a?.id ?? a?.accountId;
      const name = a?.name ?? a?.accountName ?? (id ? `Account ${id}` : null);
      if (id && name) out.push({ id, name, resellerId: r?.id ?? null, resellerName: r?.name ?? null });
    }
  }
  return out;
}

export async function GET(req) {
  try {
    const resellerId = getResellerId(req);

    // 1) Per guide: listResellerAccount (all or specific reseller)
    const primary = resellerId
      ? await callOCS({ listResellerAccount: { resellerId } })
      : await callOCS({ listResellerAccount: {} });

    let accounts = flattenResellerAccounts(primary);

    // 2) Fallbacks for tenants exposing different shapes
    if (accounts.length === 0) {
      const tries = [
        { body: { listAccount: {} }, pick: r => r?.listAccount?.accounts },
        { body: { listAccounts: {} }, pick: r => r?.listAccounts?.accounts },
        { body: { listResellerAccounts: {} }, pick: r => r?.listResellerAccounts?.accounts },
        { body: { listCustomerAccounts: {} }, pick: r => r?.listCustomerAccounts?.accounts }
      ];
      for (const t of tries) {
        try {
          const r = await callOCS(t.body);
          const arr = t.pick(r);
          if (Array.isArray(arr) && arr.length) {
            accounts = arr
              .map(a => ({
                id: a?.accountId ?? a?.id,
                name: a?.accountName ?? a?.name ?? (a?.id ? `Account ${a.id}` : null)
              }))
              .filter(a => a.id && a.name);
            break;
          }
        } catch {}
      }
    }

    // 3) Ultimate fallback so UI still works
    if (accounts.length === 0 && process.env.OCS_ACCOUNT_ID) {
      try {
        const accId = Number(process.env.OCS_ACCOUNT_ID);
        const ls = await callOCS({ listSubscriber: { accountId: accId } });
        const subs = ls?.listSubscriber?.subscriberList || [];
        const name = subs?.[0]?.account || `Account ${accId}`;
        accounts = [{ id: accId, name }];
      } catch {}
    }

    return NextResponse.json({ ok: true, data: accounts });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
