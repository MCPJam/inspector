/**
 * The DOOR: a command path into the browser that is not a model's tool loop.
 *
 * Until now a command reached browserd exactly one way — a model called a
 * `browser_*` tool and the harness dispatched it. That is the whole reason an
 * outside coding agent could not drive: there was no path in that did not
 * require being the model. This is that path.
 *
 * It is NOT a way around the daemon's rules. Every command still goes through
 * the in-process client, so the auth check, the lease gate, the bootId check
 * and the idempotent queue all apply exactly as they do for a model. What the
 * door adds is what a non-model caller needs and a model does not: a session
 * that outlives a boot, a policy stated up front instead of a person to ask,
 * an actor stamped by the route that authenticated the caller, and a durable
 * record the caller can read back.
 *
 * WHY POLICY IS ENFORCED HERE AND NOT IN `buildBrowserTools`. That function
 * fails closed without an `approvalDelivery`, and its two deliveries mean
 * precise things: `attested` threads gated calls into a person's approval
 * prompt; `unattended` substitutes a declared policy because nobody is
 * watching. An agent-driven session is neither — there is no engine tool loop
 * to pause, and "a person granted consent and could be watching" is a weaker
 * guarantee than either. So M1 enforces the SAME policy type directly on agent
 * commands and leaves the registry seam alone; the `session-policy` delivery
 * lands with M1.5, when model turns need it too.
 */
import { randomUUID } from "node:crypto";
import type { BrowserUnattendedPolicy } from "@/shared/client-fulfilled-tools";
import { parseBrowserToolPolicy } from "../../evals/browser-tool-policy.js";
import { logger } from "../../../utils/logger.js";
import {
  executedResult,
  refusedResult,
  toAgentPage,
  toDaemonAction,
  unknownResult,
  type ContractRefusal,
} from "../agent-contract-mapper.js";
import type {
  BrowserCommand,
  BrowserCommandCorrelation,
  BrowserCommandSource,
} from "../protocol.js";
import type { InProcessBrowserdClient } from "../in-process-client.js";
import type { BrowserdCommandResponse } from "../browserd-codec.js";
import type { BrowserLedgerActor } from "../daemon/command-ledger.js";
import {
  LedgerSinkError,
  mirrorLedger,
  readLedger,
  type AgentSessionRecord,
} from "./agent-session-store.js";
import type {
  BrowserAgentCommand,
  BrowserAgentPage,
  BrowserAgentResult,
  BrowserAgentSessionPolicy,
} from "../../../../shared/browser-agent-contract.js";

/**
 * The source this door stamps, always, and never reads from a caller.
 *
 * `manual` is the one source the handoff lease does not block, so a body that
 * could choose its own source would let anything reaching this route drive and
 * observe a browser a person is signing into. The lease gate defends that for
 * `manual` at the daemon; this defends it at the door by never asking.
 */
const AGENT_SOURCE: BrowserCommandSource = "agent";

/** Client kinds the door will attribute to. Anything else is `agent`. */
const CLIENT_KINDS = new Set(["cli", "mcp", "sdk"]);

/**
 * Compose the actor for a command that came through this door.
 *
 * `kind` is fixed by the route — reaching here means an agent, not a model, a
 * pane or a person — and the authenticated identity goes in `label` so a trace
 * shows WHO authorized the session. The client half of `id` is declared by the
 * caller, and on this route that is honest for the same reason the pane's
 * `holder` is: consent, the session token and a verified sign-in already prove
 * whose machine this is, and the client id only has to tell two of that
 * person's agents apart. It is not an identity claim and nothing downstream
 * treats it as one.
 *
 * `anonymous` on a self-hosted inspector with no AuthKit, deliberately shown
 * rather than smoothed over: a trace that invented a plausible id would be
 * claiming an attribution the deployment cannot make.
 */
export function resolveAgentActor(args: {
  userId?: string;
  clientKind?: unknown;
  clientId?: unknown;
}): BrowserLedgerActor {
  const kind =
    typeof args.clientKind === "string" && CLIENT_KINDS.has(args.clientKind)
      ? args.clientKind
      : "agent";
  const declared =
    typeof args.clientId === "string"
      ? args.clientId.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64)
      : "";
  return {
    kind: "agent",
    id: `${kind}:${declared || "unnamed"}`,
    label: args.userId || "anonymous",
  };
}

