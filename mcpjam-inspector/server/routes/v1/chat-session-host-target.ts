/**
 * HOST TARGETING for the v1 agent-Playground turn — which ENGINE runs it.
 *
 * WHY THIS EXISTS. `POST /v1/chat-sessions/messages` had no host concept at
 * all: it took a model plus an `environmentId`/`serverIds` target, and the
 * environment was consulted only for its SERVER selection. So a turn aimed at
 * an environment whose host declares `harness: "cursor"` ran MCPJam's EMULATED
 * engine and reported back a plain `anthropic/…` model — the product claimed
 * to have driven Cursor CLI and drove something else. That is the same false
 * green `services/evals/harness-admission.ts` was written to stop, arriving on
 * a different surface.
 *
 * The rule this module encodes is the one the browser route
 * (`routes/web/chat-v2.ts`) already follows, restated for a synchronous JSON
 * surface:
 *
 *   1. A host is named by an OPAQUE POINTER. `harness` and `computer` are
 *      never read from the request body — the turn schema is a `strictObject`,
 *      so a body carrying either is a 400, and the only value this module will
 *      look at is the one the SERVER fetched for that pointer.
 *   2. TWO POINTERS THAT DISAGREE ARE A REFUSAL, not a precedence puzzle. An
 *      environment resolves its own host; a `hostId` naming a different one is
 *      rejected rather than shadowed, exactly as `shared/execution-target.ts`
 *      rejects `hostId` + `executionTarget`.
 *   3. A HARNESS TARGET NEVER DEGRADES TO EMULATED. Every refusal below is
 *      pre-stream and named. The one outcome that must not exist is a 200 that
 *      ran the emulated engine while the caller believes it observed the real
 *      runtime.
 *
 * WHAT IS DIFFERENT HERE, and refused rather than papered over: this surface
 * has no approval channel (it runs `approvalMode: "auto-deny"`), and its
 * `toolMode` / `allowedTools` / `maxToolCalls` policy is applied by NOT
 * ADVERTISING tools to the emulated engine. A harness rebuilds its own MCP
 * tool set inside the sandbox — from `.mcp.json` or from host-executed specs —
 * so neither the exclusion list nor the dispatch counter reaches it. Rather
 * than run a `read_only` harness turn with every tool live, those combinations
 * are refused by name. See {@link resolveChatSessionEngine}.
 */
import { isHarness, type Harness } from "@mcpjam/sdk/host-config/internal";
import { readXaaEnterprisePolicy } from "@mcpjam/sdk";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import {
  checkHarnessRuntimeAvailable,
  type HarnessUnavailableKind,
} from "../../utils/harness/harness-availability.js";
import { getHarnessAdapter } from "../../utils/harness/registry.js";

/**
 * A host this turn resolved SERVER-SIDE, and where the pointer came from.
 *
 * `runtimeConfig` is the authoritative payload — `fetchHostRuntimeConfig`'s
 * result for an explicit pointer, or the backend's own
 * `spec.host.runtimeConfig` for an environment. Typed as an open record for
 * the same reason `ResolvedEnvironmentRuntime` types it that way: it already
 * has one mirror, and a second would drift.
 */
export interface ChatSessionHostTarget {
  hostId: string;
  runtimeConfig: Record<string, unknown>;
  /** `environment` ⇒ the host rode the environment; `host` ⇒ an explicit `hostId`. */
  source: "environment" | "host";
}

/** The engine a turn will actually run on. Closed on purpose. */
export type ChatSessionEngine =
  | { kind: "emulated" }
  | { kind: "harness"; harness: Harness; hostId: string };

/**
 * How the response NAMES the engine that ran.
 *
 * Every turn reports it, not just harness ones — the same discipline
 * `executionEngineLabel` applies to eval runs, and for the same reason. A turn
 * that says nothing about its engine is indistinguishable from one that ran
 * the harness, and that ambiguity is what let the silent emulation on this
 * surface go unnoticed in the first place.
 */
