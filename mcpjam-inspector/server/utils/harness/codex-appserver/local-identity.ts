/**
 * What identifies the Codex runtime a LOCAL session runs, for the
 * compatibility manifest and the runtime pack.
 *
 * The Claude Code entry pins an npm adapter version. Codex's local adapter is
 * not an npm package: it is MCPJam's own app-server bridge, bundled from this
 * repository, plus an exact `@openai/codex` CLI. So its identity is the
 * bridge bundle's content hash and the pinned CLI version together — and it is
 * compiled into the server bundle, so a packaged Electron app reads it the same
 * way npx does (no build-time define, unlike the Claude adapter's version).
 *
 * What ENFORCES it at run time is not a string comparison but the runtime pack:
 * the provider byte-compares every bootstrap file (bridge, MCP entrypoint,
 * manifest, lockfile) the adapter writes against the verified pack's copy, and
 * refuses the session on any difference. A bridge edit therefore needs a Codex
 * pack bump before local sessions can run it.
 */
import { createHash } from "node:crypto";
import {
  CODEX_APPSERVER_BRIDGE_SOURCE,
  CODEX_APPSERVER_BUNDLE_VERSION,
} from "./bootstrap/generated/codex-appserver-bridge.bundled.js";
import { PINNED_CODEX_VERSION } from "./bridge/app-server-protocol.js";

/** `app-server/<bundle hash>+@openai/codex@<version>`. */
export const CODEX_LOCAL_ADAPTER_IDENTITY = `app-server/${CODEX_APPSERVER_BUNDLE_VERSION}+@openai/codex@${PINNED_CODEX_VERSION}`;

/** sha256 of the bundled `bridge.mjs`, as a pack manifest's `bridgeDigest`. */
export const CODEX_BRIDGE_BUNDLE_DIGEST = `sha256:${createHash("sha256")
  .update(CODEX_APPSERVER_BRIDGE_SOURCE, "utf8")
  .digest("hex")}`;

export { PINNED_CODEX_VERSION };
