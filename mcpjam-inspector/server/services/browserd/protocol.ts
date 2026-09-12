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

/**
 * Where a command originated. All sources share one per-tab queue and timeline.
 *
 * `agent` is an outside coding agent driving this browser through the agent
 * surface, as distinct from `chat` (the Playground model's own tool loop) and
 * `inspector` (a pane acting on the user's behalf). It is a CATEGORY, not an
 * identity: `BrowserCommand.actor` tells two agents apart. Like every source
 * but `manual` it is refused outright while a person holds the lease — see
 * `leaseRefusalFor`, which admits only `manual` and so needs no change to
 * cover a new source. That default is the safe one, and it is deliberate that
 * adding a source cannot accidentally widen the handoff gate.
 */
export type BrowserCommandSource =
  | "manual"
  | "chat"
  | "inspector"
  | "eval"
  | "agent";

/**
 * The FIFO/tab key a tab-less (whole-session) command uses. The command queue
 * and the driver MUST agree on this: if the queue serialized tab-less commands
 * under one key while the driver drove them on a differently-named page, an
 * explicit `tabId` equal to either name could target the same page from two
 * independent FIFOs and race. One constant, both layers.
 */
export const DEFAULT_QUEUE_KEY = "@session";

/**
 * The daemon's WIRE compatibility number, and the only thing a reuse decision
 * may key off.
 *
 * Not the bundle hash. Every edit anywhere in the daemon's import graph rotates
 * that hash, and a hash mismatch used to mean "relaunch now" — so a deploy
 * carrying a one-line comment change killed every live hosted browser
 * mid-session, including one somebody was typing a password into. During a wave
 * of daemon work that is most deploys.
 *
 * This number answers the question that actually matters: can the inspector
 * talk to the daemon that is already running? Bump it ONLY when the wire or a
 * command's semantics change incompatibly — a new endpoint, a new optional
 * field, a new frame kind negotiated per stream are all ADDITIVE and must not
 * bump it. A hash that differs while this matches is an upgrade that can wait
 * for the session to be idle (`browser-session.ts`, `upgradeAvailable`).
 *
 * History:
 *   1 — the wire as of the viewport-fidelity wave (V-4a).
 *   2 — `act` gained the `fill_form` VERB (and `submit`). Additive on the
 *       wire and not additive in meaning: a daemon at 1 has no case for
 *       `fill_form`, so it falls through its verb switch and answers `ok`
 *       for a form it never touched, and it drops `submit` so a login is
 *       typed and never sent. Both are commands whose SEMANTICS an older
 *       daemon cannot honour while reporting success, which is exactly the
 *       bump condition above — unlike `act`'s `observe` field, which an old
 *       daemon ignores to produce the screenshot-only result it always did.
 */
export const BROWSERD_PROTOCOL_VERSION = 2;

/**
 * Capabilities every build of this daemon has, announced on `/v1/status`.
 *
 * A FEATURE FLAG RATHER THAN A PROTOCOL BUMP, because both additions are
 * strictly additive on the wire: an older daemon ignores `expectedBinding` and
 * `webmcp_cancel.commandId`, and answers `webmcp_revision` as an unknown observe
 * mode. Bumping `BROWSERD_PROTOCOL_VERSION` would instead have killed every live
 * hosted browser on deploy — a session someone was signing into included — to
 * gain a capability the server can simply ask about.
 *
 *   - `webmcp-eager`: the bridge attaches on tab creation and keeps a per-tab
 *     `{revision, hash}`, so `observe {mode:"webmcp_revision"}` is answerable
 *     and every result carries `webmcpTools`. A server talking to a daemon
 *     WITHOUT this must fall back to a full `webmcp_tools` observation.
 *   - `webmcp-binding`: `webmcp_invoke` validates `expectedBinding` and refuses
 *     `stale_binding`, and `webmcp_cancel` accepts a `commandId`. A server
 *     talking to a daemon without this must not assume its bindings are
 *     checked — the invocation would run against whatever carries that name now.
 */
