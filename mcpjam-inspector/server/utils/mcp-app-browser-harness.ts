/**
 * mcp-app-browser-harness.ts — headless-Chromium host harness for MCP App evals.
 *
 * Browser-rendered MCP App eval PR 3. Mounts a widget's UI resource in a real
 * (headless Playwright) browser running the production host bridge (PR 1, via
 * the esbuild-bundled `host-page.ts`) so the eval can answer two questions an
 * inert HTML snapshot never could:
 *
 *   1. Renderability — did the widget actually mount + handshake + paint?
 *      (`renderWidget` → {@link WidgetRenderObservation}).
 *   2. User-mimicry — can a driver click/type and observe the next state, with
 *      widget-initiated `tools/call` captured? (`executeAction`).
 *
 * Lifecycle: one harness per eval iteration. Construction is cheap; Chromium is
 * launched lazily on the first `renderWidget` so prompt-only / server-tool-only
 * iterations pay zero browser cost. If Chromium is not installed the harness
 * throws {@link ChromiumNotInstalledError}; the eval runner catches it, records
 * `browser_unavailable`, and falls back to the HTML snapshot path.
 *
 * Isolation: each harness uses a fresh `BrowserContext` (no shared cookies /
 * storage), downloads off, no granted permissions, a one-tab limit, and a
 * default-deny network route with a small allowlist.
 */

import { existsSync } from "fs";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type {
  Browser,
  BrowserContext,
  FrameLocator,
  Locator,
  Page,
} from "playwright";
import type {
  ElementLocator,
  ScriptedStep,
  StepAssertion,
} from "@/shared/scripted-steps";
import {
  buildSandboxProxyWidgetCsp,
  sanitizeProxyDomain,
} from "./sandbox-proxy-csp";
import { HARNESS_PAGE_BUNDLE } from "./browser-harness/HarnessPageBundle.generated";
import {
  ensureLocalChromiumInstalled,
  isChromiumInstalled,
} from "./browser-rendering-setup";
import { HOSTED_MODE } from "../config";

export { isChromiumInstalled };

const BROWSER_CLOSE_TIMEOUT_MS = 5_000;

async function waitForClose(task: Promise<unknown> | undefined): Promise<void> {
  if (!task) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      task.catch(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, BROWSER_CLOSE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/* ------------------------------------------------------------------ *
 * Contract types
 * ------------------------------------------------------------------ */

export type WidgetRenderStatus =
  | "rendered"
  | "no_ui_resource"
  | "resource_read_failed"
  | "mount_failed"
  | "bridge_timeout"
  | "render_error"
  | "blank_screenshot"
  | "screenshot_failed"
  | "browser_unavailable";

export interface WidgetRenderObservation {
  toolCallId: string;
  toolName: string;
  serverId: string;
  status: WidgetRenderStatus;
  resourceUri?: string;
  bridgeInitialized?: boolean;
  /** Raw screenshot bytes (base64 PNG/JPEG). PR 6 uploads this to a blob. */
  screenshotBase64?: string;
  consoleErrors?: string[];
  blockedRequests?: string[];
  /** `ui/message` follow-ups a widget emitted DURING render (auto-send-on-
   *  render). The runner drains these as model-continuation turns. Distinct
   *  from render-time tool calls, which are not action results and are dropped. */
  followUps?: string[];
  elapsedMs: number;
  ts: number;
}

/** A Computer Use action subset the harness can apply via Playwright. */
export interface BrowserActionSpec {
  action:
    | "screenshot"
    | "left_click"
    | "double_click"
    | "right_click"
    | "mouse_move"
    | "type"
    | "key"
    | "scroll"
    | "wait";
  coordinate?: [number, number];
  text?: string;
  scrollDirection?: "up" | "down" | "left" | "right";
  scrollAmount?: number;
  duration?: number;
}

export interface WidgetToolCall {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  error?: string;
  elapsedMs: number;
  /**
   * Raw MCP `CallToolResult` the server returned (success path only). Carried so
   * the eval trace can render the widget call's output and so a model-visible
   * call can be normalized into the model's context. Sanitized at the trace
   * boundary; never sent to the model without the `_meta`/`structuredContent`
   * scrub (see `scrubMetaAndStructuredContentFromToolResult`).
   */
  result?: unknown;
  /**
   * SEP-1865 `_meta.ui.visibility` for the called tool, resolved at dispatch.
   * `undefined` ⇒ the spec default `["model", "app"]` (model-visible). An
   * explicit `["app"]` marks a UI-only call that must NOT enter model context.
   */
  visibility?: Array<"model" | "app">;
}

export interface BrowserActionResult {
  action: BrowserActionSpec;
  /** base64 screenshot after the action settled (within the byte budget). */
  screenshotBase64?: string;
  widgetToolCalls: WidgetToolCall[];
  elapsedMs: number;
  /**
   * Set when a budget/limit forced a no-op. One of `"no_rendered_widget"`,
   * `"step_budget_exceeded"` (per-widget step cap hit — widget force-dismissed),
   * or `"screenshot_budget_exceeded"` (per-iteration screenshot cap hit — widget
   * left mounted).
   */
  note?: string;
}

/** Playwright frame selector for the single mounted widget iframe (host-page.ts
 *  mounts it under `#mcpjam-widget-root`). */
const WIDGET_IFRAME_SELECTOR = "#mcpjam-widget-root iframe";
/** Per-step Playwright action/assertion timeout. Bounds a failing locator so a
 *  bad selector fails the step instead of hanging the whole run. */
const SCRIPTED_STEP_TIMEOUT_MS = 4_000;

/** Result of one scripted interaction step (PR: Widget interaction checks). */
export interface ScriptedStepResult {
  step: ScriptedStep;
  /** Action steps: executed without error. Assert steps: assertion held. */
  ok: boolean;
  /** Failure detail for a failed assertion or an action that errored. */
  reason?: string;
  /** base64 screenshot after the step settled. */
  screenshotBase64?: string;
  /** Widget→host tool calls drained DURING this step (caller accumulates). */
  widgetToolCalls: WidgetToolCall[];
  /** `ui/message` follow-up text the widget emitted DURING this step, in order. */
  followUps: string[];
  elapsedMs: number;
  /** `"no_rendered_widget"` when no widget is mounted. */
  note?: string;
}

export interface HarnessBudgets {
  /** Per-rendered-widget cap on `executeAction` calls before forced dismiss. */
  maxBrowserStepsPerWidget: number;
  /** Hard cap on a screenshot's bytes; re-encoded as lower-quality JPEG if over. */
  screenshotMaxBytes: number;
  /** After each action, wait min(network idle, this) + 50ms before screenshot. */
  settleTimeoutMs: number;
  /** During render, wait this long for iframe load + bridge init. */
  renderTimeoutMs: number;
  /**
   * After the bridge handshakes, wait up to this long for the widget to
   * actually PAINT before snapshotting. Handshaking is not painting:
   * data-driven widgets (e.g. Excalidraw) only render after they receive tool
   * data and fetch their code from a CDN, so without this the classifier races
   * the first paint and renderability becomes a function of CDN cache warmth.
   * Returns as soon as the widget paints, so only genuinely-blank widgets wait
   * the full budget.
   */
  paintTimeoutMs: number;
  /** Circuit breaker: total screenshots per iteration. */
  totalScreenshotsPerIteration: number;
}

export const DEFAULT_HARNESS_BUDGETS: HarnessBudgets = {
  maxBrowserStepsPerWidget: 12,
  screenshotMaxBytes: 256 * 1024,
  settleTimeoutMs: 2000,
  renderTimeoutMs: 3000,
  paintTimeoutMs: 8000,
  totalScreenshotsPerIteration: 60,
};

/** Fixed viewport at 1x CSS pixels — the model's coordinate space == screenshot
 *  pixel space. deviceScaleFactor MUST stay 1 (HiDPI scaling is the #1 cause of
 *  off-by-N click misses with Computer Use). */
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

export class ChromiumNotInstalledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChromiumNotInstalledError";
  }
}

