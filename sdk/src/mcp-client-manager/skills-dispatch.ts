/**
 * Skills wire dispatch — the single place that decides whether a given
 * connection speaks `io.modelcontextprotocol/skills` (SEP-2640).
 *
 * Unlike tasks (SEP-2663), skills has exactly ONE wire and no legacy
 * predecessor, so there is no era matrix here. The extension is negotiated
 * connection-level per SEP-2133: BOTH sides declare it in their `initialize`
 * capabilities, and the methods (`skills/list`, `skills/get`,
 * `resources/directory/read`) carry no per-request declaration.
 *
 * The gate is therefore a conjunction, and it is deliberately symmetric:
 *
 *   active = client advertised the extension ∧ server declared it
 *
 * The client half is the **advertise = enforce** rule. MCPJam is a debugger:
 * a connection whose declared capabilities omit the extension must produce
 * ZERO `skills/*` frames, because the whole product claim is that what the
 * user sees in Tracing is what a host with those capabilities would send.
 * Probing an undeclared method "just to see" would be a lie about the
 * emulated client.
 *
 * ## No era gate
 *
 * `skills/list` / `skills/get` appear in NO protocol-version codec — neither
 * the 2025-11-25 in-core registry nor the 2026-07-28 one — exactly like
 * `tasks/update` before its era-gate shadow was needed. The tasks extension
 * needs `tasks-ext-era-gate.ts` because upstream gates OUTBOUND requests whose
 * method IS in a codec but for the wrong era; a method in no codec at all is
 * era-blind and rides `requestWithSchema` on every negotiated version. Two
 * consequences, both intentional:
 *
 *   1. no `FIRST_EXTENSION_VERSION` constant here — a 2025-06-18 server that
 *      declares the extension is served, and `skills-ext.test.ts` pins that
 *      dual-era behavior;
 *   2. nothing in this module reads the negotiated protocol version.
 */

import type { ServerCapabilities } from "@modelcontextprotocol/client";
import type { ClientCapabilityOptions } from "./types.js";

/** Extension id for the SEP-2640 skills extension. */
export const MCP_SKILLS_EXTENSION_ID =
  "io.modelcontextprotocol/skills" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the extension's settings object out of an MCP `capabilities`
 * container, or `undefined` when the extension is not declared.
 *
 * The VALUE must itself be a non-array object: the capability map is
 * `{ [extensionId]: settingsObject }`, so `true` / `"x"` / `[]` / `null` are
 * malformed and do NOT count as a declaration — key presence alone must never
 * be enough to route real `skills/*` traffic. A non-empty object is accepted:
 * SEP-2640 defines exactly one optional setting today (`directoryRead`) and
 * says nothing about future ones, so rejecting unknown keys would be
 * forward-incompatible.
 */
function readSkillsExtensionSettings(
  capabilities: { extensions?: unknown } | undefined
): Record<string, unknown> | undefined {
  const extensions = capabilities?.extensions;
  if (!isRecord(extensions)) {
    return undefined;
  }
  if (
    !Object.prototype.hasOwnProperty.call(extensions, MCP_SKILLS_EXTENSION_ID)
  ) {
    return undefined;
  }
  const settings = extensions[MCP_SKILLS_EXTENSION_ID];
  return isRecord(settings) ? settings : undefined;
}

/**
 * Whether a SERVER declares `io.modelcontextprotocol/skills` in its
 * `initialize` capabilities.
 */
export function serverDeclaresSkillsExtension(
  capabilities: ServerCapabilities | undefined
): boolean {
  return (
    readSkillsExtensionSettings(
      capabilities as { extensions?: unknown } | undefined
    ) !== undefined
  );
}

/**
 * Whether the CLIENT advertised the extension on this connection. Reads the
 * exact capability object the manager handed to `new Client(...)`, so it can
 * never disagree with what went on the wire.
 */
export function clientDeclaresSkillsExtension(
  capabilities: ClientCapabilityOptions | undefined
): boolean {
  return (
    readSkillsExtensionSettings(
      capabilities as { extensions?: unknown } | undefined
    ) !== undefined
  );
}

/**
 * Whether the server opted into the OPTIONAL `resources/directory/read`
 * method by setting `{ directoryRead: true }` in its extension settings.
 *
 * Strict `=== true`: SEP-2640 defines the setting as a boolean, and a
 * truthy-but-not-true value (`"yes"`, `1`) is a malformed declaration. Failing
 * closed here costs one optional convenience method; failing open would send a
 * method the server never agreed to answer.
 */
export function skillsDirectoryReadEnabled(
  capabilities: ServerCapabilities | undefined
): boolean {
  const settings = readSkillsExtensionSettings(
    capabilities as { extensions?: unknown } | undefined
  );
  return settings?.directoryRead === true;
}

/**
 * Everything a caller (route, UI, CLI, chat tool) needs to know about a
 * connection's skills capability, derived in ONE place.
 */
export interface SkillsSupport {
  /** The server declared the extension in its initialize capabilities. */
  declared: boolean;
  /** THIS client advertised the extension on this connection. */
  advertised: boolean;
  /** Server opted into `resources/directory/read`. Implies `declared`. */
  directoryRead: boolean;
  /**
   * The gate every `skills/*` call site must check: mutual declaration.
   * `false` ⇒ the SDK refuses to send, rather than probing.
   */
  active: boolean;
}

const NO_SKILLS_SUPPORT: SkillsSupport = {
  declared: false,
  advertised: false,
  directoryRead: false,
  active: false,
};

/** Resolves the full skills support matrix for a connection. */
export function resolveSkillsSupport(
  clientCapabilities: ClientCapabilityOptions | undefined,
  serverCapabilities: ServerCapabilities | undefined
): SkillsSupport {
  const advertised = clientDeclaresSkillsExtension(clientCapabilities);
  const declared = serverDeclaresSkillsExtension(serverCapabilities);
  if (!advertised && !declared) {
    return { ...NO_SKILLS_SUPPORT };
  }
  return {
    declared,
    advertised,
    // `directoryRead` is a server-side opt-in, but it is only reachable when
    // the extension is actually active — reporting it on a connection this
    // client never declared on would invite a call the gate then refuses.
    directoryRead:
      advertised && declared && skillsDirectoryReadEnabled(serverCapabilities),
    active: advertised && declared,
  };
}
