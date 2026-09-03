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

/**
 * The FIFO/tab key a tab-less (whole-session) command uses. The command queue
 * and the driver MUST agree on this: if the queue serialized tab-less commands
 * under one key while the driver drove them on a differently-named page, an
 * explicit `tabId` equal to either name could target the same page from two
 * independent FIFOs and race. One constant, both layers.
 */
export const DEFAULT_QUEUE_KEY = "@session";

/**
 * The canonical model-facing coordinate space (L5), and part of the WIRE
 * CONTRACT rather than a launch detail — which is why it lives here and not
 * beside the Chromium switches that happen to configure it.
 *
 * Three independent places have to agree on it: the context Playwright is
 * launched with, the daemon's bounds check on an incoming `act`, and the tool
 * schema the model is handed. A screenshot is captured at this size and every
 * coordinate a caller sends is read in this space, origin top-left, in CSS
 * pixels — so a second copy of these numbers is a silently mis-aimed click.
 */
export const BROWSERD_OBSERVATION_VIEWPORT = {
  width: 1024,
  height: 768,
} as const;

/**
 * Is a point inside the model-facing viewport?
 *
 * An out-of-range coordinate must be REFUSED, never clamped and never
 * dispatched: Chromium happily delivers a mouse event outside the viewport,
 * it lands on nothing, and the caller gets back an ordinary "here is the page
 * after your action" — a no-op that is indistinguishable from a click that
 * hit a dead area. Refusing is the only version the model can recover from.
 */
export function isPointInViewport(x: number, y: number): boolean {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    y >= 0 &&
    x <= BROWSERD_OBSERVATION_VIEWPORT.width - 1 &&
    y <= BROWSERD_OBSERVATION_VIEWPORT.height - 1
  );
}

/** A selector target for a `browser_act` verb. */
export type BrowserActTarget =
  | { coordinates: [number, number] }
  | { selector: string }
  | { a11yRef: string };

/**
 * A cheap fingerprint of a tab's rendered state, minted with every observation
 * (L3). `browser_act` may carry the token it was DECIDED from; the daemon
 * rejects the act (`stale_observation`) if the page has navigated or mutated
 * structurally since — the actual production failure mode is not duplicate
 * command delivery (the command queue already handles that) but STALE targeting:
 * a click computed from a screenshot that a late-loading banner has shifted.
 * `navCounter` bumps on every commit; `urlHash`/`domHash` are cheap digests of
 * the location and a structural view of the DOM.
 */
export interface ObservationStateToken {
  tabId: string;
  navCounter: number;
  urlHash: string;
  domHash: string;
}

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
      /**
       * The observation token this act was decided from (L3). When present, the
       * daemon refuses the act if the tab's current state token no longer matches
       * — the page moved under the model — and returns a fresh observation so it
       * can re-decide. Optional: a caller that opts out accepts stale targeting.
       */
      expectedState?: ObservationStateToken;
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
      /**
       * `a11y` only: scope the tree to the element this CSS selector matches,
       * instead of the whole page.
       *
       * This is the retrieval verb the L9 omission marker names. When the
       * budget drops a subtree it tells the caller to re-observe with
       * `{mode:"a11y", rootSelector:"<selector>"}`; without this field that
       * instruction would point at a parameter that does not exist, and an
       * omitted subtree would be unrecoverable — which is worse than
       * truncating, because the marker promises otherwise.
       */
      rootSelector?: string;
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
  /**
   * WHO is sending this, when the source is `manual`.
   *
   * `manual` is the one source the handoff lease does not block — it is the
   * person's own command, and blocking it would mean handing someone the
   * browser and then refusing to let them use it. But an unauthenticated
   * `manual` is a bypass: anything that can reach the daemon could drive (and
   * observe) a browser a person is signing into simply by claiming to be them.
   * So a `manual` command must NAME the lease holder it is acting as, and the
   * daemon checks that name against the live lease. Unused for every other
   * source, which the lease blocks outright.
   */
  holder?: string;
}

