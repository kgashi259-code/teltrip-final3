"use client";
import { useState } from "react";

export default function LoginPage() {
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p }),
      cache: "no-store",
    });
    if (res.ok) window.location.href = "/";
    else {
      const data = await res.json().catch(() => ({}));
      setErr(data?.error || "Invalid credentials");
    }
  };

  return (
    <div style={{
      minHeight: "100svh",
      background: "#f2f6fc",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "column",
      fontFamily: "system-ui"
    }}>
      <img
        src="/logo.png"
        alt="Teltrip Logo"
        style={{ height: 64, marginBottom: 32 }}
      />
      <form onSubmit={submit} style={{
        width: 360,
        padding: 28,
        background: "#ffffff",
        borderRadius: 16,
        boxShadow: "0 15px 40px rgba(0,0,0,0.1)",
        display: "flex",
        flexDirection: "column",
        gap: 16
      }}>
        <h1 style={{ margin: 0, fontSize: 22, color: "#111" }}>Sign in</h1>

        <input
          placeholder="Username"
          value={u}
          onChange={e => setU(e.target.value)}
          required
          style={{
            padding: 12,
            borderRadius: 10,
            border: "1px solid #ccc",
            background: "#fff",
            color: "#111",
            fontSize: 14
          }}
        />

        <input
          type="password"
          placeholder="Password"
          value={p}
          onChange={e => setP(e.target.value)}
          required
          style={{
            padding: 12,
            borderRadius: 10,
            border: "1px solid #ccc",
            background: "#fff",
            color: "#111",
            fontSize: 14
          }}
        />

        {err && <div style={{ color: "#e00", fontSize: 13 }}>{err}</div>}

        <button type="submit" style={{
          padding: 12,
          borderRadius: 10,
          background: "#3b82f6",
          border: "none",
          color: "#fff",
          fontWeight: 600,
          fontSize: 15,
          cursor: "pointer"
        }}>
          Login
        </button>
      </form>
    </div>
  );
}
