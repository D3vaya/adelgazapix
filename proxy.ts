import { NextRequest, NextResponse } from "next/server";

/**
 * Optional protection layers.
 * If env vars are not set, the middleware passes everything through (dev/open mode).
 * If set, it enforces.
 */
const AUTH_USER = process.env.ACCESS_USER;
const AUTH_PASS = process.env.ACCESS_PASS;

/**
 * Origin allowlist. Comma-separated list in ALLOWED_ORIGIN env var.
 * Example:
 *   ALLOWED_ORIGIN=https://adelgazapix.vercel.app,http://localhost:3000
 *
 * When the proxy runs on Vercel, the deployment's own URLs are added
 * automatically — no need to track preview URLs by hand:
 *   - VERCEL_URL                     (current deployment, e.g. adelgazapix-abc123.vercel.app)
 *   - VERCEL_PROJECT_PRODUCTION_URL  (production alias, e.g. adelgazapix.vercel.app)
 *   - VERCEL_BRANCH_URL              (branch URL)
 *
 * In dev (NODE_ENV !== "production"), any `http://localhost:*` is allowed.
 * If ALLOWED_ORIGIN is unset, the Origin check is disabled entirely.
 */
const EXPLICIT_ORIGINS = (process.env.ALLOWED_ORIGIN ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const VERCEL_ORIGINS = [
  process.env.VERCEL_URL,
  process.env.VERCEL_PROJECT_PRODUCTION_URL,
  process.env.VERCEL_BRANCH_URL,
]
  .filter((u): u is string => Boolean(u))
  .map((u) => `https://${u}`);

const ALLOWED_ORIGINS =
  EXPLICIT_ORIGINS.length > 0 ? [...EXPLICIT_ORIGINS, ...VERCEL_ORIGINS] : [];

const IS_DEV = process.env.NODE_ENV !== "production";
const REALM = "Adelgazapix";

export const config = {
  /**
   * Run on every request EXCEPT Next internals and the favicon.
   * Static files in /public still go through proxy (so Basic Auth covers logos).
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

function isAllowedOrigin(source: string): boolean {
  if (!source) return false;
  if (IS_DEV && /^http:\/\/localhost(:\d+)?(\/|$)/.test(source)) return true;
  return ALLOWED_ORIGINS.some((allowed) => source.startsWith(allowed));
}

export function proxy(req: NextRequest) {
  // ---- Basic Auth gate (whole site) ----
  if (AUTH_USER && AUTH_PASS) {
    const auth = req.headers.get("authorization");
    const expected = "Basic " + btoa(`${AUTH_USER}:${AUTH_PASS}`);
    if (auth !== expected) {
      return new NextResponse("Authentication required", {
        status: 401,
        headers: {
          "WWW-Authenticate": `Basic realm="${REALM}", charset="UTF-8"`,
          "Cache-Control": "no-store",
        },
      });
    }
  }

  // ---- Origin allowlist (state-changing methods only) ----
  if (
    ALLOWED_ORIGINS.length > 0 &&
    (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE")
  ) {
    const origin = req.headers.get("origin");
    const referer = req.headers.get("referer");
    const source = origin ?? referer ?? "";
    if (!isAllowedOrigin(source)) {
      return new NextResponse(
        JSON.stringify({ error: { code: "FORBIDDEN_ORIGIN", message: "Origin not allowed." } }),
        {
          status: 403,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        },
      );
    }
  }

  return NextResponse.next();
}