/**
 * Read a declared session policy, or refuse.
 *
 * Reuses `BrowserUnattendedPolicy` rather than inventing a second shape. A
 * second policy type would mean two enforcement paths and two backend
 * validators kept in step by hand, for a distinction — "someone can watch and
 * revoke" — that changes who may stop the session, not what it may do.
 *
 * Parsing is strict and NEVER widens: `parseBrowserToolPolicy` answers
 * `undefined` for an unrecognized mode, a malformed allowlist, or an
 * `allowlist` with nothing in it. The door treats that as a refusal rather
 * than as a default, because the one thing worse than a session that cannot
 * use the browser is a session using it under a policy nobody wrote.
 */
export function parseSessionPolicy(
  input: unknown,
): BrowserAgentSessionPolicy | undefined {
  const parsed: BrowserUnattendedPolicy | undefined = parseBrowserToolPolicy(
    input,
    { source: "agent-browser-session" },
  );
  return parsed;
}

/** Which ops only LOOK at the page. Everything else changes it. */
const OBSERVATION_OPS = new Set<BrowserAgentCommand["op"]>(["observe"]);

/**
 * Does this session's policy admit this command?
 *
 * Mirrors `classifyBrowserToolApprovals`' rule and its reasoning: `read_only`
 * frees observation and nothing else, because a policy cannot make clicking a
 * button on a live logged-in page safe.
 */
export function policyRefusalFor(
  policy: BrowserAgentSessionPolicy,
  command: BrowserAgentCommand,
): ContractRefusal | undefined {
  if (policy.mode === "read_only" && !OBSERVATION_OPS.has(command.op)) {
    return {
      code: "tool_not_allowed",
      message:
        `this session's policy is read_only, which admits observation only; ` +
        `\`${command.op}\` changes the page`,
    };
  }
  if (policy.mode === "allowlist") {
    const tools = policy.toolAllowlist;
    if (tools?.length && !tools.includes(command.op)) {
      return {
        code: "tool_not_allowed",
        message: `this session's policy does not admit \`${command.op}\``,
      };
    }
  }
  if (command.op === "navigate") {
    const refusal = originRefusalFor(policy, command.url);
    if (refusal) return refusal;
  }
  return undefined;
}

/**
 * Is this URL inside the session's origin allowlist?
 *
 * Checked on the way IN (a navigate's target) and on the way OUT (the URL a
 * result reports), because a page can redirect: a navigate to an allowed origin
 * that lands somewhere else would otherwise return a screenshot of the place
 * the policy excluded.
 */
export function originRefusalFor(
  policy: BrowserAgentSessionPolicy,
  url: string | undefined,
): ContractRefusal | undefined {
  const allowlist = policy.originAllowlist;
  if (!allowlist?.length) return undefined;
  if (!url) return undefined;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    // An unparseable URL cannot be shown to be inside the allowlist, and an
    // allowlist that fails open is not an allowlist.
    return {
      code: "origin_not_allowed",
      message: `\`${url}\` is not a URL this session's origin allowlist can admit`,
    };
  }
  if (allowlist.includes(origin)) return undefined;
  return {
    code: "origin_not_allowed",
    message: `\`${origin}\` is outside this session's origin allowlist`,
  };
}

export interface RunAgentCommandArgs {
  session: AgentSessionRecord;
  client: Pick<
    InProcessBrowserdClient,
    "sendCommand" | "recordRefusal" | "readTrace"
  >;
  ledger: Parameters<typeof mirrorLedger>[0]["ledger"];
  bootId: string;
  actor: BrowserLedgerActor;
  command: BrowserAgentCommand;
  commandId?: string;
  tabId?: string;
  /**
   * Typed now that `isBrowserCommandCorrelation` is shared: this used to be a
   * bare string map because the route's private validator answered one, and a
   * caller could put any key it liked into a ledger row.
   */
  correlation?: BrowserCommandCorrelation;
}

