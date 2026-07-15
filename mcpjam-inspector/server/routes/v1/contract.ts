/**
 * MCPJam Public API — v1 contract (Inspector gateway).
 *
 * The contract (error-code union, code -> HTTP-status map, internal -> public
 * mapping, and the envelope/pagination builders) now lives in the framework-
 * agnostic `@mcpjam/sdk/public-api` subpath, so the Inspector gateway and the
 * Convex backend can share ONE source of truth. This module re-exports it; the
 * Hono response adapters stay in ./envelope.ts.
 *
 * NOTE: the Convex backend (mcpjam-backend/convex/publicApi/contract.ts) still
 * keeps a byte-identical local copy pending an `@mcpjam/sdk` version bump there.
 * The golden fixtures in ./__fixtures__/ (and the matching backend suite) remain
 * the cross-surface guard until the backend also consumes this subpath — the
 * contract.test.ts in this directory validates the re-exported values against
 * those fixtures.
 */
export * from "@mcpjam/sdk/public-api";
