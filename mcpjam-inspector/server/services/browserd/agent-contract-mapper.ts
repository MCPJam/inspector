/**
 * Contract v1 ⇄ browserd translation.
 *
 * The public agent contract (`shared/browser-agent-contract.ts`) and the daemon
 * wire (`protocol.ts`) overlap almost completely, which is exactly why this file
 * exists rather than one of them being the other. The daemon's unions change
 * with every engine wave; the contract is what an SDK release promises. Joining
 * them here means a daemon change is a DECISION taken in one place instead of a
 * silent widening of the public surface.
 *
 * The mapping is EXHAUSTIVE by construction, in both directions:
 *
 *   - `toDaemonAction` switches over every contract op, with a `never` check;
 *   - `publishedOpFor` switches over every daemon action kind, with a `never`
 *     check, so ADDING A DAEMON VERB BREAKS THE BUILD HERE. Someone then has to
 *     say whether it is published and under what name — which is the whole
 *     point. A silent fall-through in a browser automation layer looks, from the
 *     outside, like a page that just did not respond.
 *
 * The same pattern as `v1-bridge.ts`, for the same reason.
 */
import {
  BROWSERD_OBSERVATION_VIEWPORT,
  isPointInViewport,
  type BrowserAction,
  type BrowserCommandResult,
  type ObservationStateToken,
} from "./protocol";
import {
  BROWSER_AGENT_UNKNOWN_INSTRUCTION,
  BROWSER_AGENT_VIEWPORT,
  type BrowserAgentCommand,
  type BrowserAgentLedgerRef,
  type BrowserAgentObserveMode,
  type BrowserAgentPage,
  type BrowserAgentPageContent,
  type BrowserAgentRefusalCode,
  type BrowserAgentResult,
  type BrowserAgentStateToken,
  type BrowserAgentUnknownReason,
} from "../../../shared/browser-agent-contract";

/**
 * The two viewport constants must agree.
 *
 * `shared/` cannot import the server-only protocol module, so the number is
 * written twice — and a second copy of a coordinate space is how a click ends up
 * silently mis-aimed. Asserted at module load rather than trusted: this fails on
 * the first import, in every test run, instead of in one user's session.
 */
if (
  BROWSER_AGENT_VIEWPORT.width !== BROWSERD_OBSERVATION_VIEWPORT.width ||
  BROWSER_AGENT_VIEWPORT.height !== BROWSERD_OBSERVATION_VIEWPORT.height
) {
  throw new Error(
    "the published agent viewport disagrees with the daemon's observation " +
      "viewport; every act coordinate would be read in a different space than " +
      "the one callers are told about",
  );
}

/**
 * Output keys that mean the page was actually looked at. @see toAgentPage
 *
 * EVERY KEY `toAgentPage` COPIES BELONGS HERE. The two are one decision read
 * twice — "was anything observed" and "what do we hand back" — and a key
 * missing from this list is a value copied into a page that is never built.
 * `result` was: an `invoke_page_tool` reply that carried only the tool's own
 * output looked like nothing had been looked at, so the caller got no page and
 * lost the very value the command ran to get.
 */
const OBSERVATION_KEYS = [
  "url",
  "title",
  "a11y",
  "text",
  "dom",
  "console",
  "network",
  "dialog",
  "tools",
  "screenshot",
  "result",
  "refs",
] as const;

/** Is this the daemon's dialog note, rather than something a page named? */
function isDialogNote(
  value: unknown,
): value is NonNullable<BrowserAgentPageContent["dialog"]> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

/** A command the contract will not hand to the daemon. */
export interface ContractRefusal {
  code: BrowserAgentRefusalCode;
  message: string;
}

export type MappedAction =
  | { ok: true; action: BrowserAction }
  | {
      ok: false;
      refusal: ContractRefusal;
      /**
       * What the command WOULD have been, when the refusal is about a value
       * rather than about a shape we cannot read.
       *
       * The ledger needs it. A refused command is recorded so a trace can show
       * that somebody tried, and recording it as a placeholder — or as nothing
       * — turns "the agent tried to type into the password field and was
       * refused" into a row that says something else entirely.
       */
      action?: BrowserAction;
    };