export interface RunAgentCommandOutput {
  result: BrowserAgentResult;
  session: AgentSessionRecord;
  /** HTTP status the route should answer with. */
  status: number;
}

/**
 * One agent command, end to end.
 *
 * The shape of this function is the contract's three outcomes: every path below
 * produces exactly one of `executed`, `refused` or `unknown`, and the mapping
 * from the daemon's own vocabulary is where the care is. `command_expired` and
 * `command_unknown_boot` become `unknown` — not `refused` — because the command
 * may already have run and telling a caller otherwise is how a payment gets
 * submitted twice.
 */
export async function runAgentCommand(
  args: RunAgentCommandArgs,
): Promise<RunAgentCommandOutput> {
  const { session, actor } = args;
  const commandId = args.commandId || randomUUID();

  // TRANSLATED FIRST, even though policy is checked before anything is sent.
  // The refusal rows below have to say WHAT was refused, and a placeholder
  // action would record an agent's refused `type` into a password field as a
  // page reload — which is worse than not recording it, because it looks like
  // history.
  const mapped = toDaemonAction(args.command);
  const command: BrowserCommand = {
    commandId,
    source: AGENT_SOURCE,
    ...(args.tabId ? { tabId: args.tabId } : {}),
    // The mapper hands back what it built even when it refuses; only a command
    // whose shape it could not read at all leaves this undefined, and there is
    // then genuinely nothing truthful to record but the op.
    action: mapped.action ?? { kind: "observe", mode: "url" },
    actor,
    sessionId: session.sessionId,
    ...(args.correlation && Object.keys(args.correlation).length
      ? { correlation: args.correlation }
      : {}),
  };

  // 1. POLICY, before anything is sent. A refusal here still gets a row — the
  //    daemon mints its seq so the one ordered ledger stays one ordered ledger
  //    — but nothing reaches the browser.
  const policyRefusal = policyRefusalFor(session.policy, args.command);
  if (policyRefusal) {
    return recordOnlyRefusal(args, commandId, command, policyRefusal);
  }

  // 2. TRANSLATION refusals: what the contract will not carry at all (an
  //    out-of-viewport coordinate, chiefly). Also without touching the browser.
  if (!mapped.ok) {
    return recordOnlyRefusal(args, commandId, command, mapped.refusal);
  }

  // 3. THE DAEMON. Its handler writes the row for whatever happens next.
  let response: BrowserdCommandResponse;
  try {
    response = await args.client.sendCommand(command, args.bootId);
  } catch (error) {
    // The command may or may not have run — the failure is in the transport,
    // not in an answer. `unknown` is the only honest outcome.
    logger.warn("[browser-agent] command transport failed", {
      detail: error instanceof Error ? error.message : String(error),
    });
    const mirrored = await mirror(args);
    return {
      status: 502,
      session: mirrored.session,
      result: unknownResult({
        commandId,
        reason: "transport",
        ...(mirrored.historyWarning
          ? { historyWarning: mirrored.historyWarning }
          : {}),
      }),
    };
  }

  // 4. MIRROR, so the durable trace already contains this command by the time
  //    the caller is told about it. A caller that read the trace immediately
  //    and did not find its own command would reasonably conclude it had not
  //    run.
  const mirrored = await mirror(args);
  const warning = mirrored.historyWarning;
  // The DURABLE row, not the daemon ring's. The two number rows differently —
  // the store remints a seq that spans boots and counts notes — so handing back
  // the ring's would give a caller a cursor in a coordinate space the public
  // trace does not use, and `get_browser_session_trace --after-seq` would look
  // up the wrong row. The row also carries the artifact ids, which are minted
  // when the payloads are lifted out of it and exist nowhere else.
  const row = await findDurableRow(mirrored.session, commandId);

  return {
    ...toContractResult({
      response,
      commandId,
      policy: session.policy,
      ...(row ? { ledger: { sessionId: session.sessionId, seq: row.seq } } : {}),
      ...(row?.artifacts ? { artifacts: row.artifacts } : {}),
      ...(warning ? { historyWarning: warning } : {}),
    }),
    session: mirrored.session,
  };
}