export function engineLabel(engine: ChatSessionEngine): string {
  return engine.kind === "harness" ? `harness:${engine.harness}` : "emulated";
}

/**
 * The host-level `harness` selector, or undefined for the emulated engine.
 *
 * Only a REGISTERED id counts. This is the same membership test
 * `host-execution-context.ts`'s `readHarness` and
 * `evals/harness-admission.ts`'s `harnessOfHostConfig` apply — asked of the
 * shared `isHarness` primitive rather than re-listing ids here, so the three
 * readers cannot disagree about what a host runs.
 */
export function harnessOfRuntimeConfig(
  runtimeConfig: Record<string, unknown> | null | undefined,
): Harness | undefined {
  if (!runtimeConfig) return undefined;
  return isHarness(runtimeConfig.harness) ? runtimeConfig.harness : undefined;
}

/**
 * Refuse a body that names a host TWICE and disagrees with itself.
 *
 * An environment pins its own host server-side. A `hostId` alongside it is
 * either redundant (same host — accepted, and a useful assertion for a caller
 * that wants the environment's host pinned in its own request) or a
 * contradiction. Picking a winner is precisely the silent shadowing
 * `shared/execution-target.ts` exists to prevent, so the contradiction is a
 * 400 that names both ids.
 */
export function assertHostPointerAgreement(args: {
  /** The `hostId` the caller sent, if any. */
  requestedHostId?: string;
  /** The host the resolved environment actually pins. */
  environmentHostId: string;
  environmentId: string;
}): void {
  if (!args.requestedHostId) return;
  if (args.requestedHostId === args.environmentHostId) return;
  throw new WebRouteError(
    400,
    ErrorCode.VALIDATION_ERROR,
    `hostId "${args.requestedHostId}" contradicts environment "${args.environmentId}", which runs on host "${args.environmentHostId}". An environment pins its own host — send the environment alone, or name its host.`,
    {
      reason: "HOST_TARGET_CONFLICT",
      hostId: args.requestedHostId,
      environmentHostId: args.environmentHostId,
      environmentId: args.environmentId,
    },
  );
}

/** Why this surface refused to run a harness turn. */
export type ChatSessionEngineRefusal = {
  harness: Harness;
  /** `surface-*` kinds are this route's own; the rest come from the shared gate. */
  kind:
    | HarnessUnavailableKind
    | "surface-tool-policy"
    | "surface-approval"
    | "surface-unpinnable-host";
  reason: string;
};

export type ChatSessionEngineResult =
  | { ok: true; engine: ChatSessionEngine }
  | ({ ok: false } & ChatSessionEngineRefusal);

