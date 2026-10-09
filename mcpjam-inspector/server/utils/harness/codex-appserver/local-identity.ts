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
 * What ENFORCES it at run time is not a string comparison but the Inspector
 * layer: the bridge and its MCP entrypoint a local session runs are the ones
 * compiled into THIS Inspector (`local/inspector-layer.ts`), written to a
 * content-addressed directory and re-hashed before every exec, and their
 * digest is part of the launch identity. A bridge edit is therefore an
 * ordinary Inspector change; the Codex pack carries only the CLI.
 */
import { createHash } from "node:crypto";
import {
  CODEX_APPSERVER_BRIDGE_SOURCE,
  CODEX_APPSERVER_BUNDLE_VERSION,
} from "./bootstrap/generated/codex-appserver-bridge.bundled.js";
import { PINNED_CODEX_VERSION } from "./bridge/app-server-protocol.js";

/** `app-server/<bundle hash>+@openai/codex@<version>`. */
export const CODEX_LOCAL_ADAPTER_IDENTITY = `app-server/${CODEX_APPSERVER_BUNDLE_VERSION}+@openai/codex@${PINNED_CODEX_VERSION}`;

/** sha256 of the HOSTED bundled `bridge.mjs` (informational; local sessions
 *  run the Inspector layer's variant, pinned by the layer digest). */
export const CODEX_BRIDGE_BUNDLE_DIGEST = `sha256:${createHash("sha256")
  .update(CODEX_APPSERVER_BRIDGE_SOURCE, "utf8")
  .digest("hex")}`;

export { PINNED_CODEX_VERSION };