/** Map one daemon response onto the contract's three outcomes. */
export function toContractResult(args: {
  response: BrowserdCommandResponse;
  commandId: string;
  policy: BrowserAgentSessionPolicy;
  ledger?: { sessionId: string; seq: number };
  artifacts?: BrowserAgentPage["artifacts"];
  historyWarning?: string;
}): { result: BrowserAgentResult; status: number } {
  const { response, commandId } = args;
  const common = {
    commandId,
    ...(args.ledger ? { ledger: args.ledger } : {}),
    ...(args.historyWarning ? { historyWarning: args.historyWarning } : {}),
  };
  switch (response.status) {
    case "ok": {
      // THE RESULT-URL CHECK. A navigate to an allowed origin can redirect to
      // one that is not; without this the observation of the excluded page
      // comes back anyway. Enforced on the way out as well as the way in.
      const outOfBounds = originRefusalFor(
        args.policy,
        readUrl(response.result.output),
      );
      if (outOfBounds) {
        // EXECUTED AND FAILED, not refused. The command already ran — the page
        // it landed on is the problem — and `refused` promises that nothing
        // ran and a retry is safe, which is how the same form gets submitted
        // twice. The page is withheld; the outcome is told truthfully.
        return {
          status: 403,
          result: executedResult({
            ...common,
            result: response.result,
            overrideError: {
              code: "origin_not_allowed",
              message: outOfBounds.message,
            },
          }),
        };
      }
      return {
        status: 200,
        result: executedResult({
          ...common,
          result: response.result,
          ...(args.artifacts ? { artifacts: args.artifacts } : {}),
        }),
      };
    }
    case "stale_observation":
      return {
        status: 409,
        result: refusedResult({
          ...common,
          code: "stale_observation",
          message:
            "the page changed after the observation this act was decided " +
            "from; re-decide from the observation below",
          // The FRESH page rides along so the caller can re-decide in one round
          // trip rather than being told to go and look again — but only when
          // the page it describes is one this session's policy admits. A
          // redirect can land the tab outside the allowlist, and a refusal
          // carrying that observation would hand over exactly what the outbound
          // check on the success path withholds.
          ...(response.result &&
          !originRefusalFor(args.policy, readUrl(response.result.output))
            ? { page: toAgentPage(response.result, args.artifacts) }
            : {}),
        }),
      };
    case "lease_blocked":
      return {
        status: 423,
        result: refusedResult({
          ...common,
          code: response.lease === "parked" ? "lease_parked" : "lease_held",
          message:
            response.lease === "parked"
              ? "a person's control of this browser has lapsed but not been " +
                "handed back; nothing ran and nothing was observed"
              : "a person has taken control of this browser; nothing ran and " +
                "nothing was observed",
        }),
      };
    case "busy":
      return {
        status: 429,
        result: refusedResult({
          ...common,
          code: "busy",
          message: "this tab's command queue is full; retry shortly",
        }),
      };
    case "at_capacity":
      return {
        status: 503,
        result: refusedResult({
          ...common,
          code: "daemon_at_capacity",
          message:
            "this browser has tracked its per-boot ceiling of commands and " +
            "should be rotated",
        }),
      };
    case "expired":
      return {
        status: 409,
        result: unknownResult({ ...common, reason: "expired" }),
      };
    case "unknown_boot":
      return {
        status: 409,
        result: unknownResult({ ...common, reason: "unknown_boot" }),
      };
    case "protocol_mismatch":
      // REFUSED, not unknown. The daemon checks the wire before its lease gate
      // and before the queue, so nothing ran and nothing was observed — which
      // is exactly what `refused` means, and the opposite of what `unknown`
      // would tell a caller about a form submission.
      return {
        status: 409,
        result: refusedResult({
          ...common,
          code: "protocol_mismatch",
          message:
            "this browser daemon speaks a different protocol version than " +
            (response.running === undefined
              ? "this server"
              : `this server (it speaks ${response.running})`) +
            "; nothing ran. It needs to be restarted onto the current build.",
        }),
      };
    default: {
      // Exhaustive: a new daemon outcome must be given one of the three
      // contract statuses deliberately, not fall into whichever arm is last.
      const exhaustive: never = response;
      void exhaustive;
      return {
        status: 502,
        result: unknownResult({ ...common, reason: "transport" }),
      };
    }
  }
}

