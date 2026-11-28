/**
 * What a local turn runs on: obtained before anything spawns, and given up
 * when the turn ends. Which kind is the runtime's (`LocalRuntimeCredential`).
 *
 *   gateway        A lease from the backend, held by this process in a
 *                  loopback gateway. Parking on an approval holds the gateway
 *                  and revokes the lease; the decision binds a fresh lease to
 *                  the same gateway.
 *   runtime-login  A login the backend exchanged from the organization's key,
 *                  held by the child in memory. Nothing stands between the
 *                  child and its vendor, so there is nothing to hold; the
 *                  login is cleared when the session ends, and expires within
 *                  the hour either way.
 */
import type { ModelReasoningEffort, ModelSelection } from "@mcpjam/sdk/browser";
import { logger } from "../../logger.js";
import {
  revokeHarnessModelBroker,
  startLoopbackModelBroker,
} from "../harness-model-broker.js";
import type { HarnessOrgLeaseUpstream } from "../harness-org-lease.js";
import type { HarnessAuth, HarnessId } from "../registry.js";
import {
  startLocalModelGateway,
  type LocalModelGateway,
} from "./model-gateway.js";
import {
  clearRuntimeLogin,
  installRuntimeLogin,
  type RuntimeLoginScope,
} from "./runtime-login.js";
import type { LocalRuntimeCredential } from "./runtimes/types.js";

export interface TurnCredential {
  readonly kind: LocalRuntimeCredential["kind"];
  /** The lease's run, for revoking it; null when there is no lease. */
  readonly brokerRunId: string | null;
  /** Present when the lease runs on the organization's own provider key. */
  readonly orgUpstream?: HarnessOrgLeaseUpstream;
  /** The loopback gateway once it listens; null before, and without one. */
  readonly gateway: LocalModelGateway | null;
  /**
   * Start what the child talks to, once the session can hold it: the gateway,
   * or nothing for a login. Started after the session's state directory, so a
   * setup that fails before it leaves only the credential to revoke. Revokes
   * the credential itself when the gateway will not start.
   */
  listen(): Promise<ListenResult>;
  /** Parked on an approval: hold model traffic and revoke the lease. */
  hold(): void;
  /** Bind a lease minted for an approval continuation. Throws without a gateway. */
  rebind(next: {
    runId: string;
    lease: string;
    bearer: string;
    getCleanupAuthorization?: () => Promise<string>;
  }): void;
  /** Revoke the lease, or clear the login. Best effort. */
  revoke(): Promise<void>;
}

export interface OpenTurnCredentialArgs {
  credential: LocalRuntimeCredential;
  harnessId: HarnessId;
  projectId: string;
  modelId: string;
  machineId: string;
  keyId: string;
  runId: string;
  evalIterationId?: string;
  journeyRunId?: string;
  targetId?: string;
  sessionIdx?: number;
  hostId?: string;
  maxOutputTokens?: number;
  reasoningEffort?: ModelReasoningEffort;
  modelSelection?: ModelSelection | null;
  bearer: string;
  getCleanupAuthorization?: () => Promise<string>;
  signal?: AbortSignal;
  /** The gateway serves only processes in this session's supervised tree. */
  isSupervisedPid: Parameters<
    typeof startLocalModelGateway
  >[0]["isSupervisedPid"];
}

export type ListenResult =
  | {
      ok: true;
      /** What the adapter is handed, named the way its CLI reads it. */
      auth: HarnessAuth;
      /** What the supervised process starts with besides the session's own
       *  environment: a runtime login, named the way its CLI reads it. */
      env?: Readonly<Record<string, string>>;
      /** How long the gateway took to listen, for timing telemetry (0 without one). */
      readyMs: number;
    }
  | { ok: false; status: string; message: string };

export type OpenTurnCredentialResult =
  | { ok: true; credential: TurnCredential }
  | { ok: false; status: string; message: string };

export async function openTurnCredential(
  args: OpenTurnCredentialArgs,
): Promise<OpenTurnCredentialResult> {
  return args.credential.kind === "gateway"
    ? openGateway(args, args.credential)
    : openRuntimeLogin(args, args.credential);
}