export const BROWSERD_WEBMCP_FEATURES = [
  "webmcp-eager",
  "webmcp-binding",
] as const;

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
/**
 * The X display a hosted box draws on, derived from the viewport above.
 *
 * DERIVED, not configured: the "three places must agree" rule for the
 * observation viewport now has a fourth member, and a display that disagreed
 * with the page would show a browser painting past the edge of what is
 * captured, with nothing in either repository to say so.
 *
 * `dpr` is 1 and staying there until a measurement says otherwise. Raising it
 * is a MEASUREMENT, never a promise: the encoder's cost is quadratic in it, the
 * desktop box has 2 vCPU, and the gate is x264 under 60% of one core at 20fps
 * with Chromium and xfce on the same machine. `MCPJAM_HOSTED_BROWSER_DPR` is
 * how a deployment tries a candidate without shipping one.
 *
 * The MODEL's coordinate space is unaffected either way: every capture it sees
 * is CSS pixels (`scale: "css"`), and `isPointInViewport` still refuses
 * anything past 1023×767.
 */
export const HOSTED_DISPLAY = {
  dpr: 1,
  width: BROWSERD_OBSERVATION_VIEWPORT.width,
  height: BROWSERD_OBSERVATION_VIEWPORT.height,
} as const;

/**
 * Is this coordinate inside the page?
 *
 * `bounds` defaults to the observation viewport, which is the right answer for
 * the FIXED-policy callers that were the only callers when this was written —
 * the public agent contract among them, where the viewport is part of the
 * contract and must not move under an external agent.
 *
 * A `followPane` session is not one of those. Its page can be up to
 * `MAX_SESSION_VIEWPORT`, so a caller that cannot see the session's real size
 * passes the widest bound it can justify and lets the daemon — which knows the
 * size — make the exact refusal. Checking against a constant 1024x768 there
 * rejected a click at x=1200 on a page 1400 wide, and rejected it before the
 * daemon ever saw it, so the model was told its own screenshot was out of
 * bounds.
 */
export function isPointInViewport(
  x: number,
  y: number,
  bounds: { width: number; height: number } = BROWSERD_OBSERVATION_VIEWPORT,
): boolean {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= 0 &&
    y >= 0 &&
    x <= bounds.width - 1 &&
    y <= bounds.height - 1
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
  /**
   * The session viewport this observation was taken at.
   *
   * The DOM hash cannot stand in for it, and that is the whole reason it
   * exists. A CSS breakpoint crossing at 900px turns three columns into one
   * with the IDENTICAL tag skeleton — same elements, same nesting, same
   * structural digest — so a click computed from the wide screenshot passes
   * every other arm of the staleness check and lands on whatever the reflow
   * moved into that rectangle.
   *
   * OPTIONAL on the wire, and absent means "do not compare". A token minted by
   * a daemon that predates this field, or handed back by a caller that
   * round-tripped it through an older shape, must not be read as revision 0 —
   * that would refuse every act on a session that has ever been resized, which
   * is a worse failure than the one being prevented. A `fixed` session never
   * moves off 0 anyway, so nothing that exists today changes behaviour.
   */
  viewportRevision?: number;
}

/**
 * WHICH REGISTRATION of a page tool a caller means, as a value it can carry
 * across a round trip and hand back.
 *
 * Every field is load-bearing, and the set is what it is because each weaker
 * key was tried and let a real mistake through:
 *
 *   - `bootId` — the daemon restarted, so every frame id it minted is a
 *     coincidence now.
 *   - `tabId` — a binding is for one tab; the same page in two tabs is two
 *     documents with their own state.
 *   - `navCounter` — the tab navigated. THE MAIN FRAME KEEPS ITS ID across
 *     navigation (see `webmcp-bridge.ts`), so this is the only thing that
 *     separates a page from the page that replaced it at the same URL.
 *   - `frameId` — which frame. Two same-origin iframes of the same document
 *     each register their own copy of a tool, and they are not
 *     interchangeable: one is the left panel, one is the right.
 *   - `registrationSeq` — which registration WITHIN a document generation. A
 *     page that unregisters and re-registers a tool (a SPA re-mounting a
 *     component) has a new handler behind an unchanged name, frame and
 *     navCounter.
 *
 * Compared by the daemon immediately before it invokes, so an approval granted
 * against one document cannot be spent on another.
 */
export interface WebMcpToolBinding {
  bootId: BootId;
  tabId: string;
  navCounter: number;
  frameId: string;
  registrationSeq: number;
}

/**
 * A tab's WebMCP tool set, described WITHOUT touching the page.
 *
 * Read from the daemon's own cache, which the bridge keeps current by push. It
 * is what makes "has anything changed?" a cheap question the server can ask
 * before EVERY model step: a page-touching `observe` per step would be a
 * screenshot's worth of work to usually learn nothing, and would also settle
 * the page — an observation with side effects on a loop.
 */
