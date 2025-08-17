
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export async function POST(req) {
  const { username, password } = await req.json().catch(() => ({}));
  const USER = process.env.LOGIN_USER || "admin";
  const PASS = process.env.LOGIN_PASS || "Teltrip#2025";

  if (username === USER && password === PASS) {
    cookies().set("session", "ok", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60
    });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ ok: false, error: "Invalid credentials" }, { status: 401 });
}