async function openGateway(
  args: OpenTurnCredentialArgs,
  credential: Extract<LocalRuntimeCredential, { kind: "gateway" }>,
): Promise<OpenTurnCredentialResult> {
  const broker = await startLoopbackModelBroker({
    projectId: args.projectId,
    evalIterationId: args.evalIterationId,
    journeyRunId: args.journeyRunId,
    targetId: args.targetId,
    sessionIdx: args.sessionIdx,
    hostId: args.hostId,
    harnessId: args.harnessId,
    modelId: args.modelId,
    machineId: args.machineId,
    keyId: args.keyId,
    runId: args.runId,
    ...(args.maxOutputTokens !== undefined
      ? { maxOutputTokens: args.maxOutputTokens }
      : {}),
    ...(args.reasoningEffort ? { reasoningEffort: args.reasoningEffort } : {}),
    ...(args.modelSelection ? { modelSelection: args.modelSelection } : {}),
    bearer: args.bearer,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!broker.ok)
    return { ok: false, status: "broker-unavailable", message: broker.error };

  // Mutable because a session parked on an approval gets a FRESH lease when
  // the decision arrives, bound to the same gateway, and every revoke must hit
  // the current one.
  let runId = broker.runId;
  let bearer = args.bearer;
  let authorization = args.getCleanupAuthorization ?? (async () => bearer);
  let gateway: LocalModelGateway | null = null;
  const listening = (): LocalModelGateway => {
    if (gateway === null)
      throw new Error("The local model gateway is not listening.");
    return gateway;
  };
  return {
    ok: true,
    credential: {
      kind: "gateway",
      get brokerRunId() {
        return runId;
      },
      ...(broker.orgUpstream ? { orgUpstream: broker.orgUpstream } : {}),
      get gateway() {
        return gateway;
      },
      async listen() {
        const gatewayStartedAt = Date.now();
        try {
          gateway = await startLocalModelGateway({
            lease: broker.lease,
            upstreamBaseUrl: broker.proxyBaseUrl,
            isSupervisedPid: args.isSupervisedPid,
          });
        } catch (error) {
          // The lease exists and nothing can use it, so it is revoked before
          // the failure propagates rather than left to its TTL.
          await revokeLease(runId, args.bearer);
          return {
            ok: false,
            status: "gateway-unavailable",
            message:
              "The local model gateway could not start: " +
              `${error instanceof Error ? error.message : String(error)}`,
          };
        }
        return {
          ok: true,
          auth: credential.childAuth(gateway),
          readyMs: Date.now() - gatewayStartedAt,
        };
      },
      hold() {
        // Nothing is generated while nobody is deciding anything, and the
        // lease is not kept live across a human wait.
        listening().hold();
        void revokeLease(runId, authorization);
      },
      rebind(next) {
        // Throws (and leaves the gateway held) for an unusable lease.
        listening().rebind(next.lease);
        runId = next.runId;
        bearer = next.bearer;
        authorization = next.getCleanupAuthorization ?? (async () => bearer);
      },
      revoke: () => revokeLease(runId, authorization),
    },
  };
}

async function openRuntimeLogin(
  args: OpenTurnCredentialArgs,
  credential: Extract<LocalRuntimeCredential, { kind: "runtime-login" }>,
): Promise<OpenTurnCredentialResult> {
  const scope: RuntimeLoginScope = {
    harnessId: args.harnessId,
    projectId: args.projectId,
    modelId: args.modelId,
    machineId: args.machineId,
    keyId: args.keyId,
    ...(args.evalIterationId ? { evalIterationId: args.evalIterationId } : {}),
    ...(args.journeyRunId
      ? {
          journeyRunId: args.journeyRunId,
          ...(args.hostId ? { hostId: args.hostId } : {}),
          ...(args.targetId ? { targetId: args.targetId } : {}),
          ...(args.sessionIdx !== undefined
            ? { sessionIdx: args.sessionIdx }
            : {}),
        }
      : {}),
  };
  const installed = await installRuntimeLogin({
    ...scope,
    bearer: args.bearer,
    ...(args.signal ? { signal: args.signal } : {}),
  });
  if (!installed.ok)
    return {
      ok: false,
      status: "login-unavailable",
      message: installed.message,
    };
  const authorization =
    args.getCleanupAuthorization ?? (async () => args.bearer);
  let cleared: Promise<void> | null = null;
  return {
    ok: true,
    credential: {
      kind: "runtime-login",
      brokerRunId: null,
      gateway: null,
      listen: async () => ({
        ok: true,
        auth: credential.adapterAuth,
        env: credential.childEnv(installed.login),
        readyMs: 0,
      }),
      hold() {
        // A parked CLI is waiting on the decision; its login needs no holding
        // and simply runs out if nobody decides.
      },
      rebind() {
        throw new Error("A runtime login has no lease to rebind.");
      },
      revoke: () =>
        (cleared ??= (async () => {
          try {
            await clearRuntimeLogin({
              ...scope,
              installId: installed.installId,
              bearer: await authorization(),
            });
          } catch (error) {
            logger.warn("[local-harness] runtime login clear failed", {
              message: error instanceof Error ? error.message : String(error),
            });
          }
        })()),
    },
  };
}

export async function revokeLease(
  runId: string,
  authorization: string | (() => Promise<string>),
): Promise<void> {
  try {
    const bearer =
      typeof authorization === "string" ? authorization : await authorization();
    await revokeHarnessModelBroker({ runId, bearer });
  } catch (error) {
    // Best-effort, exactly as the cloud path's revoke is: the lease's own TTL
    // and the backend's sweep are the backstop, and the gateway is already
    // refusing everything by the time this runs.
    logger.warn("[local-harness] lease revoke failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