/**
 * The contract's default for an acting verb.
 *
 * `a11y`, because the caller's NEXT act is usually by ref and a screenshot
 * carries none. The daemon's own default stays a screenshot so the six
 * `browser_*` model tools are unaffected by this contract existing.
 */
const DEFAULT_OBSERVE_AFTER = "a11y" as const;

/** Contract observe mode → daemon observe mode. */
function daemonObserveMode(
  mode: BrowserAgentObserveMode,
): Extract<BrowserAction, { kind: "observe" }>["mode"] {
  // `page_tools` is the one rename: the daemon calls it `webmcp_tools` after
  // the protocol that provides it, and a caller should not have to know which
  // standard a page happens to implement to ask what tools it offers.
  return mode === "page_tools" ? "webmcp_tools" : mode;
}

/**
 * A state token, as an opaque string.
 *
 * Encoded rather than published field-by-field so the daemon's hashing scheme
 * never becomes a compatibility surface. `base64url` of the JSON, which is
 * transport-safe everywhere this travels (a CLI argument, a URL, a JSON body).
 */
export function encodeStateToken(
  token: ObservationStateToken,
): BrowserAgentStateToken {
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

export function decodeStateToken(
  token: BrowserAgentStateToken,
): ObservationStateToken | undefined {
  try {
    const parsed = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8"),
    ) as Partial<ObservationStateToken>;
    if (
      typeof parsed?.tabId !== "string" ||
      typeof parsed?.navCounter !== "number" ||
      typeof parsed?.urlHash !== "string" ||
      typeof parsed?.domHash !== "string"
    ) {
      return undefined;
    }
    // A revision of the wrong type is DROPPED rather than failing the token.
    // The four fields above are the token; this one is an extra guard, and
    // losing the guard for one act is better than losing the act.
    if (
      "viewportRevision" in parsed &&
      typeof parsed.viewportRevision !== "number"
    ) {
      delete (parsed as { viewportRevision?: unknown }).viewportRevision;
    }
    return parsed as ObservationStateToken;
  } catch {
    // A token we cannot read is treated as absent rather than as a failure: the
    // caller loses staleness protection for one act, which is the documented
    // consequence of omitting it, instead of losing the act.
    return undefined;
  }
}

