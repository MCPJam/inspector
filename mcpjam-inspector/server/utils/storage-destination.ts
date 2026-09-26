/**
 * A storage destination the backend handed this server for bytes it uploads
 * on a user's behalf (MJ-006): https, or plain http only to a local backend
 * (`npx convex dev`), and never with credentials in the URL. Callers of the
 * upload get the storage id back.
 */
export function isUsableStorageDestination(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && isLoopbackHostname(url.hostname))
    );
  } catch {
    return false;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}