/** The daemon's result for one executed command. Opaque to the queue. */
export interface BrowserCommandResult {
  ok: boolean;
  /** Present on success; shape depends on the action. */
  output?: unknown;
  /** Present when `ok` is false. */
  error?: string;
  /**
   * The fresh state token for the acted-on / observed tab (L3). Every capture
   * carries one so the next `act` can be pinned to it.
   */
  stateToken?: ObservationStateToken;
  /**
   * False while the page is still loading at capture time (L2). browserd settles
   * (nav commit → brief network-quiet → rAF) before capturing, so this is
   * normally true; when a page genuinely will not settle, the daemon returns the
   * frame with `settled: false` rather than exposing a `wait` verb, and the
   * caller re-observes only when told the state is unsettled.
   */
  settled?: boolean;
  /**
   * Set when an `act` was REFUSED because its `expectedState` no longer matched
   * the live tab (L3). The action did NOT run; `output`/`stateToken` carry the
   * fresh observation so the caller can re-decide. The HTTP layer maps a result
   * with this flag to `409 stale_observation`.
   */
  staleObservation?: boolean;
  /**
   * Set when a person took the browser AFTER this command was admitted — at
   * the front of its queue, or between the act and the capture that would have
   * shown its effect.
   *
   * The handler's 423 covers commands that arrive while a lease is held; it
   * cannot cover the ones already inside. Without this, a screenshot requested
   * a moment before someone typed their password is taken a moment after. The
   * HTTP layer maps this to the same `423` the gate returns, so a caller reads
   * one refusal whichever side of the queue it happened on.
   */
  leaseBlocked?: boolean;
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
  | { status: "expired"; bootId: BootId }
  /**
   * The daemon has tracked its per-boot ceiling of distinct commandIds and
   * cannot admit a NEW one without either forgetting a tombstone (which would
   * permit a re-execution) or leaking memory. The caller should rotate the
   * daemon — a fresh boot resets the ledger, and its new bootId makes any stale
   * commandId `command_unknown_boot`. Duplicates of already-seen ids still
   * resolve. → 503 `daemon_at_capacity`
   */
  | { status: "at_capacity"; bootId: BootId };

/** The idempotency/eviction knobs, all overridable for tests. */
export interface CommandQueueOptions {
  /** Max settled results retained for de-duplication (LRU). */
  maxRetained?: number;
  /** How long a settled result stays returnable, in ms. */
  retainTtlMs?: number;
  /** Max in-flight + queued commands per tab before `busy`. */
  perQueueDepthCap?: number;
  /**
   * Ceiling on DISTINCT commandIds tracked per boot (returnable results + their
   * boot-long tombstones). Tombstones are never silently forgotten — doing so
   * would let a delayed retry re-run a non-idempotent action — so instead a NEW
   * command past this ceiling is refused (`at_capacity`) and the daemon should
   * rotate. Sized well above any realistic per-session command count; it is a
   * memory ceiling, not a target. Must be >= `maxRetained`.
   */
  maxCommandsPerBoot?: number;
  /** Injectable clock for deterministic TTL tests. */
  now?: () => number;
}

export const DEFAULT_COMMAND_QUEUE_OPTIONS: Required<
  Omit<CommandQueueOptions, "now">
> = {
  maxRetained: 512,
  retainTtlMs: 15 * 60 * 1000,
  perQueueDepthCap: 8,
  maxCommandsPerBoot: 50_000,
};

/**
 * Every error code browserd answers with, in one place.
 *
 * These began as bare prose inside the driver and the HTTP layer, which meant
 * a caller wanting to branch on "the element is gone" had to match a message
 * — and a reworded message silently changed behaviour somewhere else. The
 * codes are the stable half of an error; the text after the colon is the
 * human half and may say anything.
 *
 * THE WIRE FORM IS `"<code>: <detail>"`. A result's `error` starts with the
 * code; `parseBrowserdErrorCode` reads it back. Codes that ride the HTTP
 * envelope (`{error: "lease_held"}`) carry no detail and are listed here too,
 * so the two vocabularies cannot drift into naming the same condition twice.
 */
export const BROWSERD_ERROR_CODES = [
  // --- transport / control plane (HTTP envelope) -------------------------
  "cross_origin_forbidden",
  "invalid_json",
  "invalid_command",
  "invalid_lease_action",
  "holder_required",
  "command_unknown_boot",
  "command_expired",
  "daemon_at_capacity",
  "stale_observation",
  /** A person holds the browser; nothing ran and nothing was observed. */
  "lease_held",
  /** Their lease ran out mid-flow; still blocked until they hand it back. */
  "lease_parked",
  /** A `manual` command arrived while nobody holds the lease. */
  "lease_required",
  /** A `manual` command named a holder who is not the one holding it. */
  "lease_held_by_other",

  // --- driver (result `error`, `"<code>: <detail>"`) ---------------------
  "unknown_tab",
  "tab_exists",
  "unknown_selector",
  "target_not_found",
  "act_failed",
  "out_of_viewport",
  "unsupported_target",
  /** An `a11yRef` whose node has left the page — distinct from not found. */
  "stale_ref",
  "webmcp_unsupported",
  "webmcp_error",
  /** A dialog is open and waiting for the person who holds the lease. */
  "dialog_pending",
  /** A download exceeded the per-file or per-session cap and was cancelled. */
  "download_over_cap",
  /** The browser is being torn down; nothing new is opened on it. */
  "driver_closed",

  // --- session establishment (never reaches the daemon) ------------------
  /** This engine needs a Chromium that is not installed on this machine. */
  "chromium_not_installed",
  /** Another live process owns this profile directory. */
  "profile_in_use",
  /** A result's URL is outside an unattended run's origin allowlist. */
  "origin_not_allowed",
] as const;

export type BrowserdErrorCode = (typeof BROWSERD_ERROR_CODES)[number];

const BROWSERD_ERROR_CODE_SET: ReadonlySet<string> = new Set(
  BROWSERD_ERROR_CODES,
);

/** Compose the wire form. The detail is free text and may contain colons. */
export function formatBrowserdError(
  code: BrowserdErrorCode,
  detail?: string,
): string {
  return detail ? `${code}: ${detail}` : code;
}

/**
 * Read the code back off a result's `error`, or undefined when the message
 * predates this vocabulary (or is a bare Chromium/Playwright string that
 * reached the caller unclassified).
 */
export function parseBrowserdErrorCode(
  error: string | undefined,
): BrowserdErrorCode | undefined {
  if (!error) return undefined;
  const head = error.split(":", 1)[0]?.trim() ?? "";
  return BROWSERD_ERROR_CODE_SET.has(head)
    ? (head as BrowserdErrorCode)
    : undefined;
}