export interface RenderWidgetInput {
  toolCallId: string;
  toolName: string;
  serverId: string;
  /** Widget resource HTML (OpenAI-compat injected upstream if required). */
  html: string;
  resourceUri?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  /** SEP-1865 sandbox inputs forwarded to the in-page policy resolver. */
  permissions?: Record<string, unknown>;
  sandboxAttrs?: string[];
  allowFeatures?: Record<string, string>;
  /**
   * Widget-declared CSP (normalized from the UI resource's `_meta.ui.csp` /
   * legacy `_meta["openai/widgetCSP"]`, same shape as the SDK's
   * `WidgetCspMeta`). Enforced two ways for this widget's mount lifetime: the
   * harness injects the production sandbox proxy's exact widget-declared policy
   * as an in-iframe `<meta>` CSP (directive-precise — fetch vs script/font/img
   * vs frame; see {@link buildSandboxProxyWidgetCsp}), and the network route
   * additionally treats these origins as a coarse "may egress" allowlist.
   * Omitted/empty yields the SEP restrictive default (`default-src 'none'`).
   */
  cspMeta?: {
    connect_domains?: string[];
    resource_domains?: string[];
    frame_domains?: string[];
  };
  /** Keep the widget mounted for subsequent executeAction calls. */
  keepMounted?: boolean;
}

export interface McpAppBrowserHarnessOptions {
  /** Dispatch a widget-initiated tools/call (app->host). */
  callTool: (
    serverId: string,
    name: string,
    args: Record<string, unknown>
  ) => Promise<unknown>;
  /**
   * Resolve the SEP-1865 `_meta.ui.visibility` for a tool at dispatch time, so
   * the runner can route model-visible calls into model context and keep
   * app-only calls (refresh buttons, form submits) out of it. Returning
   * `undefined` (or omitting the option) means "unknown" — the runner treats
   * that as the spec default `["model", "app"]`.
   */
  resolveToolVisibility?: (
    serverId: string,
    name: string
  ) => Array<"model" | "app"> | undefined;
  /** Host capabilities advertised in ui/initialize. Sensible default below. */
  hostCapabilities?: Record<string, unknown>;
  hostInfo?: { name: string; version: string };
  viewport?: { width: number; height: number };
  budgets?: Partial<HarnessBudgets>;
  /** Extra http(s) origins to allow through the default-deny network route. */
  allowOrigins?: string[];
  /**
   * Block egress to loopback/RFC-1918/CGNAT/ULA ranges (the SSRF guard's
   * private-network tier). Link-local + cloud-metadata are blocked regardless.
   * Defaults to {@link HOSTED_MODE}: on for our servers, off for local dev so a
   * widget can still reach a localhost MCP server.
   */
  blockPrivateNetworks?: boolean;
}

/**
 * Match a URL against one CSP host-source expression, at origin granularity:
 * scheme (when given), host (with `*.` wildcard subdomains), and port. Paths
 * in host-sources are deliberately ignored — the real CSP inside the widget
 * iframe still enforces them; this gate only decides whether the request may
 * leave the harness at all. Quoted keywords (`'self'`, `'unsafe-inline'`, …)
 * never match: "self" for a srcdoc widget is the loopback host page, which
 * the gate's standing rules already cover.
 *
 * Scheme handling mirrors CSP: a scheme-only source (`https:`) allows any
 * host on that scheme; a scheme-less host-source matches http(s)/ws(s).
 */
export function cspSourceMatchesUrl(source: string, url: URL): boolean {
  const src = source.trim();
  if (!src || src.startsWith("'")) return false;

  // Scheme-only source, e.g. "https:".
  if (/^[a-z][a-z0-9+.-]*:$/i.test(src)) {
    return url.protocol.toLowerCase() === src.toLowerCase();
  }

  let scheme: string | undefined;
  let rest = src;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(src);
  if (schemeMatch) {
    scheme = `${schemeMatch[1].toLowerCase()}:`;
    rest = src.slice(schemeMatch[0].length);
  }
  const slash = rest.indexOf("/");
  if (slash !== -1) rest = rest.slice(0, slash);
  if (!rest) return false;

  let port: string | undefined;
  let hostPattern = rest;
  const portMatch = /^(.+):(\d+|\*)$/.exec(rest);
  if (portMatch) {
    hostPattern = portMatch[1];
    port = portMatch[2];
  }

  if (scheme) {
    if (url.protocol.toLowerCase() !== scheme) return false;
  } else if (!/^(https?:|wss?:)$/.test(url.protocol)) {
    return false;
  }

  // Port matching (CSP semantics): `*` = any port; an explicit port must equal
  // the URL's port; an OMITTED source port matches only the scheme's default
  // port (so `https://api.example.com` matches `:443`/default but not `:8443`).
  if (port !== "*") {
    const defaultPort =
      url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80";
    const urlPort = url.port || defaultPort;
    if (urlPort !== (port ?? defaultPort)) return false;
  }

  const host = url.hostname.toLowerCase();
  const pattern = hostPattern.toLowerCase();
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) return host.endsWith(pattern.slice(1));
  return host === pattern;
}

/** Parse a dotted-quad IPv4 literal into octets, or null if not well-formed. */
function parseIpv4Octets(
  host: string
): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const o = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (o.some((n) => n > 255)) return null;
  return [o[0], o[1], o[2], o[3]];
}

/**
 * SSRF guard for the egress route. A widget's declared CSP origins (and the
 * loopback shortcut) must never let it reach infrastructure only the harness
 * HOST can see — most dangerously the cloud metadata endpoint
 * (169.254.169.254), whose IAM credentials would be a full account compromise.
 * In production the same widget CSP runs in the END USER's browser, where these
 * addresses are harmless; in the eval harness it runs on our servers, so this
 * gate overrides the allowlist regardless of what the widget declared.
 *
 *   - ALWAYS blocked: cloud-metadata names, IPv4/IPv6 link-local (169.254/16,
 *     fe80::/10), and the unspecified address (0.0.0.0/8, ::) — never a
 *     legitimate widget target in any deployment.
 *   - Blocked only when `blockPrivate` (hosted mode): loopback, RFC-1918
 *     private, CGNAT (100.64/10), and IPv6 ULA (fc00::/7). Left reachable for
 *     local dev, where a widget legitimately talks to a localhost MCP server.
 *
 * Matches on the URL hostname (literal IPs range-checked); it does NOT resolve
 * DNS, so a name that resolves to an internal IP (DNS rebinding) is out of
 * scope here and must be covered by infra-level egress policy.
 */