/**
 * A refusal the INSPECTOR made, recorded through the daemon.
 *
 * Through the daemon, not into a second log, because the ring is the single
 * ordered ledger with one seq minter — and "the agent was refused, then the
 * person clicked" is precisely the ordering a trace exists to show.
 */
async function recordOnlyRefusal(
  args: RunAgentCommandArgs,
  commandId: string,
  command: BrowserCommand,
  refusal: ContractRefusal,
): Promise<RunAgentCommandOutput> {
  // A refusal that could not be RECORDED is reported, not merely logged. The
  // row never reaches the ring, so the mirror has nothing to copy and the
  // caller would otherwise be told "refused" by a trace that never mentions it
  // — the silent hole §9 forbids, and the one hardest to notice, because the
  // refusal itself arrives looking perfectly complete.
  const recordFailure = await args.client
    .recordRefusal({ command, errorCode: refusal.code })
    .then(() => undefined)
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn("[browser-agent] refusal could not be recorded", { detail });
      return (
        "this command was refused, but the refusal could not be written to " +
        `the session's history (${detail}); the trace will not show it`
      );
    });
  const mirrored = await mirror(args);
  const row = await findDurableRow(mirrored.session, commandId);
  // The recording failure first: it explains why there is no row at all, which
  // is the more specific of the two complaints.
  const historyWarning = recordFailure ?? mirrored.historyWarning;
  // 400 for a command the caller can fix by correcting its input; 403 for one
  // the session's policy excludes. Different problems, different fixes — and
  // reporting a bad coordinate as a policy denial tells an agent to give up on
  // a capability it actually has.
  const callerFixable =
    refusal.code === "invalid_command" || refusal.code === "unsupported_target";
  return {
    status: callerFixable ? 400 : 403,
    session: mirrored.session,
    result: refusedResult({
      commandId,
      code: refusal.code,
      message: refusal.message,
      ...(row
        ? { ledger: { sessionId: args.session.sessionId, seq: row.seq } }
        : {}),
      ...(historyWarning ? { historyWarning } : {}),
    }),
  };
}

/**
 * Copy the ring into the durable sink, turning a failure into a WARNING.
 *
 * Never silent. A caller that ran a command and got no history is told so on
 * the command itself, rather than discovering later that the trace has a hole
 * exactly where it was looking.
 */
async function mirror(
  args: Pick<RunAgentCommandArgs, "session" | "ledger" | "bootId">,
): Promise<{ session: AgentSessionRecord; historyWarning?: string }> {
  try {
    const { session } = await mirrorLedger({
      session: args.session,
      ledger: args.ledger,
      bootId: args.bootId,
      ...(args.session.captureScreenshots === false
        ? { captureScreenshots: false }
        : {}),
    });
    return { session };
  } catch (error) {
    const detail =
      error instanceof LedgerSinkError
        ? error.detail
        : error instanceof Error
          ? error.message
          : String(error);
    logger.warn("[browser-agent] ledger sink unavailable", { detail });
    return {
      session: args.session,
      historyWarning:
        "this command ran, but the session's durable history could not be " +
        `written (${detail}); the trace will show a gap here`,
    };
  }
}

/**
 * The durable row this command produced: its seq, and its artifact ids.
 *
 * Read from the SINK rather than from the daemon ring, because those number
 * rows differently and only the sink's numbering is the one a caller sees.
 */
async function findDurableRow(
  session: AgentSessionRecord,
  commandId: string,
): Promise<
  { seq: number; artifacts?: BrowserAgentPage["artifacts"] } | undefined
> {
  const found = await readLedger({
    projectId: session.projectId,
    sessionId: session.sessionId,
    commandId,
    limit: 1,
  }).catch(() => undefined);
  const entry = found?.entries[0];
  if (!entry || entry.kind !== "command") return undefined;
  return {
    seq: entry.seq,
    ...(entry.artifacts ? { artifacts: entry.artifacts } : {}),
  };
}

function readUrl(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null) return undefined;
  const url = (output as { url?: unknown }).url;
  return typeof url === "string" ? url : undefined;
}