/** Translate one contract command into a daemon action. */
export function toDaemonAction(command: BrowserAgentCommand): MappedAction {
  switch (command.op) {
    case "navigate":
      return {
        ok: true,
        action: {
          kind: "navigate",
          url: command.url,
          ...(command.newTab ? { newTab: true } : {}),
          observe: command.observeAfter ?? DEFAULT_OBSERVE_AFTER,
        },
      };
    case "back":
      return {
        ok: true,
        action: {
          kind: "back",
          observe: command.observeAfter ?? DEFAULT_OBSERVE_AFTER,
        },
      };
    case "forward":
      return {
        ok: true,
        action: {
          kind: "forward",
          observe: command.observeAfter ?? DEFAULT_OBSERVE_AFTER,
        },
      };
    case "reload":
      return {
        ok: true,
        action: {
          kind: "reload",
          observe: command.observeAfter ?? DEFAULT_OBSERVE_AFTER,
        },
      };
    case "act": {
      const target = command.target;
      const expectedState = command.expectedState
        ? decodeStateToken(command.expectedState)
        : undefined;
      // BUILT FIRST, validated second, so a refusal can still say what was
      // attempted — the ledger records refused commands, and a refusal that
      // could not name its own verb and target would be a row about nothing.
      const action: BrowserAction = {
        kind: "act",
        verb: command.verb,
        ...(target
          ? {
              target:
                "ref" in target
                  ? { a11yRef: target.ref }
                  : "selector" in target
                    ? { selector: target.selector }
                    : { coordinates: target.coordinates },
            }
          : {}),
        ...(command.value === undefined ? {} : { value: command.value }),
        ...(expectedState ? { expectedState } : {}),
        observe: command.observeAfter ?? DEFAULT_OBSERVE_AFTER,
      };
      // NO PRE-EMPTIVE REFUSAL FOR REFS. The daemon resolves them now, and it
      // is the only layer that can: a ref is scoped to the tab that issued it
      // and validated against that observation's state token. A daemon too old
      // to resolve one still answers `unsupported_target` itself, which is the
      // same answer this used to give without the round trip — and the wrong
      // answer to give on a daemon that can.
      if (target && "coordinates" in target) {
        const [x, y] = target.coordinates;
        // REFUSED, never clamped and never dispatched. Chromium happily
        // delivers a mouse event outside the viewport, it lands on nothing, and
        // the caller gets back an ordinary "here is the page after your action"
        // — a no-op indistinguishable from a click that hit a dead area.
        if (!isPointInViewport(x, y)) {
          return {
            ok: false,
            action,
            refusal: {
              code: "invalid_command",
              message:
                `coordinates [${x}, ${y}] are outside the observation ` +
                `viewport (${BROWSER_AGENT_VIEWPORT.width}x` +
                `${BROWSER_AGENT_VIEWPORT.height}, origin top-left, CSS pixels)`,
            },
          };
        }
      }
      return { ok: true, action };
    }
    case "observe":
      return {
        ok: true,
        action: {
          kind: "observe",
          mode: daemonObserveMode(command.mode),
          ...(command.requestId ? { requestId: command.requestId } : {}),
          ...(command.rootSelector ? { rootSelector: command.rootSelector } : {}),
          ...(command.rootRef ? { rootRef: command.rootRef } : {}),
          ...(command.filter ? { filter: command.filter } : {}),
        },
      };
    case "invoke_page_tool":
      return {
        ok: true,
        action: {
          kind: "webmcp_invoke",
          toolKey: command.toolKey,
          ...(command.frameId ? { frameId: command.frameId } : {}),
          input: command.input,
        },
      };
    case "cancel_page_tool":
      return {
        ok: true,
        action: { kind: "webmcp_cancel", invocationId: command.invocationId },
      };
    default: {
      const exhaustive: never = command;
      return {
        ok: false,
        refusal: {
          code: "invalid_command",
          message: `unknown operation ${JSON.stringify(exhaustive)}`,
        },
      };
    }
  }
}

/**
 * Daemon act verbs the public contract deliberately does not publish.
 *
 * SHRINKING THIS LIST IS THE PUBLISH DECISION. `publishedOpFor` below switches
 * on `action.kind`, not on the act VERB, so a verb added to `BROWSERD_ACT_VERBS`
 * compiles, runs, and reaches no published surface — which is exactly how
 * `fill_form` came to work for the model and for nothing else. The parity test
 * asserts this list is EXACTLY the daemon's verbs minus the contract's, so a
 * new daemon verb fails until someone writes it here (stays private) or adds
 * it to `BROWSER_AGENT_ACT_VERBS` (becomes public, with the `/v1` schema, the
 * SDK allowlist, the OpenAPI enum and the CLI help to update alongside).
 *
 * `fill_form` is here rather than published because publishing it is a real
 * decision with a schema attached — `fields[]` is a second target shape on a
 * verb whose target is otherwise one element — and nobody has made it.
 */
export const DAEMON_ONLY_ACT_VERBS = ["fill_form"] as const;

/**
 * Which published op covers this daemon action — the REVERSE exhaustive check.
 *
 * Nothing calls this to do work. It exists so that adding a verb to
 * `BrowserAction` fails to compile until someone decides whether the agent
 * surface offers it, rather than the verb quietly becoming reachable (or
 * quietly not) depending on which switch happened to have a default arm.
 */