export function isBlockedEgressHost(
  hostname: string,
  blockPrivate: boolean
): boolean {
  let host = hostname.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) return false;

  // Cloud metadata DNS aliases (they resolve to link-local, but block the
  // names too in case resolution is bypassed).
  if (host === "metadata.google.internal" || host === "metadata.goog") {
    return true;
  }
  if (host === "localhost" || host.endsWith(".localhost")) return blockPrivate;

  const v4 = parseIpv4Octets(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
    if (a === 0) return true; // "this network" / unspecified
    if (!blockPrivate) return false;
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    return false;
  }

  if (host.includes(":")) {
    // IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254) — judge the embedded v4.
    const mapped = /(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/.exec(host);
    if (mapped) return isBlockedEgressHost(mapped[1], blockPrivate);
    if (host === "::") return true; // unspecified
    if (/^fe[89ab]/.test(host)) return true; // link-local fe80::/10
    if (!blockPrivate) return false;
    if (host === "::1") return true; // loopback
    if (/^f[cd]/.test(host)) return true; // ULA fc00::/7
    return false;
  }

  return false;
}

/**
 * Per-render cap on collected diagnostics. `consoleErrors` and
 * `blockedRequests` are WIDGET-controlled — a widget decides what it logs and
 * how many blocked requests it triggers — so without a bound a buggy or hostile
 * widget can grow them without limit: harness memory during the render, and,
 * once persisted, the iteration's Convex document (overflowing its ~1MB limit
 * would drop the whole record for that run). Entries past the cap are dropped
 * after a single sentinel marker; each entry is length-truncated.
 */
export const MAX_DIAGNOSTIC_ENTRIES = 50;
export const MAX_DIAGNOSTIC_ENTRY_CHARS = 2000;

/** Append to a bounded diagnostics array (see {@link MAX_DIAGNOSTIC_ENTRIES}). */
export function pushBoundedDiagnostic(arr: string[], value: string): void {
  if (arr.length > MAX_DIAGNOSTIC_ENTRIES) return;
  if (arr.length === MAX_DIAGNOSTIC_ENTRIES) {
    arr.push("… additional entries suppressed (limit reached)");
    return;
  }
  arr.push(
    value.length > MAX_DIAGNOSTIC_ENTRY_CHARS
      ? `${value.slice(0, MAX_DIAGNOSTIC_ENTRY_CHARS)}…`
      : value
  );
}

/**
 * Inject a `<meta http-equiv="Content-Security-Policy">` as the FIRST child of
 * `<head>` so the browser enforces the widget's declared policy at directive
 * granularity inside the iframe — the headless analog of the sandbox proxy's
 * CSP injection. First-in-head matters: a meta CSP only governs resources
 * parsed after it, and `guestDoc.write(html)` parses top-down.
 *
 * Falls back to creating a `<head>` (or prepending) when the document omits
 * one, so even minimal widget HTML is governed rather than running unpoliced.
 *
 * `cspContent` is derived from widget-controlled metadata (the declared domain
 * arrays are joined verbatim into the policy), so it is HTML-attribute-escaped
 * before interpolation: a stray `"` must not be able to break out of
 * `content="…"` and truncate or disable the policy we are injecting. A
 * well-formed CSP never contains `&"<>`, so this is a no-op for real policies.
 */
export function injectCspMeta(html: string, cspContent: string): string {
  const escaped = cspContent
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const tag = `<meta http-equiv="Content-Security-Policy" content="${escaped}">`;
  const headOpen = /<head\b[^>]*>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const htmlOpen = /<html\b[^>]*>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return html.slice(0, at) + `<head>${tag}</head>` + html.slice(at);
  }
  return tag + html;
}

// Paint detection (see `waitForWidgetPaint`) compares whole-frame PNG
// screenshots byte-for-byte. Chromium encodes identical pixels to identical
// bytes, so a plain Buffer compare is a reliable "did these two frames differ"
// test — no image decoding, and therefore no native-image dependency dragged
// into the server bundle.
function framesEqual(a: Buffer | null, b: Buffer | null): boolean {
  return !!a && !!b && a.length === b.length && a.equals(b);
}

// SEP-1865 host capabilities are declared as OBJECTS (an empty `{}` means
// "supported"), not booleans — the guest's ui/initialize schema rejects
// booleans. Empty objects are still truthy, so the capability gating in
// `registerHostBridgeHandlers` (which checks `caps.message` etc.) is unaffected.
const DEFAULT_HOST_CAPABILITIES = {
  message: {},
  openLinks: {},
  serverTools: {},
  serverResources: {},
  logging: {},
  updateModelContext: {},
  downloadFile: {},
} as const;

interface MountedWidget {
  serverId: string;
  actionCount: number;
}

export class McpAppBrowserHarness {
  private readonly opts: McpAppBrowserHarnessOptions;
  private readonly budgets: HarnessBudgets;
  private readonly viewport: { width: number; height: number };

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  /**
   * Screenshot of the empty host page, captured once before the first widget
   * mounts. The host background + viewport are invariant, so this is the
   * "nothing painted" reference every render's paint check diffs against. A
   * widget that paints anything diverges from it; one that paints nothing
   * stays identical to it (→ blank_screenshot).
   */
  private blankReference: Buffer | null = null;

  private readonly mounted = new Map<string, MountedWidget>();
  /**
   * CSP sources declared by the CURRENTLY mounted widget (renderWidget sets,
   * unmount/dispose clear). Lives on the instance — not closed over at launch —
   * because the network route outlives any single widget while the allowlist
   * must follow the widget. Fail-closed: between widgets this is empty and the
   * gate falls back to loopback + configured `allowOrigins` only.
   */
  private widgetCspSources: string[] = [];
  private consoleErrors: string[] = [];
  private blockedRequests: string[] = [];
  private toolCallBuffer: WidgetToolCall[] = [];
  /** In-flight app->host RPC count, so an action waits for slow tool calls. */
  private pendingRpcCount = 0;
  /**
   * `ui/message` follow-up text emitted by widgets, drained per action (like
   * {@link toolCallBuffer}). The runner replays each as a new user turn.
   */
  private followUpBuffer: string[] = [];
  private screenshotCount = 0;
  /**
   * Temp dir Playwright writes this iteration's `.webm` replay into. Created in
   * `ensureLaunched`; deleted in `dispose`. `null` until the harness launches
   * (prompt-only iterations never record).
   */
  private videoDir: string | null = null;
  /**
   * Wall-clock (`Date.now()`) the replay recording started — stamped right after
   * the recording context is created in `ensureLaunched`. The seam that lets the
   * replay UI map an artifact's `ts` to a video position
   * (`videoOffsetMs = step.ts - recordingStartedAt`). `null` until launch.
   */
  private recordingStartedAt: number | null = null;
  /**
   * Memoized terminal-artifact collection. `collectVideo()` runs at most once
   * effectively: after the first call `videoCollected` is set and the cached
   * `videoBytes` (bytes or `null`) is returned, so repeat calls and a later
   * `dispose()` are safe no-ops. This is the idempotency the runner relies on.
   */
  private videoCollected = false;
  private videoBytes: Buffer | null = null;
  /** SSRF guard's private-network tier (see {@link isBlockedEgressHost}). */
  private readonly blockPrivateNetworks: boolean;

