/**
 * Plugin bundle archive caps shared by the client uploader and the local
 * materializer route.
 *
 * Mirror of the backend's compressed-bundle cap
 * (mcpjam-backend convex/lib/pluginArchiveLimits.ts, DEFAULT_ARCHIVE_LIMITS).
 * It lives in `shared/` so the two inspector surfaces that enforce it — the
 * pre-upload check and `/api/mcp/plugins/materialize` — cannot drift from each
 * other. The backend re-enforces it at `createImport` and inspect time.
 */
export const MAX_PLUGIN_BUNDLE_COMPRESSED_BYTES = 25 * 1024 * 1024; // 25 MB
