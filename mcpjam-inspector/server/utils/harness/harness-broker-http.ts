/** The Convex HTTP origin and bearer form every harness broker call uses. */

export function getConvexHttpUrl(): string {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) {
    throw new Error("CONVEX_HTTP_URL is required for harness model broker");
  }
  return convexHttpUrl;
}

export function bearerHeader(bearer: string): string {
  const trimmed = bearer.trim();
  return /^Bearer\s/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}