/**
 * Decide the engine, or refuse with a named reason. Never falls back.
 *
 * The harness half delegates to `checkHarnessRuntimeAvailable` — the SAME gate
 * chat, swarms and eval admission call — rather than restating a subset of it.
 * A rule added there (a new capability, a new credential path) must apply here
 * too, and calling the one function is the only way to guarantee that.
 *
 * THE ORDER OF THE REFUSALS IS PART OF THE CONTRACT, because only the first one
 * is ever seen. They run MOST-FUNDAMENTAL FIRST — measured by how much of the
 * request the caller must abandon to get past each — so a caller never spends a
 * round trip fixing something that was not going to be enough:
 *
 *   1. AVAILABILITY. This deployment, this host, this model. No shape of
 *      request gets past it, so nothing may precede it: telling a caller to
 *      restructure their target and letting them hit an unconfigured computers
 *      plane afterwards is the same wasted round trip in the other direction.
 *   2. UNPINNABLE HOST. A property of the SESSION, fixable only by starting a
 *      different one. Nothing in the next request can change it.
 *   3. APPROVAL. Fixable on the HOST (`requireToolApproval`), keeping the
 *      session.
 *   4. TOOL POLICY. Fixable in the very next request — `toolMode: "auto"` with
 *      no `allowedTools`/`maxToolCalls`. The cheapest to fix, so it is last.
 *
 * 1, 3 and 4 keep the relative order they have always had; only the newest rule
 * was placed, and it was placed by that measure rather than by arrival.
 *
 * The two `surface-*` rules on top of it are properties of THIS route, not of
 * any harness, and each closes a hole the shared gate cannot see:
 *
 *   - TOOL POLICY. `toolMode`, `allowedTools` and `maxToolCalls` are enforced
 *     by withholding tools from the engine this route builds. A harness builds
 *     its own set in the sandbox, so a `read_only` harness turn would advertise
 *     everything — the policy would evaporate while the response still reported
 *     `toolMode: "read_only"`. Refused, so the caller opts into `auto`
 *     deliberately and knows what it authorized.
 *   - APPROVAL. This surface runs `approvalMode: "auto-deny"` because a
 *     synchronous JSON turn has nobody to ask. A harness that CAN pause (Claude
 *     Code) would pause into a stream nothing is reading. The shared gate only
 *     refuses harnesses that cannot pause at all; the ones that can are refused
 *     here.
 *   - AN UNPINNABLE HOST ON A SESSION THAT PINS A TARGET. `hostId` is per-turn
 *     and the backend's resume allowlist cannot carry it, so the route's
 *     continuation guard leans on a session having pinned NO target of its own:
 *     that absence is what marks it host-established and makes a bare
 *     continuation refusable. A session that pins its own `serverIds` defeats
 *     that marker — the continuation looks like an ordinary `serverIds` turn,
 *     resolves no host and runs the EMULATED engine on a session established on
 *     a harness. The splice is invisible from the transcript, and turn two is
 *     too late to notice, so the shape is refused where it would be CREATED.
 *     The escapes are both lossless: `environmentId` pins a host durably, and
 *     `hostId` alone plus per-turn `allowedServerIds` narrows the same set.
 */