export interface WebMcpToolsRevision {
  /** Bumps on every bridge change: add, remove, navigate, detach. */
  revision: number;
  /** Over name + description + schema + frame + generation. See `declaredToolsHash`. */
  hash: string;
  count: number;
  /** Whether this page (and this browser) speaks WebMCP at all. */
  supported: boolean;
  url?: string;
}

/**
 * What an `act` hands back once the page has settled.
 *
 * `both` is what an interactive model actually needs while acts still target
 * by coordinate or selector: the tree says what is there, the screenshot says
 * WHERE. `none` is for a caller driving a script it already trusts.
 */
export type ActObserve = "a11y" | "screenshot" | "both" | "none";

/**
 * Which reads an `observe` choice asks for — the ONE place guard and driver
 * agree on the mapping, so a new member cannot mean two things in two files.
 *
 * `undefined` is the wire default (`"screenshot"`), not a synonym for `none`:
 * a command from a caller that predates the field must still come back with
 * the picture it has always come back with.
 */
export function wantsFor(observe: ActObserve | undefined): {
  a11y: boolean;
  screenshot: boolean;
} {
  const mode = observe ?? "screenshot";
  return {
    a11y: mode === "a11y" || mode === "both",
    screenshot: mode === "screenshot" || mode === "both",
  };
}

/**
 * The act verbs THIS DAEMON dispatches, as a runtime list.
 *
 * A superset of the published `BROWSER_AGENT_ACT_VERBS`: the daemon's wire is
 * allowed to run ahead of the public contract, and `DAEMON_ONLY_ACT_VERBS`
 * (beside `publishedOpFor` in `agent-contract-mapper.ts`) names exactly what
 * the gap currently is. The parity test walks both lists, so a verb added here
 * and nowhere else is a failing test rather than a capability that quietly
 * exists on one surface — which is how `fill_form` ended up daemon-only in the
 * first place.
 */
export const BROWSERD_ACT_VERBS = [
  "click",
  "type",
  "press",
  "scroll",
  "hover",
  "drag",
  "select",
  "fill_form",
  "close_tab",
  "activate_tab",
  "accept_dialog",
  "dismiss_dialog",
] as const;

export type BrowserdActVerb = (typeof BROWSERD_ACT_VERBS)[number];