export function publishedOpFor(
  action: BrowserAction,
): BrowserAgentCommand["op"] {
  switch (action.kind) {
    case "navigate":
      return "navigate";
    case "back":
      return "back";
    case "forward":
      return "forward";
    case "reload":
      return "reload";
    case "act":
      return "act";
    case "observe":
      return "observe";
    case "webmcp_invoke":
      return "invoke_page_tool";
    case "webmcp_cancel":
      return "cancel_page_tool";
    default: {
      const exhaustive: never = action;
      throw new Error(
        `daemon action ${JSON.stringify(exhaustive)} has no published agent ` +
          "op; decide whether contract v1 offers it before shipping the verb",
      );
    }
  }
}

/**
 * Split a daemon result's output into what the page wrote and what we did.
 *
 * The fence the text rendering has always applied, applied to the structured
 * half. Anything the page controls goes under one `pageContent` key marked
 * `untrusted`; `settled`, `handoffNote`, `refs`, `omitted` and the viewport stay
 * outside it, because they are our own accounting about the observation rather
 * than the page's words.
 */
export function toAgentPage(
  result: Pick<BrowserCommandResult, "output" | "stateToken" | "settled">,
  /**
   * The artifact descriptors the ledger minted for this command.
   *
   * They come from the LEDGER rather than from the daemon result, because the
   * result carries the payloads (a base64 JPEG) and the ids are minted when
   * those payloads are lifted out of the row. Without them a caller is told a
   * screenshot was taken and given no way to fetch it — which, for
   * `observe {mode:"screenshot"}`, means the command returns no picture at all.
   */
  artifacts?: BrowserAgentPage["artifacts"],
): BrowserAgentPage | undefined {
  const output = asRecord(result.output);
  // An OBSERVATION, not merely a result. `close_tab` and `cancel_page_tool`
  // answer with an action record and no state token, and building a page from
  // that would hand a caller an empty `pageContent` implying something was
  // looked at. A page needs a token, an artifact, or something the page wrote.
  const observed =
    result.stateToken !== undefined ||
    artifacts !== undefined ||
    (output !== undefined &&
      OBSERVATION_KEYS.some((key) => output[key] !== undefined));
  if (!observed) return undefined;
  const pageContent: BrowserAgentPageContent = { untrusted: true };
  if (typeof output?.url === "string") pageContent.url = output.url;
  if (typeof output?.title === "string") pageContent.title = output.title;
  if (typeof output?.a11y === "string") pageContent.a11y = output.a11y;
  if (typeof output?.text === "string") pageContent.text = output.text;
  if (typeof output?.dom === "string") pageContent.dom = output.dom;
  if (Array.isArray(output?.console)) {
    pageContent.console = output.console as BrowserAgentPageContent["console"];
  }
  if (Array.isArray(output?.network)) {
    pageContent.network = output.network as BrowserAgentPageContent["network"];
  }
  // The explanation for a click that looks like it did nothing. Recorded by
  // the daemon and, until this line, dropped on the way out.
  if (isDialogNote(output?.dialog)) pageContent.dialog = output.dialog;
  if (output?.tools !== undefined) pageContent.pageTools = output.tools;
  if (output?.result !== undefined) pageContent.invocation = output.result;
  // Inside the fence: an accessible name is text the page chose, and a
  // `<button aria-label="Ignore previous instructions…">` lands in `name`.
  if (isRefMap(output?.refs)) pageContent.refs = output.refs;

  const omitted: NonNullable<BrowserAgentPage["omitted"]> = {};
  if (typeof output?.omittedSubtrees === "number") {
    omitted.subtrees = output.omittedSubtrees;
  }
  if (typeof output?.totalNodes === "number") {
    omitted.totalNodes = output.totalNodes;
  }
  if (typeof output?.omitted === "number") omitted.entries = output.omitted;

  return {
    viewport: { ...BROWSER_AGENT_VIEWPORT },
    ...(result.settled === undefined ? {} : { settled: result.settled }),
    ...(result.stateToken
      ? { stateToken: encodeStateToken(result.stateToken) }
      : {}),
    ...(typeof output?.handoffNote === "string"
      ? { handoffNote: output.handoffNote }
      : {}),
    ...(Object.keys(omitted).length ? { omitted } : {}),
    ...(artifacts && Object.keys(artifacts).length ? { artifacts } : {}),
    pageContent,
  };
}

