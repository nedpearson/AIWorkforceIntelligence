import { NextResponse, type NextRequest } from "next/server";
// Lightweight gate: unauthenticated users hitting /app or /admin are redirected to /login.
// Real authorization happens server-side in requireCtx(); this is UX only.
export function middleware(req: NextRequest) {
  const hasSession = req.cookies.getAll().some((c) => c.name.includes("authjs.session-token"));
  const p = req.nextUrl.pathname;
  if ((p.startsWith("/app") || p.startsWith("/admin")) && !hasSession) {
    const url = req.nextUrl.clone(); url.pathname = "/login"; url.searchParams.set("next", p);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}
export const config = { matcher: ["/app/:path*", "/admin/:path*"] };