export type BrowserAction =
  | {
      kind: "navigate";
      url: string;
      newTab?: boolean;
      /**
       * What to capture once the navigation has settled. @see ActObserve
       *
       * Absent means `none` here, NOT `wantsFor`'s screenshot default: a
       * navigation has always answered with its URL and nothing else, and the
       * caller that wants a tree back from one has to ask.
       */
      observe?: ActObserve;
    }
  | { kind: "back"; observe?: ActObserve }
  /**
   * The other half of the history, added for the PERSON rather than the model.
   *
   * There was no forward verb because the agent contract never needed one: an
   * agent that has just gone back knows where it came from and can navigate
   * there by URL. A person driving the pane does not have that — they went
   * back to look at something and the way out is the forward button — and a
   * browser whose forward button does nothing is visibly broken in a way no
   * amount of explanation fixes.
   *
   * A forward with nothing to go forward to is a NO-OP, not an error, exactly
   * as `back` is at the start of history: Chromium simply stays put. The pane
   * disables the button from `canGoForward`, so the only way to reach this
   * case is a race, and a race is not a fault worth a message.
   */
  | { kind: "forward"; observe?: ActObserve }
  | { kind: "reload"; observe?: ActObserve }
  | {
      kind: "act";
      /**
       * @see BROWSERD_ACT_VERBS for the list, which is what the parity test
       * walks.
       *
       * `accept_dialog` / `dismiss_dialog` are SEPARATE FROM THE DEFAULTS the
       * daemon applies. A default exists so a tab can never wedge, but it is a
       * guess at what the caller meant — "Delete this account?" is cancelled
       * because that is the safe answer for an absent user, not because it is
       * the right one for every client. A client with its own rules (ask the
       * person, always confirm a known flow) answers here instead, and runs
       * the daemon with `dialogPolicy: "ask"` so nothing is decided for it.
       *
       * `accept_dialog` takes the prompt's reply in `value`, when the dialog
       * is a `prompt` and the caller has one.
       */
      verb: BrowserdActVerb;
      target?: BrowserActTarget;
      value?: string;
      /**
       * `fill_form` only: the fields to fill, IN ORDER.
       *
       * A login or a search was three gated calls — type, type, press — and so
       * three approvals for a person and three observations for the model.
       * This is the same work as one, which is the shape Playwright MCP
       * settled on and the reason there is no generic multi-step verb here:
       * a small composite is orderable and reviewable, a sequence verb is
       * neither.
       */
      fields?: Array<{ selector: string; value: string }>;
      /**
       * Press Enter once the text is in (`type` and `fill_form`).
       *
       * One settle and one observation for what is otherwise two commands,
       * and the submit is the half a model most often forgets to pin: it acts
       * on the page the typing produced, which is by definition a page nothing
       * has observed yet.
       */
      submit?: boolean;
      /**
       * The observation token this act was decided from (L3). When present, the
       * daemon refuses the act if the tab's current state token no longer matches
       * — the page moved under the model — and returns a fresh observation so it
       * can re-decide. Optional: a caller that opts out accepts stale targeting.
       */
      expectedState?: ObservationStateToken;
      /**
       * What to CAPTURE once the act has settled, so the model does not spend a
       * second call asking what changed.
       *
       * Absent means `"screenshot"` — exactly what an act returned before this
       * existed, so an old caller against a new daemon reads today's result and
       * a new caller against an old daemon reads today's result too (the field
       * is simply ignored there). The tool layer always sends one explicitly.
       */
      observe?: ActObserve;
    }
  | {
      kind: "observe";
      mode:
        | "screenshot"
        | "text"
        | "dom"
        | "a11y"
        | "console"
        /**
         * What the page asked the network for, and what came back.
         *
         * Metadata only: URLs with the query and fragment stripped, an
         * allowlisted subset of response headers, statuses, sizes and timing.
         * Bodies are never retained — `daemon/network.ts` says why — and
         * `requestId` reads ONE exchange rather than the tail.
         */
        | "network"
        /**
         * The dialog this page is blocked on, or `null`.
         *
         * A cache read: it touches no page, which is what makes it answerable
         * while a dialog has the renderer stopped. The point of asking is to
         * DECIDE — see the `accept_dialog` / `dismiss_dialog` verbs.
         */
        | "dialog"
        | "url"
        | "webmcp_tools"
        /**
         * The cached `{revision, hash, count}` for this tab and NOTHING else.
         *
         * Touches no page: no screenshot, no settle, no DOM read. That is the
         * whole point — the server asks it before every model step, and a mode
         * that reached into the page would make discovery cost a page load per
         * step and would itself change what it was measuring.
         */
        | "webmcp_revision";
      /** `network` only: read this one exchange in full, not the tail. */
      requestId?: string;
      /**
       * `a11y` only: scope the tree to the element this CSS selector matches,
       * instead of the whole page.
       */
      rootSelector?: string;
      /**
       * `a11y` only: scope the tree to a ref from THIS tab's last observation.
       *
       * The retrieval verb the L9 omission marker names. It used to name
       * `rootSelector` and a placeholder selector, which an AX node cannot
       * supply — so the instruction pointed at something the caller could not
       * type and an omitted subtree was, in practice, unrecoverable. A ref is
       * the one handle on this tree the caller provably has, because the same
       * observation handed it out.
       */
      rootRef?: string;
      /**
       * `a11y` only: `interactive` (default) keeps what can be acted on and the
       * structure leading to it; `all` keeps the prose too.
       *
       * Interactive by default because that is what a tree is FOR here — the
       * model reads a page's words with `{mode:"text"}`, and a budget spent on
       * paragraphs is a budget not spent on the controls.
       */
      filter?: "interactive" | "all";
    }
  | {
      kind: "webmcp_invoke";
      /**
       * The tool's own name, as `observe {mode:"webmcp_tools"}` reported it.
       *
       * A NAME, not a composite key. The daemon resolves it against the live
       * page, and the V1 layer's own `origin::name` key means nothing here —
       * sending a composite looks for a tool literally called that, finds
       * nothing, and answers `webmcp_tool_gone` for a tool sitting right
       * there. Use `frameId` to disambiguate instead.
       */
      toolKey: string;
      /**
       * Invoke in THIS frame, when it still offers the tool.
       *
       * Name resolution prefers the main frame, so a subframe's tool would
       * otherwise be shadowed by a same-named main-frame one. Optional, and
       * safely ignored by an older daemon: resolution by name is the fallback
       * on both sides, so a new caller works against an old daemon and an old
       * caller against a new one.
       */
      frameId?: string;
      /**
       * The registration the CALLER means, validated immediately before the
       * page is touched (`stale_binding` on any mismatch).
       *
       * Optional and additive: an older daemon ignores it and resolves by name
       * exactly as before, and a caller that has no binding (the legacy
       * `browser_webmcp_invoke`) sends none. A caller that DOES send one is
       * also refused a frame fallback — the whole point is that this
       * invocation reaches the tool that was listed and approved, or none.
       */
      expectedBinding?: WebMcpToolBinding;
      input: unknown;
    }
  | {
      kind: "webmcp_cancel";
      /**
       * The invocation to stop, when the caller knows its id.
       *
       * Optional now: a server aborting a tool call it issued does NOT know
       * the invocation id — `webmcp_invoke` is synchronous and only reports one
       * when it settles, which on a hung tool is never. See `commandId`.
       */
      invocationId?: string;
      /**
       * Stop whatever THIS command started.
       *
       * The daemon records `commandId → invocationId` the moment the browser
       * accepts an invocation, so a caller can name the thing it wants stopped
       * using the only id it had before the call: its own. Without this an
       * aborted request left the page's tool running to completion — the user
       * pressed Stop and the form still submitted.
       */
      commandId?: string;
    };