  constructor(opts: McpAppBrowserHarnessOptions) {
    this.opts = opts;
    this.budgets = { ...DEFAULT_HARNESS_BUDGETS, ...(opts.budgets ?? {}) };
    this.viewport = opts.viewport ?? { ...DEFAULT_VIEWPORT };
    this.blockPrivateNetworks = opts.blockPrivateNetworks ?? HOSTED_MODE;
  }

  hasRenderedWidget(): boolean {
    return this.mounted.size > 0;
  }

  /** Wall-clock the replay recording started, or `null` before launch. The
   *  replay origin for per-artifact `videoOffsetMs` math. */
  getRecordingStartedAt(): number | null {
    return this.recordingStartedAt;
  }

  /**
   * The tool-call id of the single currently-mounted widget, or `null`.
   *
   * The harness keeps at most one widget mounted at a time (`renderWidget`
   * clears any prior mount before mounting the next), so this is the single
   * source of truth for "which widget is live". Callers (the eval runner) gate
   * Computer Use on this instead of tracking their own active-widget id, which
   * could drift across prompt turns or after a `finish_widget` dismiss.
   */
  getMountedWidgetId(): string | null {
    const first = this.mounted.keys().next();
    return first.done ? null : first.value;
  }

  /* ---- launch ---- */

  // Overridable for tests (force the binary-missing path without uninstalling
  // Chromium). Prefer the runtime `playwright` package; fall back to
  // `playwright-core` (present transitively).
  protected async loadChromium(): Promise<{
    executablePath: () => string;
    launch: (opts: { headless: boolean; args?: string[] }) => Promise<Browser>;
  }> {
    try {
      return (await import("playwright")).chromium;
    } catch {
      return (await import("playwright-core")).chromium;
    }
  }

  private async ensureLaunched(): Promise<void> {
    if (this.page) return;
    const chromium = await this.loadChromium();

    let executablePath: string | undefined;
    try {
      executablePath = chromium.executablePath();
    } catch {
      executablePath = undefined;
    }
    if (!executablePath || !existsSync(executablePath)) {
      await ensureLocalChromiumInstalled({ reason: "render" });
      try {
        executablePath = chromium.executablePath();
      } catch {
        executablePath = undefined;
      }
    }

    if (!executablePath || !existsSync(executablePath)) {
      throw new ChromiumNotInstalledError(
        "Chromium is not installed for Playwright. Run `npx playwright install chromium`."
      );
    }

    try {
      // `--no-sandbox` is required when running as root (CI / containers);
      // `--disable-dev-shm-usage` avoids /dev/shm exhaustion crashes there.
      this.browser = await chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Executable doesn't exist|please run|install/i.test(msg)) {
        throw new ChromiumNotInstalledError(msg);
      }
      throw err;
    }

    // Record a `.webm` of the iteration for replay. Best-effort: if the temp
    // dir can't be made we simply skip recording (collectVideo → null) rather
    // than failing the whole render path.
    try {
      this.videoDir = await mkdtemp(join(tmpdir(), "mcpjam-eval-video-"));
    } catch {
      this.videoDir = null;
    }

    // Fresh, locked-down context per iteration.
    this.context = await this.browser.newContext({
      viewport: this.viewport,
      deviceScaleFactor: 1,
      acceptDownloads: false,
      permissions: [],
      // Replay video. `size` MUST match the viewport so the recording's pixel
      // space lines up with the captured screenshots / click coordinates.
      ...(this.videoDir
        ? { recordVideo: { dir: this.videoDir, size: this.viewport } }
        : {}),
    });
    // Recording begins when the context is created — stamp the origin so the
    // replay UI can map each artifact's `ts` to a video offset. Only meaningful
    // when a video dir was set; harmless otherwise.
    this.recordingStartedAt = Date.now();

    // COARSE default-deny egress backstop: loopback + configured origins
    // (static for the harness lifetime) + the mounted widget's declared CSP
    // origins as one flat union (per-widget, see `widgetCspSources`). This is
    // intentionally directive-blind — the injected in-iframe `<meta>` CSP does
    // the connect/resource/frame separation; the route just decides whether a
    // request may leave the machine, and records the rest. Non-network schemes
    // (data:, blob:, about:) pass through.
    const allowOrigins = new Set(this.opts.allowOrigins ?? []);
    await this.context.route("**/*", (route) => {
      const url = route.request().url();
      if (
        url.startsWith("data:") ||
        url.startsWith("blob:") ||
        url.startsWith("about:")
      ) {
        return route.continue();
      }
      try {
        const parsed = new URL(url);
        const host = parsed.hostname;
        // SSRF guard — OVERRIDES the allowlist below. A widget-declared origin
        // (or the loopback shortcut) must never reach host-only infrastructure:
        // cloud metadata + link-local always, loopback/private ranges in hosted
        // mode. Recorded as blocked so the observation still reflects it.
        if (isBlockedEgressHost(host, this.blockPrivateNetworks)) {
          pushBoundedDiagnostic(this.blockedRequests, url);
          return route.abort();
        }
        const isLoopback =
          host === "127.0.0.1" || host === "localhost" || host === "[::1]";
        if (
          isLoopback ||
          allowOrigins.has(parsed.origin) ||
          this.widgetCspSources.some((s) => cspSourceMatchesUrl(s, parsed))
        ) {
          return route.continue();
        }
      } catch {
        /* fall through to abort */
      }
      pushBoundedDiagnostic(this.blockedRequests, url);
      return route.abort();
    });

    this.page = await this.context.newPage();
    this.page.on("console", (msg) => {
      if (msg.type() === "error")
        pushBoundedDiagnostic(this.consoleErrors, msg.text());
    });
    this.page.on("pageerror", (err) =>
      pushBoundedDiagnostic(this.consoleErrors, String(err))
    );

    // One-tab limit: a widget must not pop a tab the model can't see. Attached
    // AFTER the main page exists so the main page's own "page" event (which
    // fires during newPage, before `this.page` is assigned) doesn't close it.
    const mainPage = this.page;
    this.context.on("page", (p) => {
      if (p !== mainPage) void p.close().catch(() => {});
    });

    // app->host tools/call funneled from the in-page bridge.
    await this.page.exposeBinding(
      "__mcpjamHostRpc",
      async (
        _source,
        payload: {
          widgetId: string;
          name: string;
          args: Record<string, unknown>;
        }
      ) => {
        const widget = this.mounted.get(payload.widgetId);
        // Fail closed: a tools/call from a widget that isn't (or is no longer)
        // mounted Node-side has no server to route to. Dispatching with an empty
        // serverId would misroute to whatever resolves "" — refuse instead.
        if (!widget) {
          return { error: "widget not mounted" };
        }
        const serverId = widget.serverId;
        const startedAt = Date.now();
        // Count the RPC as in-flight BEFORE awaiting so `drainAfterAction` waits
        // for slow tool calls instead of returning before they land (and
        // detaching the call from the action that triggered it).
        this.pendingRpcCount += 1;
        const visibility = this.opts.resolveToolVisibility?.(
          serverId,
          payload.name
        );
        try {
          const result = await this.opts.callTool(
            serverId,
            payload.name,
            payload.args
          );
          this.toolCallBuffer.push({
            name: payload.name,
            args: payload.args,
            ok: true,
            elapsedMs: Date.now() - startedAt,
            result,
            ...(visibility ? { visibility } : {}),
          });
          return { result };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          this.toolCallBuffer.push({
            name: payload.name,
            args: payload.args,
            ok: false,
            error,
            elapsedMs: Date.now() - startedAt,
            ...(visibility ? { visibility } : {}),
          });
          return { error };
        } finally {
          this.pendingRpcCount -= 1;
        }
      }
    );

