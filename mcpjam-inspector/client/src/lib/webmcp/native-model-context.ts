/**
 * The browser's WebMCP page API, as much of it as MCPJam actually uses.
 *
 * One narrow seam so the rest of the publisher never touches a global: where
 * the API lives, whether this browser has it at all, and how an MCPJam tool
 * definition becomes a WebMCP descriptor.
 *
 * MEASURED, not assumed. Everything asserted below was probed against the
 * pinned Chromium 151.0.7922.34 (the same build the CDP contract suite in
 * `server/services/webmcp-inspector/__tests__/webmcp-cdp.spike.test.ts` pins):
 *
 *   - `document.modelContext` is the current home; `navigator.modelContext`
 *     is the deprecated alias and is the SAME object at this pin. We read the
 *     documented one and fall back rather than requiring both.
 *   - `registerTool(descriptor, { signal })` returns a Promise that resolves
 *     to `undefined`. There is no `unregisterTool` and no `provideContext`:
 *     aborting the signal passed at registration IS the unregister.
 *   - Registering a name that is already registered REJECTS
 *     (`InvalidStateError: Duplicate tool name`), so a replacement must tear
 *     the old registration down first and wait for it.
 *   - The `execute` callback receives NO second argument at this pin. The
 *     spec'd `(args, { signal })` shape arrives in a later Chromium, so we
 *     read it defensively and use it when it shows up.
 *
 * WebMCP ships behind an origin trial / feature flag, so on a stock profile
 * none of this exists — `resolveNativeModelContext` returns null and MCPJam's
 * own agent is unaffected. See `docs/webmcp-native-tools.md`.
 */

import type { UiToolDefinition } from "./ui-tools-registry";

/**
 * The three hints Chrome's secure-tools guidance asks a page to publish
 * (https://developer.chrome.com/docs/ai/webmcp/secure-tools). All three are
 * stated explicitly on every tool MCPJam publishes: an omitted hint reads as
 * `false`, and "we never said" is not the same claim as "no".
 */
export interface NativeToolAnnotations {
  readOnlyHint: boolean;
  untrustedContentHint: boolean;
  consequentialHint: boolean;
}

export interface NativeToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: NativeToolAnnotations;
  execute: (args: unknown, ctx?: { signal?: AbortSignal }) => Promise<unknown>;
}

export interface NativeRegisterToolOptions {
  /** Aborting this is how a tool is unregistered. */
  signal?: AbortSignal;
  /**
   * Deliberately never set. `exposedTo` hands a tool to OTHER origins'
   * agents; MCPJam's tools drive the user's own inspector session and have no
   * business being callable from someone else's page.
   */
  exposedTo?: never;
}

export interface NativeModelContext {
  registerTool(
    descriptor: NativeToolDescriptor,
    options?: NativeRegisterToolOptions,
  ): Promise<unknown> | unknown;
}

export type NativeModelContextHome = "document" | "navigator";

export interface ResolvedNativeModelContext {
  api: NativeModelContext;
  home: NativeModelContextHome;
}

function readCandidate(host: unknown): NativeModelContext | null {
  const candidate = (host as { modelContext?: unknown } | null | undefined)
    ?.modelContext;
  if (!candidate || typeof candidate !== "object") return null;
  // CAPABILITY check, not a presence check: `navigator.modelContext` has
  // already been one shape and then another, and some environments define the
  // property as a stub. The only thing that matters is whether we can
  // register a tool through it.
  const { registerTool } = candidate as { registerTool?: unknown };
  if (typeof registerTool !== "function") return null;
  return candidate as NativeModelContext;
}

/**
 * The page's WebMCP API, or null when this browser has none.
 *
 * Null is a completely normal answer — no WebMCP build, the origin trial not
 * activated, a non-Chromium browser, a test environment, SSR. Callers publish
 * nothing and say nothing; MCPJam's in-app agent keeps working through its
 * own transport either way.
 */
export function resolveNativeModelContext(): ResolvedNativeModelContext | null {
  if (typeof globalThis === "undefined") return null;
  const documentApi =
    typeof document === "undefined" ? null : readCandidate(document);
  if (documentApi) return { api: documentApi, home: "document" };
  const navigatorApi =
    typeof navigator === "undefined" ? null : readCandidate(navigator);
  if (navigatorApi) return { api: navigatorApi, home: "navigator" };
  return null;
}

/**
 * MCP tool annotations → the WebMCP hints, per tool.
 *
 * `readOnlyHint` is a straight copy. The other two are the interesting ones:
 *
 * `untrustedContentHint` is NOT derived — it is read off the definition's own
 * `nativePublication`, because "can this result contain somebody else's
 * bytes?" is not answerable from the MCP hints: `ui_snapshot_app` is
 * read-only, closed-world, and still returns a screen showing a third-party
 * server's tool output. A definition that somehow reaches here without saying
 * gets `true`, the cautious reading.
 *
 * `consequentialHint` IS derived, from the annotations the catalog already
 * curates: destructive actions (delete something, spend quota, consume billed
 * infrastructure), plus mutating actions that reach an external system
 * (`openWorldHint`) — connecting a server, running one of its tools. A
 * read-only tool is never consequential even when it reads across the network:
 * Chrome's guidance is about real-world consequences, and gating reads would
 * teach the user to click through the prompts that matter. An absent
 * `destructiveHint` counts as destructive, matching the protocol's pessimistic
 * default and the approval floor MCPJam already applies.
 */
export function nativeAnnotationsFor(
  def: UiToolDefinition,
): NativeToolAnnotations {
  const readOnly = def.annotations?.readOnlyHint ?? def.readOnly;
  const destructive = def.annotations?.destructiveHint !== false;
  const openWorld = def.annotations?.openWorldHint === true;
  return {
    readOnlyHint: readOnly,
    untrustedContentHint:
      def.nativePublication?.kind === "publish"
        ? def.nativePublication.untrustedContent
        : true,
    consequentialHint: destructive || (openWorld && !readOnly),
  };
}

/** The descriptor for one tool, minus the callback the publisher supplies. */
export function nativeDescriptorFor(
  def: UiToolDefinition,
  execute: NativeToolDescriptor["execute"],
): NativeToolDescriptor {
  return {
    name: def.name,
    description: def.description,
    // Blink derives the agent-facing parameter list from this, and a missing
    // schema is not the same as "no parameters".
    inputSchema: def.inputSchema ?? { type: "object", properties: {} },
    annotations: nativeAnnotationsFor(def),
    execute,
  };
}
