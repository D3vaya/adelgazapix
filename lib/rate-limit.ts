import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

/**
 * Lazy singleton: created once per cold-start, only if Upstash env vars are set.
 * If they're not set, `getRatelimit()` returns null and the route handler skips
 * the check (dev/open mode).
 */
let cached: Ratelimit | null | undefined;

export function getRatelimit(): Ratelimit | null {
  if (cached !== undefined) return cached;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    cached = null;
    return null;
  }

  cached = new Ratelimit({
    redis: new Redis({ url, token }),
    /** 20 image uploads per minute per IP, sliding window. */
    limiter: Ratelimit.slidingWindow(20, "1 m"),
    analytics: true,
    prefix: "adelgazapix",
  });
  return cached;
}

/** Best-effort client IP — falls back to a constant when unknown so we still limit. */
export function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") ?? "anonymous";
}