    // app->host `ui/message` follow-ups funneled from the in-page bridge.
    // Buffered like tool calls and drained per action; the runner turns each
    // into a new model turn (the run-side analogue of chat's sendMessage).
    await this.page.exposeBinding(
      "__mcpjamHostFollowUp",
      async (_source, payload: { widgetId: string; text: string }) => {
        // Fail closed: ignore messages from a widget that isn't mounted.
        if (!this.mounted.has(payload.widgetId)) return;
        const text =
          typeof payload.text === "string" ? payload.text.trim() : "";
        if (text) this.followUpBuffer.push(text);
      }
    );

    await this.page.setContent(
      "<!doctype html><html><head><meta charset='utf-8'></head><body></body></html>"
    );
    await this.page.addScriptTag({ content: HARNESS_PAGE_BUNDLE });
  }

  /* ---- render ---- */

  async renderWidget(
    input: RenderWidgetInput
  ): Promise<WidgetRenderObservation> {
    const ts = Date.now();
    const started = ts;
    const base = {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      serverId: input.serverId,
      resourceUri: input.resourceUri,
      ts,
    };

    try {
      await this.ensureLaunched();
    } catch (err) {
      if (err instanceof ChromiumNotInstalledError) {
        return {
          ...base,
          status: "browser_unavailable",
          elapsedMs: Date.now() - started,
        };
      }
      throw err;
    }
    const page = this.page!;

    if (!input.html || input.html.trim().length === 0) {
      return {
        ...base,
        status: "no_ui_resource",
        elapsedMs: Date.now() - started,
      };
    }

    // Capture the empty-host baseline once, before the first widget ever mounts
    // — nothing is on the page yet, so this is a clean "nothing painted" frame
    // for the paint check to diff against. Host background + viewport are
    // invariant, so the single reference serves every subsequent render.
    if (!this.blankReference) {
      this.blankReference = await page
        .screenshot({ type: "png" })
        .catch(() => null);
    }

    // Capture only this render's console errors + blocked requests (otherwise
    // an observation would attach unrelated diagnostics from earlier widgets in
    // the same iteration).
    this.consoleErrors = [];
    this.blockedRequests = [];
    // Single widget per page: the in-page renderWidget disposes any prior
    // widget, so drop stale Node mount entries too. Otherwise after two
    // keepMounted renders, executeAction(oldToolCallId) would pass the mount
    // check and drive the CURRENT page instead of the (gone) old widget.
    this.mounted.clear();
    this.mounted.set(input.toolCallId, {
      serverId: input.serverId,
      actionCount: 0,
    });
    // Arm the network route's COARSE egress backstop with this widget's
    // declared origins (union of all directives) BEFORE the in-page mount. The
    // route only decides "may a request leave the machine at all"; the injected
    // in-iframe CSP below does the directive-precise enforcement (connect vs
    // resource vs frame). Set before mount so first subresource fetches are
    // judged against the widget's own policy, not aborted into a blank paint.
    this.widgetCspSources = [
      ...(input.cspMeta?.connect_domains ?? []),
      ...(input.cspMeta?.resource_domains ?? []),
      ...(input.cspMeta?.frame_domains ?? []),
    ]
      .map(sanitizeProxyDomain)
      .filter(Boolean);

    // Enforce the widget's declared CSP IN the iframe with the SAME policy the
    // production sandbox proxy injects (see sandbox-proxy-csp.ts, pinned to
    // sandbox-proxy.html by a parity test). A more permissive policy would make
    // render observations false positives — a widget needing eval()/<object>/
    // base-uri or 'self' egress could "render" here yet be blocked by the real
    // sandbox. The browser then applies real directive semantics: a `fetch()`
    // only reaches a `connect_domains` origin, a script/font/img only a
    // `resource_domains` origin; an undeclared widget gets the SEP restrictive
    // default (`default-src 'none'`) instead of running open.
    const cspContent = buildSandboxProxyWidgetCsp(input.cspMeta);
    const policedHtml = injectCspMeta(input.html, cspContent);

    let pageResult: {
      mounted: boolean;
      bridgeInitialized: boolean;
      blank: boolean;
      mountError?: string;
    };
    try {
      pageResult = await page.evaluate(
        (opts) =>
          (
            globalThis as unknown as { __mcpjamHarness: HarnessPageApi }
          ).__mcpjamHarness.renderWidget(opts),
        {
          widgetId: input.toolCallId,
          html: policedHtml,
          hostCapabilities:
            this.opts.hostCapabilities ?? DEFAULT_HOST_CAPABILITIES,
          hostInfo: this.opts.hostInfo ?? {
            name: "mcpjam-eval-harness",
            version: "1.0.0",
          },
          permissions: input.permissions,
          sandboxAttrs: input.sandboxAttrs,
          allowFeatures: input.allowFeatures,
          toolInput: input.toolInput,
          toolOutput: input.toolOutput,
          renderTimeoutMs: this.budgets.renderTimeoutMs,
        }
      );
    } catch (err) {
      await this.unmount(input.toolCallId);
      return {
        ...base,
        status: "render_error",
        consoleErrors: [...this.consoleErrors],
        elapsedMs: Date.now() - started,
      };
    }

    // Tool calls a widget makes during render are not part of an action
    // result, so drop them. But `ui/message` follow-ups emitted during render
    // (auto-send-on-render widgets) ARE intended model-continuation turns —
    // carry them out on the observation so the runner can drain them.
    this.toolCallBuffer = [];
    const renderFollowUps = this.followUpBuffer.splice(0);

    if (!pageResult.mounted) {
      await this.unmount(input.toolCallId);
      return {
        ...base,
        status: "mount_failed",
        bridgeInitialized: pageResult.bridgeInitialized,
        consoleErrors: [
          ...this.consoleErrors,
          ...(pageResult.mountError ? [pageResult.mountError] : []),
        ],
        elapsedMs: Date.now() - started,
      };
    }

    // `pageResult.blank` is a DOM check sampled the instant the bridge
    // handshakes — but handshaking is not painting, and DOM-presence is not
    // pixels. Data-driven / canvas widgets (Excalidraw) only draw after they
    // receive tool data and fetch their code from a CDN, seconds later. Whenever
    // the bridge is live, wait for an actual painted frame (up to the paint
    // budget) BEFORE snapshotting, so the screenshot shows the rendered widget
    // and classification doesn't hinge on CDN cache warmth or DOM timing.
    let blank = pageResult.blank;
    let paintedFrame: Buffer | null = null;
    if (pageResult.bridgeInitialized) {
      ({ blank, frame: paintedFrame } = await this.waitForWidgetPaint());
    }

    let screenshotBase64: string | undefined;
    try {
      // Store the exact frame the blank verdict was made on (encoding it to fit
      // the byte budget); only re-shoot when the paint wait produced no frame
      // (no bridge, or its screenshots failed).
      screenshotBase64 = paintedFrame
        ? await this.encodeScreenshot(paintedFrame)
        : await this.captureScreenshot();
    } catch {
      // A widget we can't screenshot is useless for screenshot-driven Computer
      // Use, so unmount it even when keepMounted was requested — keeping
      // getMountedWidgetId() == "a usable, rendered widget" (the single source
      // of truth the eval runner gates on). This includes the by-design
      // oversized-screenshot case: `captureScreenshot` throws rather than emit
      // an image over the byte budget, so a widget that renders but produces an
      // unencodable-within-budget frame is reported as `screenshot_failed`
      // (fail closed; at 1280×800 @ JPEG q20 effectively unreachable).
      await this.unmount(input.toolCallId);
      return {
        ...base,
        status: "screenshot_failed",
        bridgeInitialized: pageResult.bridgeInitialized,
        consoleErrors: [...this.consoleErrors],
        elapsedMs: Date.now() - started,
      };
    }

    let status: WidgetRenderStatus;
    if (!pageResult.bridgeInitialized) status = "bridge_timeout";
    else if (blank) status = "blank_screenshot";
    else status = "rendered";

    // Only a fully-rendered widget stays mounted for Computer Use. Any other
    // outcome is torn down IN THE PAGE too (not just removed from `mounted`),
    // so a leftover iframe + host bridge can't keep running and misroute a
    // later widget-initiated tools/call (its serverId would resolve to "").
    if (!(input.keepMounted && status === "rendered")) {
      await this.unmount(input.toolCallId);
    }

    return {
      ...base,
      status,
      bridgeInitialized: pageResult.bridgeInitialized,
      screenshotBase64,
      consoleErrors: this.consoleErrors.length
        ? [...this.consoleErrors]
        : undefined,
      blockedRequests: this.blockedRequests.length
        ? [...this.blockedRequests]
        : undefined,
      ...(renderFollowUps.length ? { followUps: renderFollowUps } : {}),
      elapsedMs: Date.now() - started,
    };
  }

  /**
   * Wait until the widget's frame has both PAINTED (diverged from the empty-host
   * baseline) and SETTLED (stopped changing between samples), bounded by the
   * paint budget; returns the final blank state.
   *
   * This is content-agnostic, which is the point: it works the same for a DOM
   * widget, a `<canvas>`/WebGL app (e.g. Excalidraw, which mounts its canvas
   * element — "non-blank" to the DOM — long before it draws), a progressively
   * hydrated app, or a slow CDN load, with no per-widget delay tuning. Frame
   * equality is a byte compare of PNG screenshots (Chromium encodes identical
   * pixels identically), so there's no image decoding and no native-image dep.
   *
   * - A widget that paints quickly diverges + stabilizes in a couple of samples.
   * - A genuinely-blank widget never diverges from the baseline and falls
   *   through to the budget → reported blank.
   * - A perpetually-animating widget never stabilizes → hits the budget, and we
   *   snapshot the latest (painted) frame → reported rendered.
   *
   * Returns the final blank verdict AND the frame it was decided on, so the
   * caller stores the SAME image it classified (status can't disagree with the
   * screenshot).
   */
  private async waitForWidgetPaint(): Promise<{
    blank: boolean;
    frame: Buffer | null;
  }> {
    const page = this.page;
    if (!page) return { blank: true, frame: null };
    const baseline = this.blankReference;
    const deadline = Date.now() + this.budgets.paintTimeoutMs;
    // Let code/CDN fetches finish first, so a network-driven widget is sampled
    // after its load rather than during it (avoids fixating on a pre-paint
    // intermediate state). Capped to the paint budget so this can't consume it
    // whole and starve the poll below — the poll does the actual classification
    // and MUST run at least once. Best-effort: falls through on timeout.
    await page
      .waitForLoadState("networkidle", {
        timeout: Math.min(
          this.budgets.settleTimeoutMs,
          this.budgets.paintTimeoutMs
        ),
      })
      .catch(() => {});

    let prev: Buffer | null = null;
    let frame: Buffer | null = null;
    // do/while: always sample at least once, even if the wait above already
    // exhausted the budget — otherwise `frame` stays null and we'd fail toward
    // "rendered", mislabeling a blank widget.
    do {
      const shot = await page.screenshot({ type: "png" }).catch(() => null);
      // A failed shot is transient: keep the last good frame and retry until the
      // deadline rather than aborting (which would force a "rendered" verdict on
      // an unseen frame). `frame` stays null only if EVERY shot failed — then the
      // caller's screenshot also fails and the render is `screenshot_failed`.
      if (shot) {
        frame = shot;
        const painted = !baseline || !framesEqual(shot, baseline);
        const settled = framesEqual(shot, prev);
        if (painted && settled) break;
        prev = shot;
      }
      await page.waitForTimeout(150);
    } while (Date.now() < deadline);

    // Blank iff the settled frame is still indistinguishable from the empty
    // baseline. With no baseline (capture failed), fail toward "rendered" rather
    // than mislabel a real widget blank.
    const blank = !frame || !baseline ? false : framesEqual(frame, baseline);
    return { blank, frame };
  }

  /* ---- interact ---- */

  async executeAction(input: {
    toolCallId: string;
    action: BrowserActionSpec;
  }): Promise<BrowserActionResult> {
    const started = Date.now();
    const widget = this.mounted.get(input.toolCallId);
    if (!widget || !this.page) {
      return {
        action: input.action,
        widgetToolCalls: [],
        elapsedMs: 0,
        note: "no_rendered_widget",
      };
    }
    // The step cap is per-widget and terminal: once a widget exhausts it, the
    // contract ("…before forced dismiss") is to tear it down so a runaway widget
    // can't keep being driven and the next render starts clean. The screenshot
    // cap is per-ITERATION (shared across widgets), so don't dismiss this widget
    // for it — just refuse further actions on it.
    const stepBudgetExceeded =
      widget.actionCount >= this.budgets.maxBrowserStepsPerWidget;
    const screenshotBudgetExceeded =
      this.screenshotCount >= this.budgets.totalScreenshotsPerIteration;
    if (stepBudgetExceeded) {
      await this.unmount(input.toolCallId);
    }
    if (stepBudgetExceeded || screenshotBudgetExceeded) {
      return {
        action: input.action,
        widgetToolCalls: [],
        elapsedMs: Date.now() - started,
        note: stepBudgetExceeded
          ? "step_budget_exceeded"
          : "screenshot_budget_exceeded",
      };
    }
    widget.actionCount += 1;
    this.toolCallBuffer = [];
    this.followUpBuffer = [];

    await this.applyAction(input.action);
    await this.settle();

    // The app->host round-trip (postMessage -> host bridge -> exposeBinding ->
    // Node -> back) is async across the CDP boundary, so a fixed settle tail is
    // racy. Debounce-collect until the tool-call buffer is stable (bounded).
    const widgetToolCalls = await this.drainAfterAction();
    let screenshotBase64: string | undefined;
    try {
      screenshotBase64 = await this.captureScreenshot();
    } catch {
      /* leave undefined */
    }

    return {
      action: input.action,
      screenshotBase64,
      widgetToolCalls,
      elapsedMs: Date.now() - started,
    };
  }

  /* ---- scripted interaction steps (Widget interaction checks) ---- */

  /**
   * The mounted widget's iframe content as a Playwright FrameLocator. Scripted
   * selectors resolve INSIDE this frame, not the host page. The widget is the
   * single iframe under `#mcpjam-widget-root` (host-page.ts) and carries
   * `allow-same-origin`, so its same-origin srcdoc content is reachable.
   */
  private widgetFrame(): FrameLocator {
    return this.page!.frameLocator(WIDGET_IFRAME_SELECTOR);
  }

  /** Build a Locator from a semantic locator bundle. Reference points are tried
   *  in priority order testId → role → text → css; `nth` disambiguates matches. */
  private resolveScriptedLocator(target: ElementLocator): Locator {
    const frame = this.widgetFrame();
    let loc: Locator;
    if (target.testId) {
      loc = frame.getByTestId(target.testId);
    } else if (target.role) {
      loc = frame.getByRole(
        target.role.role as Parameters<FrameLocator["getByRole"]>[0],
        {
          ...(target.role.name !== undefined ? { name: target.role.name } : {}),
          ...(target.role.exact !== undefined
            ? { exact: target.role.exact }
            : {}),
        }
      );
    } else if (target.text) {
      loc = frame.getByText(target.text);
    } else if (target.css) {
      loc = frame.locator(target.css);
    } else {
      // Schema/validators reject empty locators; defensive guard.
      throw new Error(
        "locator must specify at least one of role/text/css/testId"
      );
    }
    return target.nth !== undefined ? loc.nth(target.nth) : loc;
  }

  /**
   * Replay one scripted step against the mounted widget. Action steps
   * (click/type/key/scroll/wait) drive the widget; an `assert` step checks it
   * and sets `ok=false` with a `reason` on failure. The caller accumulates
   * `widgetToolCalls` across the run and passes them as `priorWidgetToolCalls`
   * so a `widgetToolCalled` assertion can see a call an earlier step triggered.
   */
  async runScriptedStep(input: {
    toolCallId: string;
    step: ScriptedStep;
    priorWidgetToolCalls?: WidgetToolCall[];
  }): Promise<ScriptedStepResult> {
    const started = Date.now();
    const { step } = input;
    const widget = this.mounted.get(input.toolCallId);
    if (!widget || !this.page) {
      return {
        step,
        ok: false,
        reason: "no rendered widget",
        widgetToolCalls: [],
        followUps: [],
        elapsedMs: 0,
        note: "no_rendered_widget",
      };
    }
    widget.actionCount += 1;
    this.toolCallBuffer = [];
    this.followUpBuffer = [];

    let ok = true;
    let reason: string | undefined;
    const timeout = SCRIPTED_STEP_TIMEOUT_MS;
    try {
      switch (step.kind) {
        case "click": {
          const loc = this.resolveScriptedLocator(step.target);
          if (step.clickType === "double") await loc.dblclick({ timeout });
          else if (step.clickType === "right")
            await loc.click({ button: "right", timeout });
          else await loc.click({ timeout });
          break;
        }
        case "type": {
          const loc = this.resolveScriptedLocator(step.target);
          await loc.fill(step.text, { timeout });
          break;
        }
        case "key":
          await this.page.keyboard.press(step.key);
          break;
        case "scroll": {
          const amount = (step.amount ?? 3) * 100;
          await this.page.mouse.wheel(
            0,
            step.direction === "up" ? -amount : amount
          );
          break;
        }
        case "wait":
          await this.page.waitForTimeout(step.ms);
          break;
        case "assert": {
          const verdict = await this.evaluateAssertion(
            step.assertion,
            input.priorWidgetToolCalls ?? [],
            timeout
          );
          ok = verdict.ok;
          reason = verdict.reason;
          break;
        }
      }
    } catch (err) {
      ok = false;
      reason = err instanceof Error ? err.message : String(err);
    }

    await this.settle();
    const stepCalls = await this.drainAfterAction();
    // `ui/message` follow-ups land via a fire-and-forget binding; settle() +
    // drainAfterAction give them time to arrive, then we splice this step's.
    const followUps = this.followUpBuffer.splice(0);
    let screenshotBase64: string | undefined;
    try {
      screenshotBase64 = await this.captureScreenshot();
    } catch {
      /* leave undefined */
    }

    return {
      step,
      ok,
      ...(reason ? { reason } : {}),
      screenshotBase64,
      widgetToolCalls: stepCalls,
      followUps,
      elapsedMs: Date.now() - started,
    };
  }

  private async evaluateAssertion(
    assertion: StepAssertion,
    priorWidgetToolCalls: WidgetToolCall[],
    timeout: number
  ): Promise<{ ok: boolean; reason?: string }> {
    switch (assertion.type) {
      case "textVisible": {
        const loc = this.widgetFrame().getByText(assertion.text).first();
        const ok = await loc
          .waitFor({ state: "visible", timeout })
          .then(() => true)
          .catch(() => false);
        return ok
          ? { ok: true }
          : { ok: false, reason: `text not visible: "${assertion.text}"` };
      }
      case "elementVisible": {
        const loc = this.resolveScriptedLocator(assertion.target).first();
        const ok = await loc
          .waitFor({ state: "visible", timeout })
          .then(() => true)
          .catch(() => false);
        return ok ? { ok: true } : { ok: false, reason: "element not visible" };
      }
      case "elementHidden": {
        const loc = this.resolveScriptedLocator(assertion.target).first();
        const ok = await loc
          .waitFor({ state: "hidden", timeout })
          .then(() => true)
          .catch(() => false);
        return ok
          ? { ok: true }
          : { ok: false, reason: "element is visible (expected hidden)" };
      }
      case "inputValue": {
        const loc = this.resolveScriptedLocator(assertion.target).first();
        try {
          const actual = await loc.inputValue({ timeout });
          return actual === assertion.equals
            ? { ok: true }
            : {
                ok: false,
                reason: `input value "${actual}" ≠ "${assertion.equals}"`,
              };
        } catch (err) {
          return {
            ok: false,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      }
      case "widgetToolCalled": {
        const called = priorWidgetToolCalls.some(
          (c) => c.name === assertion.toolName
        );
        return called
          ? { ok: true }
          : {
              ok: false,
              reason: `widget did not call tool "${assertion.toolName}"`,
            };
      }
    }
  }

  private async applyAction(action: BrowserActionSpec): Promise<void> {
    const page = this.page!;
    const [x, y] = action.coordinate ?? [0, 0];
    switch (action.action) {
      case "left_click":
        await page.mouse.click(x, y);
        break;
      case "double_click":
        await page.mouse.dblclick(x, y);
        break;
      case "right_click":
        await page.mouse.click(x, y, { button: "right" });
        break;
      case "mouse_move":
        await page.mouse.move(x, y);
        break;
      case "type":
        if (action.text) await page.keyboard.type(action.text);
        break;
      case "key":
        if (action.text) await page.keyboard.press(action.text);
        break;
      case "scroll": {
        const amount = (action.scrollAmount ?? 3) * 100;
        const dir = action.scrollDirection ?? "down";
        const dx = dir === "right" ? amount : dir === "left" ? -amount : 0;
        const dy = dir === "down" ? amount : dir === "up" ? -amount : 0;
        if (action.coordinate) await page.mouse.move(x, y);
        await page.mouse.wheel(dx, dy);
        break;
      }
      case "wait":
        await page.waitForTimeout(
          Math.min(action.duration ?? 250, this.budgets.settleTimeoutMs)
        );
        break;
      case "screenshot":
        break;
    }
  }

  private async settle(): Promise<void> {
    const page = this.page!;
    await page
      .waitForLoadState("networkidle", {
        timeout: this.budgets.settleTimeoutMs,
      })
      .catch(() => {});
    await page.waitForTimeout(50);
  }

  /** Collect widget tool calls triggered by the action. Waits until no RPC is
   *  in flight AND the buffer is stable across one interval, so slow tool calls
   *  aren't dropped (bounded by settleTimeoutMs). */
  private async drainAfterAction(): Promise<WidgetToolCall[]> {
    const page = this.page!;
    const deadline = Date.now() + this.budgets.settleTimeoutMs;
    let prev = -1;
    while (Date.now() < deadline) {
      const n = this.toolCallBuffer.length;
      // Stop only when nothing is in flight and the buffer didn't grow this
      // interval — a slow `await callTool` keeps pendingRpcCount > 0 until it
      // resolves and pushes its record.
      if (this.pendingRpcCount === 0 && n === prev) break;
      prev = n;
      await page.waitForTimeout(60);
    }
    return this.toolCallBuffer.splice(0);
  }

  private async captureScreenshot(): Promise<string> {
    const png = await this.page!.screenshot({ type: "png" });
    return this.encodeScreenshot(png);
  }

  /**
   * Encode an already-captured PNG frame to a base64 image within the byte
   * budget, re-shooting as progressively lower-quality JPEG only if the PNG is
   * over budget (there's no in-process re-encoder — sharp is intentionally not a
   * dependency — and the page still shows the same settled frame). Throws if it
   * can't fit even at the lowest quality, which callers treat as
   * `screenshot_failed`. Reused by `renderWidget` to store the very frame it
   * classified, and by `captureScreenshot` for action screenshots.
   */
  private async encodeScreenshot(png: Buffer): Promise<string> {
    // Count only successful captures so a transient screenshot failure (caller
    // catches -> screenshot_failed) doesn't burn the per-iteration budget.
    this.screenshotCount += 1;
    if (png.byteLength <= this.budgets.screenshotMaxBytes) {
      return png.toString("base64");
    }
    // Re-encode as progressively lower-quality JPEG to fit the byte budget.
    for (const quality of [70, 50, 35, 20]) {
      const jpeg = await this.page!.screenshot({ type: "jpeg", quality });
      if (jpeg.byteLength <= this.budgets.screenshotMaxBytes) {
        return jpeg.toString("base64");
      }
    }
    // Still over the byte budget even at the lowest quality: fail closed rather
    // than hand back an oversized image (callers treat a screenshot throw as
    // `screenshot_failed` on render, or leave the action screenshot unset).
    const jpeg = await this.page!.screenshot({ type: "jpeg", quality: 20 });
    throw new Error(
      `screenshot exceeds byte budget after re-encoding ` +
        `(${jpeg.byteLength} > ${this.budgets.screenshotMaxBytes} bytes)`
    );
  }

  /* ---- teardown ---- */

  async dismissWidget(toolCallId: string): Promise<void> {
    await this.unmount(toolCallId);
  }

  /** Tear the widget down IN THE PAGE (close its host bridge + remove its
   *  iframe) and drop the Node-side mount entry. Best-effort. */
  private async unmount(toolCallId: string): Promise<void> {
    if (this.page) {
      await this.page
        .evaluate(
          (id) =>
            (
              globalThis as unknown as { __mcpjamHarness: HarnessPageApi }
            ).__mcpjamHarness.dismissWidget(id),
          toolCallId
        )
        .catch(() => {});
    }
    this.mounted.delete(toolCallId);
    // Only drop network allowances once NO widget remains mounted. Clearing
    // them whenever unmount runs — even for a stale tool-call id that was never
    // (or is no longer) the live mount — would strip the CURRENT widget's
    // declared origins out from under it, so its in-flight/subsequent
    // subresource fetches abort at the route gate (net::ERR_FAILED) until
    // teardown. Fail closed only when the page truly has no live widget.
    if (this.mounted.size === 0) {
      this.widgetCspSources = [];
    }
  }

  /**
   * Terminal-artifact hook: finalize and read the iteration's replay `.webm`.
   *
   * Playwright only flushes the video to disk when the context closes, so this
   * closes the context (which `dispose()` then treats as a no-op), reads the
   * file, and returns the bytes. Idempotent + fail-soft by contract — returns
   * `null` (never throws) when: the harness never launched, recording was off,
   * the context is already closed, or the file can't be read; and the result is
   * memoized so a second call (or a later `dispose()`) is a safe no-op.
   */
  async collectVideo(): Promise<Buffer | null> {
    if (this.videoCollected) return this.videoBytes;
    this.videoCollected = true;

    const video = this.page?.video?.() ?? null;
    if (!video) {
      this.videoBytes = null;
      return null;
    }
    let videoPath: string | null = null;
    try {
      videoPath = await video.path();
    } catch {
      videoPath = null;
    }
    // Closing the context is what flushes the .webm. Safe if already closed.
    await waitForClose(this.context?.close());
    this.context = null;
    if (!videoPath) {
      this.videoBytes = null;
      return null;
    }
    try {
      this.videoBytes = await readFile(videoPath);
    } catch {
      this.videoBytes = null;
    }
    return this.videoBytes;
  }

  async dispose(): Promise<void> {
    await waitForClose(this.context?.close());
    await waitForClose(this.browser?.close());
    // Always-runs cleanup of the recording temp dir (collectVideo already read
    // the bytes into memory; the file on disk is no longer needed).
    if (this.videoDir) {
      try {
        await rm(this.videoDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      this.videoDir = null;
    }
    this.context = null;
    this.browser = null;
    this.page = null;
    // Re-captured against the next launch's fresh page.
    this.blankReference = null;
    this.mounted.clear();
    this.widgetCspSources = [];
  }
}

// Shape of the in-page harness API (defined in host-page.ts, installed on the
// page's global after the bundle is injected). Referenced via a `globalThis`
// cast inside `page.evaluate` callbacks — those run in the browser, where
// `globalThis === window`, but are typechecked here in the Node context.
interface HarnessPageApi {
  renderWidget: (opts: unknown) => Promise<{
    mounted: boolean;
    bridgeInitialized: boolean;
    blank: boolean;
    mountError?: string;
  }>;
  dismissWidget: (widgetId: string) => boolean;
  isBlank: (widgetId: string) => boolean;
}