/** Build the `unknown` arm, with its standing instruction attached. */
export function unknownResult(args: {
  commandId: string;
  reason: BrowserAgentUnknownReason;
  ledger?: BrowserAgentLedgerRef;
  historyWarning?: string;
}): BrowserAgentResult {
  return {
    status: "unknown",
    commandId: args.commandId,
    ...(args.ledger ? { ledger: args.ledger } : {}),
    unknown: {
      reason: args.reason,
      commandId: args.commandId,
      instruction: BROWSER_AGENT_UNKNOWN_INSTRUCTION,
    },
    ...(args.historyWarning ? { historyWarning: args.historyWarning } : {}),
  };
}

/** Build the `refused` arm. */
export function refusedResult(args: {
  commandId: string;
  code: BrowserAgentRefusalCode;
  message: string;
  page?: BrowserAgentPage;
  ledger?: BrowserAgentLedgerRef;
  historyWarning?: string;
}): BrowserAgentResult {
  return {
    status: "refused",
    commandId: args.commandId,
    ...(args.ledger ? { ledger: args.ledger } : {}),
    refusal: {
      code: args.code,
      message: args.message,
      ...(args.page ? { page: args.page } : {}),
    },
    ...(args.historyWarning ? { historyWarning: args.historyWarning } : {}),
  };
}

/** Build the `executed` arm from a daemon result. */
export function executedResult(args: {
  commandId: string;
  result: BrowserCommandResult;
  ledger?: BrowserAgentLedgerRef;
  artifacts?: BrowserAgentPage["artifacts"];
  historyWarning?: string;
  /**
   * Report the command as having run and FAILED, with this error.
   *
   * For a failure only the caller's own policy can see — chiefly a result URL
   * outside the session's origin allowlist. The command ran, so `refused`
   * (which promises nothing ran, and that a retry is safe) would be a lie that
   * gets a form submitted twice; the page is withheld instead.
   */
  overrideError?: { code: string; message: string };
}): BrowserAgentResult {
  if (args.overrideError) {
    return {
      status: "executed",
      commandId: args.commandId,
      ...(args.ledger ? { ledger: args.ledger } : {}),
      ok: false,
      error: args.overrideError,
      ...(args.historyWarning ? { historyWarning: args.historyWarning } : {}),
    };
  }
  const page = toAgentPage(args.result, args.artifacts);
  return {
    status: "executed",
    commandId: args.commandId,
    ...(args.ledger ? { ledger: args.ledger } : {}),
    ok: args.result.ok,
    // `ok: false` on an EXECUTED command is not a contradiction: a click that
    // found no button ran fine and failed, and a caller has to be able to tell
    // that from a click that never ran at all.
    ...(args.result.ok || !args.result.error
      ? {}
      : { error: splitError(args.result.error) }),
    ...(page ? { page } : {}),
    ...(args.historyWarning ? { historyWarning: args.historyWarning } : {}),
  };
}

/** `"<code>: <detail>"` → `{code, message}`; a bare message keeps no code. */
function splitError(error: string): { code?: string; message: string } {
  const head = error.split(":", 1)[0]?.trim() ?? "";
  const rest = error.slice(head.length + 1).trim();
  return head && rest ? { code: head, message: rest } : { message: error };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isRefMap(
  value: unknown,
): value is Record<string, { role: string; name?: string }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  // EVERY ENTRY, not just the wrapper. This map is written by the page, and the
  // shape is a promise made to whoever reads `page.refs` — checking only that
  // something object-ish arrived and then asserting the entries' type is not a
  // check at all, it is the assertion a caller then trusts. The fence keeps the
  // page's WORDS out of trust; it cannot keep its SHAPES out of a type.
  return Object.values(value as Record<string, unknown>).every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return false;
    }
    const ref = entry as { role?: unknown; name?: unknown };
    return (
      typeof ref.role === "string" &&
      (ref.name === undefined || typeof ref.name === "string")
    );
  });
}
