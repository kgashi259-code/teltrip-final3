
import { NextResponse } from "next/server";

export function middleware(req) {
  const { pathname } = req.nextUrl;
  const session = req.cookies.get("session")?.value;

  if (
    pathname.startsWith("/_next/") || pathname.startsWith("/public/") ||
    /\.(ico|png|jpg|jpeg|svg|webp|css|js|woff2?)$/.test(pathname)
  ) return NextResponse.next();

  const isLoginPage = pathname === "/login";
  const isLoginApi  = pathname.startsWith("/api/login");
  const isLogoutApi = pathname.startsWith("/api/logout");

  if (isLoginPage || isLoginApi || isLogoutApi) {
    if (session && isLoginPage) {
      const url = req.nextUrl.clone(); url.pathname = "/";
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  if (!session) {
    const url = req.nextUrl.clone(); url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image).*)"] };
