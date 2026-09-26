/**
 * Artifact links in public v1 responses (MJ-005).
 *
 * Private artifacts — screenshots, replay videos, captured widget HTML, tool
 * input/output — reach a v1 caller only as a signed, expiring link on the
 * backend's HTTP origin (`…/web/artifact?t=…`), which the backend serves after
 * verifying it. An artifact field holding anything else is reported the way
 * the backend reports a missing artifact, as `null`, rather than forwarded.
 *
 * The backend origin is the one this server is configured with
 * (`CONVEX_HTTP_URL`) or a Convex-hosted `https://*.convex.site` origin. Links
 * are minted on the backend's own HTTP host, which on a deployment reached
 * through a custom domain is Convex's host rather than the configured one, so
 * a Convex-hosted origin is accepted alongside the configured one.
 */

const ARTIFACT_PATH = "/web/artifact";

function configuredSiteOrigin(): string | null {
  const raw = process.env.CONVEX_HTTP_URL?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** `value` when it is a signed artifact link on the backend origin, else `null`. */
export function publicArtifactLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  if (url.pathname !== ARTIFACT_PATH || !url.searchParams.get("t")) {
    return null;
  }
  const siteOrigin = configuredSiteOrigin();
  const onConfiguredSite = siteOrigin !== null && url.origin === siteOrigin;
  const onConvexSite =
    url.protocol === "https:" && url.hostname.endsWith(".convex.site");
  return onConfiguredSite || onConvexSite ? value : null;
}

/**
 * `row` with each named field that holds a value passed through
 * `publicArtifactLink`. Absent and empty fields are left as they are, and
 * `row` itself comes back when nothing changed.
 */
export function withPublicArtifactLinks<T extends Record<string, unknown>>(
  row: T,
  fields: readonly string[],
): T {
  let copy: Record<string, unknown> | null = null;
  for (const field of fields) {
    const value = row[field];
    if (value === undefined || value === null) continue;
    const link = publicArtifactLink(value);
    if (link === value) continue;
    copy ??= { ...row };
    copy[field] = link;
  }
  return (copy ?? row) as T;
}

/** Where an eval trace envelope carries artifact links, per row array. */
const TRACE_ROW_LINK_FIELDS: Readonly<Record<string, readonly string[]>> = {
  widgetSnapshots: ["widgetHtmlUrl", "toolInputUrl", "toolOutputUrl"],
  widgetRenderObservations: ["screenshotUrl"],
  browserInteractionSteps: ["screenshotUrl"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * An eval trace envelope (`testSuites:getTestIterationBlob`) with its
 * artifact links checked: the iteration's `videoUrl` and the per-row links of
 * its widget snapshots and browser evidence. The transcript and spans are not
 * touched. The envelope itself comes back when nothing changed.
 */
export function withPublicTraceArtifactLinks(envelope: unknown): unknown {
  if (!isRecord(envelope)) return envelope;
  let result = withPublicArtifactLinks(envelope, ["videoUrl"]);
  for (const [key, fields] of Object.entries(TRACE_ROW_LINK_FIELDS)) {
    const rows = result[key];
    if (!Array.isArray(rows)) continue;
    const checked = rows.map((row) =>
      isRecord(row) ? withPublicArtifactLinks(row, fields) : row,
    );
    if (checked.some((row, index) => row !== rows[index])) {
      result = { ...result, [key]: checked };
    }
  }
  return result;
}