/**
 * One command envelope. `commandId` is the idempotency key: the daemon executes
 * a given `commandId` AT MOST ONCE per boot, no matter how many times it is
 * submitted (retries, replica races). `tabId` selects the per-tab FIFO queue;
 * omit it for whole-session commands, which share a session-level queue.
 */
export interface BrowserCommand {
  /** Caller reads dimensions from each observation instead of assuming 1024x768. */
  responsiveViewport?: boolean;
  /**
   * The wire the SENDER speaks, so a mismatch is refused rather than run.
   *
   * The reuse gates already compare protocol versions, and they are the right
   * place for the decision — but they run once per ensure, against a daemon
   * that was alive then. A daemon can be replaced under a live session (a box
   * restarts, a prelaunched daemon is adopted, a replica wins a boot race),
   * and every command after that goes to a wire nobody checked.
   *
   * What it costs to skip is specific rather than general: `fill_form` at
   * protocol 1 falls through the verb switch and answers `ok` for a form it
   * never touched. A refusal here is a sentence the caller can act on; `ok`
   * for work that did not happen is not.
   *
   * OPTIONAL, and absent means "do not check". A daemon older than this field
   * ignores it entirely, and a caller that does not send it gets exactly the
   * behaviour it has always had.
   */
  protocolVersion?: number;
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
  /**
   * WHO is sending this, for the ledger.
   *
   * Stamped by the inspector route that AUTHENTICATED the caller and echoed
   * onto the row unchanged — never read from a caller's own request body. That
   * is the same threat the lease gate already defends against for `manual`:
   * an actor a caller could choose is an actor a caller can borrow, and a
   * trace whose attribution is self-declared attributes nothing.
   *
   * Optional on the wire so an older caller still works; a command that
   * carries none is recorded against an `inspector`/`unattributed` actor
   * rather than being refused, because losing the command would be worse than
   * losing the name.
   */
  actor?: BrowserCommandActor;
  /**
   * The LOGICAL session this command belongs to (`browserLogicalSessions`
   * locally, a JSON file beside the profile). Opaque to the daemon, which
   * neither mints nor validates it: the daemon's own identity is the `bootId`,
   * and a boot is replaced whenever the bundle or the box changes, so it
   * cannot be what a permalink or an agent's history hangs off.
   */
  sessionId?: string;
  /** What else this command belongs to, when the caller knows. Echoed, never read. */
  correlation?: BrowserCommandCorrelation;
}

/** @see BrowserCommand.actor */
export interface BrowserCommandActor {
  kind: "agent" | "model" | "human" | "inspector";
  id: string;
  label?: string;
}

/** @see BrowserCommand.correlation */
export interface BrowserCommandCorrelation {
  chatSessionId?: string;
  turnId?: string;
  toolCallId?: string;
  evalRunId?: string;
  iterationId?: string;
  swarmId?: string;
}

/**
 * Is this a correlation map we are willing to echo onto a ledger row?
 *
 * Echoed and NEVER INTERPRETED, so the only question is whether it is a flat,
 * bounded string map: a nested object here would be an unbounded blob riding
 * into every row of a ring that has to stay cheap to keep and cheap to mirror.
 *
 * Lives here rather than in the one route that had it, because the model tool
 * now produces correlations too and two copies of a validator that decides
 * what reaches durable storage is one copy too many.
 *
 * Shape only, not KEYS: an unknown key from a newer caller is echoed rather
 * than dropped, which is what makes adding one an additive change.
 */
