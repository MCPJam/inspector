/**
 * Whether a request should be answered with the SPA document rather than a
 * file from `dist/client`.
 *
 * Both production entrypoints mount a catch-all `serveStatic` over `/*` and
 * then an `app.get("*")` that serves `index.html` WITH its injected scripts —
 * runtime config, the session token, the guest bootstrap — and a `no-store`
 * header. Registered in that order, the static handler answers `/` with the
 * raw `index.html` off disk and the injecting handler never runs: hosted
 * documents shipped with none of those scripts and no `no-store` at all.
 *
 * So the static handler has to let document requests fall through. The test is
 * the last path segment's file extension, which every asset in `dist/client`
 * has and no SPA route does (`/`, `/p/<id>/servers`, `/embed/score`). Keep it
 * that way: an extensionless file added under `dist/client` would become
 * unreachable, and a route with a dot in its last segment would 404.
 */
export function isSpaDocumentRequest(path: string): boolean {
  const lastSegment = path.slice(path.lastIndexOf("/") + 1);
  return !lastSegment.includes(".");
}
