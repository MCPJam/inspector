/**
 * The canonical `mcpjam-browserd` wire protocol.
 *
 * browserd is the sandbox-local daemon that drives Chromium for the Hosted
 * Browser + WebMCP Runtime. This file is the ONE source of truth for its API;
 * the W5 hosted conversion re-derives the V1 WebMCP Inspector protocol from it
 * rather than the other way round (see the `webmcp-hosted-runtime` skill). It is
 * intentionally transport-agnostic and free of Playwright/E2B imports so it can
 * be bundled into the daemon and imported by the inspector server alike.
 *
 * The command envelope mirrors V1's `POST /sessions/:id/command`
 * (`shared/webmcp-inspector-protocol.ts`) so the W5 mapping is thin, while
 * widening the action set to what the six `browser_*` model tools need.
 */

/**
 * A random id minted once per browserd process start and echoed on every
 * response. The inspector stores the last-seen value; a command replayed against
 * a DIFFERENT bootId is rejected (`command_unknown_boot`) rather than silently
 * re-run, because the first execution's outcome across a restart is unknowable —
 * re-executing would be a lie. See the command-queue idempotency rules.
 */
export type BootId = string;

/** Where a command originated. All sources share one per-tab queue and timeline. */
export type BrowserCommandSource = "manual" | "chat" | "inspector" | "eval";

/** A selector target for a `browser_act` verb. */
export type BrowserActTarget =
  | { coordinates: [number, number] }
  | { selector: string }
  | { a11yRef: string };

export type BrowserAction =
  | { kind: "navigate"; url: string; newTab?: boolean }
  | { kind: "back" }
  | { kind: "reload" }
  | {
      kind: "act";
      verb:
        | "click"
        | "type"
        | "press"
        | "scroll"
        | "hover"
        | "drag"
        | "select"
        | "close_tab"
        | "activate_tab";
      target?: BrowserActTarget;
      value?: string;
    }
  | {
      kind: "observe";
      mode:
        | "screenshot"
        | "dom"
        | "a11y"
        | "console"
        | "url"
        | "webmcp_tools";
    }
  | { kind: "webmcp_invoke"; toolKey: string; input: unknown }
  | { kind: "webmcp_cancel"; invocationId: string };

/**
 * One command envelope. `commandId` is the idempotency key: the daemon executes
 * a given `commandId` AT MOST ONCE per boot, no matter how many times it is
 * submitted (retries, replica races). `tabId` selects the per-tab FIFO queue;
 * omit it for whole-session commands, which share a session-level queue.
 */
export interface BrowserCommand {
  commandId: string;
  tabId?: string;
  source: BrowserCommandSource;
  action: BrowserAction;
}

/** The daemon's result for one executed command. Opaque to the queue. */
export interface BrowserCommandResult {
  ok: boolean;
  /** Present on success; shape depends on the action. */
  output?: unknown;
  /** Present when `ok` is false. */
  error?: string;
}

/**
 * The outcome the queue hands back to the HTTP layer, which maps it to a status
 * code. Distinct from `BrowserCommandResult`: a command can be rejected
 * (busy/expired) without ever executing.
 */
export type BrowserCommandOutcome =
  /** Executed (or de-duplicated to a prior execution). Carries the result. */
  | { status: "ok"; result: BrowserCommandResult; bootId: BootId }
  /** Per-tab queue is at its depth cap; the caller should retry later. → 429 */
  | { status: "busy"; bootId: BootId }
  /**
   * The command settled earlier but its result has since been evicted (LRU/TTL),
   * so it can be neither returned nor safely re-run. → 409 `command_expired`
   */
  | { status: "expired"; bootId: BootId };

/** The idempotency/eviction knobs, all overridable for tests. */
export interface CommandQueueOptions {
  /** Max settled results retained for de-duplication (LRU). */
  maxRetained?: number;
  /** How long a settled result stays returnable, in ms. */
  retainTtlMs?: number;
  /** Max in-flight + queued commands per tab before `busy`. */
  perQueueDepthCap?: number;
  /** Injectable clock for deterministic TTL tests. */
  now?: () => number;
}

export const DEFAULT_COMMAND_QUEUE_OPTIONS: Required<
  Omit<CommandQueueOptions, "now">
> = {
  maxRetained: 512,
  retainTtlMs: 15 * 60 * 1000,
  perQueueDepthCap: 8,
};
