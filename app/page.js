// app/page.js
"use client";

import React, { useEffect, useMemo, useState, Fragment } from "react";
import * as XLSX from "xlsx";

// safe fetch
async function safeFetch(url) {
  const res = await fetch(url, { cache: "no-store" });
  const txt = await res.text();
  let json = null; try { json = txt ? JSON.parse(txt) : null; } catch {}
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}${txt ? " :: " + txt.slice(0,300) : ""}`);
  return json ?? {};
}

// utils
const bytesToGB = (b) => (b == null || isNaN(b)) ? "" : (Number(b) / (1024 ** 3)).toFixed(2);
const money = (n) => (n == null || isNaN(n)) ? "" : Number(n).toFixed(2);
const fmtDT = (s) => typeof s === "string" ? s.replace("T", " ") : s ?? "";

// columns
const columns = [
  "ICCID","IMSI","phoneNumber","subscriberStatus","simStatus","esim","activationCode",
  "activationDate","lastUsageDate","prepaid","balance","account","reseller","lastMcc","lastMnc",
  "prepaidpackagetemplatename","prepaidpackagetemplateid","tsactivationutc","tsexpirationutc","pckdatabyte","useddatabyte","pckdata(GB)","used(GB)",
  "subscriberOneTimeCost","usageSinceJun1(GB)","resellerCostSinceJun1"
];

export default function Page() {
  const [accountId, setAccountId] = useState("3771");
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const [accounts, setAccounts] = useState([]);
  const [accountSearch, setAccountSearch] = useState("");

  const logoSrc = process.env.NEXT_PUBLIC_LOGO_URL || "/logo.png";

  // load accounts (listResellerAccount → flattened in API)
  async function loadAccounts() {
    const url = "/api/accounts";
    const r = await fetch(url, { cache: "no-store" });
    const t = await r.text(); let j=null; try{ j=t?JSON.parse(t):null; }catch{}
    if (j?.ok && Array.isArray(j.data)) {
      setAccounts(j.data);
      if (!j.data.some(a => String(a.id) === String(accountId)) && j.data.length) {
        setAccountId(String(j.data[0].id));
      }
    }
  }
  useEffect(() => { loadAccounts(); }, []);

  // load data for selected account
  async function load() {
    setErr(""); setLoading(true);
    try {
      const url = new URL("/api/fetch-data", window.location.origin);
      if (accountId) url.searchParams.set("accountId", String(accountId).trim());
      const payload = await safeFetch(url.toString());
      if (payload?.ok === false) throw new Error(payload.error || "API error");
      setRows(Array.isArray(payload?.data) ? payload.data : []);
      if (!Array.isArray(payload?.data)) setErr("No data array. Check env/token/accountId.");
    } catch (e) {
      setRows([]); setErr(e.message || "Failed");
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [accountId]); // reload when account changes

  // filter rows
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    if (!n) return rows;
    return rows.filter(r => Object.values(r).some(v => String(v ?? "").toLowerCase().includes(n)));
  }, [rows, q]);

  // totals (current account) + PNL
  const totals = useMemo(() => {
    let totalReseller = 0;
    let totalSubscriberOneTime = 0;
    for (const r of rows) {
      if (Number.isFinite(r?.resellerCostSinceJun1)) totalReseller += Number(r.resellerCostSinceJun1);
      if (Number.isFinite(r?.subscriberOneTimeCost)) totalSubscriberOneTime += Number(r.subscriberOneTimeCost);
    }
    const pnl = totalSubscriberOneTime - totalReseller;
    return { totalReseller, totalSubscriberOneTime, pnl };
  }, [rows]);

  // export buttons
  function exportCSV() {
    const headers = [...columns];
    const lines = [headers.join(",")];
    filtered.forEach(r => {
      lines.push([
        r.iccid ?? "", r.imsi ?? "", r.phoneNumber ?? "", r.subscriberStatus ?? "", r.simStatus ?? "", String(r.esim ?? ""),
        r.activationCode ?? "", fmtDT(r.activationDate), fmtDT(r.lastUsageDate), String(r.prepaid ?? ""), r.balance ?? "",
        r.account ?? "", r.reseller ?? "", r.lastMcc ?? "", r.lastMnc ?? "",
        r.prepaidpackagetemplatename ?? "", r.prepaidpackagetemplateid ?? "", fmtDT(r.tsactivationutc), fmtDT(r.tsexpirationutc),
        r.pckdatabyte ?? "", r.useddatabyte ?? "", bytesToGB(r.pckdatabyte), bytesToGB(r.useddatabyte),
        money(r.subscriberOneTimeCost), bytesToGB(r.totalBytesSinceJun1), money(r.resellerCostSinceJun1)
      ].map(x => `"${String(x).replace(/"/g, '""')}"`).join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `teltrip_dashboard_${new Date().toISOString().slice(0,10)}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  function exportExcel() {
    const data = filtered.map(r => ({
      ICCID: r.iccid ?? "",
      IMSI: r.imsi ?? "",
      phoneNumber: r.phoneNumber ?? "",
      subscriberStatus: r.subscriberStatus ?? "",
      simStatus: r.simStatus ?? "",
      esim: String(r.esim ?? ""),
      activationCode: r.activationCode ?? "",
      activationDate: fmtDT(r.activationDate),
      lastUsageDate: fmtDT(r.lastUsageDate),
      prepaid: String(r.prepaid ?? ""),
      balance: r.balance ?? "",
      account: r.account ?? "",
      reseller: r.reseller ?? "",
      lastMcc: r.lastMcc ?? "",
      lastMnc: r.lastMnc ?? "",
      prepaidpackagetemplatename: r.prepaidpackagetemplatename ?? "",
      prepaidpackagetemplateid: r.prepaidpackagetemplateid ?? "",
      tsactivationutc: fmtDT(r.tsactivationutc),
      tsexpirationutc: fmtDT(r.tsexpirationutc),
      pckdatabyte: r.pckdatabyte ?? "",
      useddatabyte: r.useddatabyte ?? "",
      "pckdata(GB)": bytesToGB(r.pckdatabyte),
      "used(GB)": bytesToGB(r.useddatabyte),
      subscriberOneTimeCost: money(r.subscriberOneTimeCost),
      "usageSinceJun1(GB)": bytesToGB(r.totalBytesSinceJun1),
      resellerCostSinceJun1: money(r.resellerCostSinceJun1)
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Teltrip");
    XLSX.writeFile(wb, `teltrip_dashboard_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  // styles
  const colW = 170;
  const headerBox = { padding:"10px 12px", background:"#eaf6c9", borderBottom:"1px solid #cbd5a7", fontWeight:600, color:"#000" };
  const cellBox = (i) => ({
    padding:"10px 12px",
    borderBottom:"1px solid #cbd5a7",
    background: i%2? "#ffffff":"#f6fadf",
    wordBreak:"break-all",
    color:"#000"
  });

  const logout = async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  };

  return (
    <main style={{ padding: 24, maxWidth: 1800, margin: "0 auto", background:"#eff4db", color:"#000" }}>
      {/* header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom: 12 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <img src={logoSrc} alt="Teltrip" style={{ height: 48 }} />
          <h1 style={{ margin:0 }}>Teltrip Dashboard</h1>
        </div>
        <button onClick={logout} style={{ padding:"8px 12px", borderRadius:10, border:"1px solid #cbd5a7", background:"#e6f3c2", cursor:"pointer" }}>
          Logout
        </button>
      </div>

      {/* ACCOUNTS: dropdown + refresh + filter */}
      <div style={{ display:"grid", gridTemplateColumns:"280px auto 260px", gap:12, alignItems:"center", marginBottom:10 }}>
        <select
          value={String(accountId)}
          onChange={e=>{ setAccountId(e.target.value); }}
          style={{ padding:"10px 12px", borderRadius:10, border:"1px solid #cbd5a7", background:"#fff", color:"#000", width:"100%" }}
        >
          {accounts
            .filter(a => (a.name || "").toLowerCase().includes((accountSearch||"").toLowerCase()))
            .map(a => <option key={a.id} value={String(a.id)}>{a.name} — {a.id}</option>)
          }
          {accounts.length === 0 && <option>Loading accounts…</option>}
        </select>

        <button
          onClick={loadAccounts}
          style={{ padding:"8px 14px", borderRadius:10, border:"1px solid #cbd5a7", background:"#e6f3c2", color:"#000", cursor:"pointer", justifySelf:"start" }}
        >
          Refresh accounts
        </button>

        <input
          placeholder="Filter accounts by name…"
          value={accountSearch}
          onChange={e=>setAccountSearch(e.target.value)}
          style={{ padding:"10px 12px", borderRadius:10, border:"1px solid #cbd5a7", background:"#fff", color:"#000", width:"100%" }}
        />
      </div>

      {/* top controls + totals + PNL */}
      <header style={{ display:"grid", gridTemplateColumns:"auto 1fr auto auto 260px", gap:12, alignItems:"center", marginBottom:14 }}>
        <h2 style={{ margin:0, color:"#000" }}>Overview</h2>

        <div style={{
          justifySelf:"start",
          display:"flex",
          gap:12,
          alignItems:"center",
          background:"#fff",
          border:"1px solid #cbd5a7",
          borderRadius:10,
          padding:"8px 12px",
          color:"#000",
          whiteSpace:"nowrap"
        }}>
          <div><b>Total Subscriber Cost:</b> {money(totals.totalSubscriberOneTime)}</div>
          <div>|</div>
          <div><b>Total Reseller Cost:</b> {money(totals.totalReseller)}</div>
          <div>|</div>
          <div><b>PNL:</b> {money(totals.pnl)}</div>
        </div>

        <button onClick={load} disabled={loading}
          style={{ padding:"8px 14px", borderRadius:10, border:"1px solid #cbd5a7", background:"#cfeaa1", color:"#000", cursor:"pointer" }}>
          {loading ? "Loading…" : "Reload"}
        </button>

        <button onClick={exportCSV}
          style={{ padding:"8px 14px", borderRadius:10, border:"1px solid #cbd5a7", background:"#e6f3c2", color:"#000", cursor:"pointer" }}>
          Export CSV
        </button>

        <button onClick={exportExcel}
          style={{ padding:"8px 14px", borderRadius:10, border:"1px solid #cbd5a7", background:"#bfe080", color:"#000", cursor:"pointer" }}>
          Export Excel
        </button>
      </header>

      {err && (
        <div style={{ background:"#ffefef", border:"1px solid '#e5a5a5'", color:"#900", padding:"10px 12px", borderRadius:10, marginBottom:12, whiteSpace:"pre-wrap", fontSize:12 }}>
          {err}
        </div>
      )}

      {/* table */}
      <div style={{ overflowX:"auto", border:"1px solid #cbd5a7", borderRadius:14 }}>
        <div style={{ display:"grid", gridTemplateColumns:`repeat(${columns.length}, ${colW}px)`, gap:8, minWidth:columns.length*colW, fontSize:13 }}>
          {columns.map(h=>(
            <div key={h} style={headerBox}>{h}</div>
          ))}

          {filtered.map((r, i) => (
            <Fragment key={r.iccid || i}>
              <div style={cellBox(i)}>{r.iccid ?? ""}</div>
              <div style={cellBox(i)}>{r.imsi ?? ""}</div>
              <div style={cellBox(i)}>{r.phoneNumber ?? ""}</div>
              <div style={cellBox(i)}>{r.subscriberStatus ?? ""}</div>
              <div style={cellBox(i)}>{r.simStatus ?? ""}</div>
              <div style={cellBox(i)}>{String(r.esim ?? "")}</div>
              <div style={cellBox(i)}>{r.activationCode ?? ""}</div>
              <div style={cellBox(i)}>{fmtDT(r.activationDate)}</div>
              <div style={cellBox(i)}>{fmtDT(r.lastUsageDate)}</div>
              <div style={cellBox(i)}>{String(r.prepaid ?? "")}</div>
              <div style={cellBox(i)}>{r.balance ?? ""}</div>
              <div style={cellBox(i)}>{r.account ?? ""}</div>
              <div style={cellBox(i)}>{r.reseller ?? ""}</div>
              <div style={cellBox(i)}>{r.lastMcc ?? ""}</div>
              <div style={cellBox(i)}>{r.lastMnc ?? ""}</div>
              <div style={cellBox(i)}>{r.prepaidpackagetemplatename ?? ""}</div>
              <div style={cellBox(i)}>{r.prepaidpackagetemplateid ?? ""}</div>
              <div style={cellBox(i)}>{fmtDT(r.tsactivationutc)}</div>
              <div style={cellBox(i)}>{fmtDT(r.tsexpirationutc)}</div>
              <div style={cellBox(i)}>{r.pckdatabyte ?? ""}</div>
              <div style={cellBox(i)}>{r.useddatabyte ?? ""}</div>
              <div style={cellBox(i)}>{bytesToGB(r.pckdatabyte)}</div>
              <div style={cellBox(i)}>{bytesToGB(r.useddatabyte)}</div>
              <div style={cellBox(i)}>{money(r.subscriberOneTimeCost)}</div>
              <div style={cellBox(i)}>{bytesToGB(r.totalBytesSinceJun1)}</div>
              <div style={cellBox(i)}>{money(r.resellerCostSinceJun1)}</div>
            </Fragment>
          ))}
        </div>
      </div>

      <p style={{ opacity:.7, marginTop:10, fontSize:12, color:"#000" }}>
        Costs: package one-time from template; reseller cost aggregated since <b>2025-06-01</b>. PNL = Subscriber One-Time − Reseller Cost.
      </p>
    </main>
  );
}