export function resolveChatSessionEngine(args: {
  /** Server-fetched host, or absent for a bare `serverIds` turn. */
  hostTarget?: ChatSessionHostTarget;
  /** The turn's RESOLVED model definition (id + provider), never the raw pin. */
  model: { id: string; provider?: string };
  /** The server set this turn will actually connect. */
  hasSelectedMcpServers: boolean;
  /** The turn's effective tool policy, exactly as the route will apply it. */
  toolPolicy: {
    toolMode: "read_only" | "auto";
    allowedTools?: string[];
    maxToolCalls?: number;
  };
  /**
   * Does this SESSION pin a server target of its own (`serverIds` in
   * `resumeConfig`)?
   *
   * Not a property of the turn — a property of what a LATER turn will be able
   * to resolve without the caller's help. See the unpinnable-host rule above.
   */
  sessionPinsOwnServerIds: boolean;
}): ChatSessionEngineResult {
  const harness = harnessOfRuntimeConfig(args.hostTarget?.runtimeConfig);
  if (!harness || !args.hostTarget)
    return { ok: true, engine: { kind: "emulated" } };
  const hostConfig = args.hostTarget.runtimeConfig;
  const name = getHarnessAdapter(harness).displayName;

  // The host's own approval gate, read server-side like everything else here.
  const requireToolApproval = hostConfig.requireToolApproval === true;

  const availability = checkHarnessRuntimeAvailable({
    harnessId: harness,
    requireToolApproval,
    hasSelectedMcpServers: args.hasSelectedMcpServers,
    model: args.model,
    // The same tri-state read the eval and swarm gates make: `invalid` is
    // treated exactly like `on`, because a malformed enterprise policy must
    // never be MORE permissive than a valid one.
    xaaEnterprisePolicyOn:
      readXaaEnterprisePolicy(hostConfig.mcpProfile).kind !== "off",
  });
  if (!availability.ok) {
    return {
      ok: false,
      harness,
      kind: availability.kind,
      reason: availability.reason,
    };
  }

  // SECOND, because a session shape cannot be fixed by anything in the next
  // request. The engine must survive turn TWO: a host reached by pointer is
  // re-resolved from the body every turn, so a session that pins its own
  // `serverIds` can be continued without one, resolve no host at all, and
  // append an emulated turn to a harness transcript — the failure this whole
  // module exists to make impossible. This is the only point where both facts
  // are known; the continuation cannot tell a harness-established session from
  // an ordinary `serverIds` one, because nothing durable says so.
  if (args.hostTarget.source === "host" && args.sessionPinsOwnServerIds) {
    return {
      ok: false,
      harness,
      kind: "surface-unpinnable-host",
      reason:
        `this session pins its own serverIds, and hostId cannot be pinned ` +
        `alongside them — so a later turn that omitted hostId would run the ` +
        `emulated engine on a session established on the ${name} harness, and ` +
        "nothing in the transcript would say where the engine changed. Target " +
        "an environmentId instead (an environment pins its own host, on every " +
        "turn including continuations), or send hostId ALONE and narrow the " +
        "host's servers per turn with allowedServerIds",
    };
  }

  if (requireToolApproval) {
    return {
      ok: false,
      harness,
      kind: "surface-approval",
      reason:
        `this host requires tool approval, and the ${name} harness would pause ` +
        "for it inside its sandbox — but a synchronous API turn has nobody to " +
        "ask, so nothing could ever approve. Turn off requireToolApproval on " +
        "this host, or drive it from the Playground",
    };
  }

  const unenforceable: string[] = [];
  if (args.toolPolicy.toolMode !== "auto") unenforceable.push("toolMode");
  if (args.toolPolicy.allowedTools !== undefined) {
    unenforceable.push("allowedTools");
  }
  if (args.toolPolicy.maxToolCalls !== undefined) {
    unenforceable.push("maxToolCalls");
  }
  if (unenforceable.length > 0) {
    return {
      ok: false,
      harness,
      kind: "surface-tool-policy",
      reason:
        `the ${name} harness builds its own MCP tool set inside its sandbox, ` +
        `so this turn's ${unenforceable.join(", ")} could not be applied to ` +
        "it. The turn was refused rather than run with the whole tool surface " +
        "live while the response still reported the narrowing. Send " +
        'toolMode: "auto" with no allowedTools/maxToolCalls to run the real ' +
        "runtime, or target a non-harness host. allowedServerIds still " +
        "applies — it narrows the server set the harness is given",
    };
  }

  return {
    ok: true,
    engine: { kind: "harness", harness, hostId: args.hostTarget.hostId },
  };
}

/**
 * The LAST line of defence: a harness that reached dispatch must be on an
 * engine that can actually run it.
 *
 * `runAssistantTurn` deliberately does NOT hard-fail an ineligible harness —
 * it logs and runs the emulated engine, because eval/synthetic batches forward
 * `harness` unconditionally and must not lose a whole run to one bad case. On
 * an interactive surface that leniency is the bug: the turn would answer 200
 * and be attributed to a runtime it never touched. `resolveTurnRuntime` can
 * also hand back a DIRECT (local-BYOK) runtime, which drops `harness` on the
 * floor entirely.
 *
 * The preflight above should have caught both (a BYOK model is not an
 * MCPJam-hosted one, and the shared gate refuses it), so reaching this is a
 * bug rather than a configuration. It still refuses out loud instead of
 * emulating, because "we thought this was unreachable" is not a reason to ship
 * the wrong answer.
 */
export function assertHarnessDispatchable(args: {
  engine: ChatSessionEngine;
  runtimeKind: "hosted" | "direct";
}): void {
  if (args.engine.kind !== "harness") return;
  if (args.runtimeKind === "hosted") return;
  throw new WebRouteError(
    422,
    ErrorCode.FEATURE_NOT_SUPPORTED,
    `This host runs the ${
      getHarnessAdapter(args.engine.harness).displayName
    } harness, but the turn resolved to a locally-hosted model runtime the harness cannot authenticate against. The turn was refused rather than run on the emulated engine and reported as the harness.`,
    { reason: "HARNESS_UNAVAILABLE", harness: args.engine.harness },
  );
}