export function isBrowserCommandCorrelation(
  value: unknown,
): value is BrowserCommandCorrelation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    entries.length <= 10 &&
    entries.every(([, v]) => typeof v === "string" && v.length <= 200)
  );
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
   * the live tab (L3). The action did NOT run.
   *
   * `stateToken` is the tab's CURRENT token and `output` the observation that
   * goes with it — read the same way an act reads its own aftermath, in the
   * shape the act asked for. The refusal used to carry the token alone, which
   * told the model "re-read the page" and then made it spend a call doing so:
   * the recovery from a stale observation cost exactly the round trip the
   * token exists to save. `output` is absent only when the read itself could
   * not happen (a driver with no way to observe, or a person taking the
   * browser during it — which comes back as `leaseBlocked` instead).
   *
   * The HTTP layer maps a result with this flag to `409 stale_observation`.
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
  /**
   * The tab's WebMCP tool set at the moment this command finished, as a cheap
   * `{revision, hash, count}` (never the definitions).
   *
   * ON THE ENVELOPE, beside `stateToken`, and deliberately NOT inside `output`:
   * it is the daemon's bookkeeping rather than anything the model should read,
   * and `output` is what gets presented. Riding along on every result is what
   * lets a change the model's OWN action caused — a navigation, a click that
   * mounted a component — be noticed without a second round trip.
   */
  webmcpTools?: WebMcpToolsRevision;
  /**
   * Where the page's console and page-error rings stood AFTER this command.
   *
   * Rides beside `stateToken` rather than inside `output` on purpose: `output`
   * is the model-facing payload that goes through the untrusted-content fence,
   * and two integers of our own accounting have no business in there. The
   * ledger stores them so a reader can compute the console delta between any
   * two rows without the ledger copying page text into every one of them.
   */
  cursors?: { console: number; errors: number };
}

/**
 * The outcome the queue hands back to the HTTP layer, which maps it to a status
 * code. Distinct from `BrowserCommandResult`: a command can be rejected
 * (busy/expired) without ever executing.
 */
export type BrowserCommandOutcome =
  /** Executed (or de-duplicated to a prior execution). Carries the result. */
  | {
      status: "ok";
      result: BrowserCommandResult;
      bootId: BootId;
      /**
       * This result came from a PRIOR submission of the same commandId; nothing
       * ran this time.
       *
       * Surfaced because the ledger's rule is "one execution, one row": a retry
       * that resolves to a result already recorded must LINK to that row rather
       * than mint a second one, or a caller retrying through a flaky transport
       * would appear in the trace to have clicked the button twice. The queue is
       * the only layer that knows, so it is the layer that says.
       */
      deduped?: boolean;
    }
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
  "browser_policy_refused",
  /** A `fill_form` stopped partway; the detail names which field and why. */
  "fill_form_failed",
  "out_of_viewport",
  "unsupported_target",
  /** An `a11yRef` whose node has left the page — distinct from not found. */
  "stale_ref",
  /**
   * Something is on top of the target at its click point, so the input would
   * land on that element instead. The detail names the covering element.
   *
   * Its own code because the recovery is specific and the model can perform
   * it: dismiss the banner or the modal, then retry the original target. A
   * click that silently hit the overlay reports success, and a bare
   * `act_failed` sends the model back to re-observe a page that has not
   * changed.
   */
  "target_covered",
  /** A ref this tab's last observation never issued. */
  "unknown_ref",
  /** The page could not answer an accessibility tree at all. */
  "a11y_unavailable",
  "webmcp_unsupported",
  "webmcp_error",
  /**
   * The tool the caller named is not the tool it bound to: the tab navigated,
   * the frame is gone, or the page re-registered under the same name. Nothing
   * was invoked. Recoverable — the caller re-reads the page's tools.
   */
  "stale_binding",
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
  /** The session policy does not admit this command. */
  "tool_not_allowed",
  /**
   * The sender and this daemon do not speak the same wire.
   *
   * Refused BEFORE the lease gate and before anything runs, because the
   * failure it prevents is a command that reports success: a `fill_form` sent
   * to a protocol-1 daemon falls through its verb switch and answers `ok` for
   * a form with every field still empty.
   *
   * Also the SERVER-side name for the same condition when a relaunch could not
   * fix it, where it replaces a bare "browserd did not report listening within
   * 30000ms" — a timeout that tells the user nothing about what went wrong.
   */
  "protocol_mismatch",
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
