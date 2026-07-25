/**
 * Hosted DIRECT-operation MRTR glue (MCP 2026-07-28 §12.3).
 *
 * A hosted debugger's tools/execute, prompts/get, and resources/read are
 * connection-per-request calls. When a modern server returns an `input_required`
 * result mid-operation, §12.5.2 forbids the worker from blocking on a human
 * answer. This helper wires PR3b's SUSPENDING collector into the ephemeral
 * connection so those direct ops instead:
 *
 *   1. persist the SDK's data-only `MrtrOperationState` to the durable Convex
 *      continuation store (PR3a),
 *   2. return a typed `{ status: "input_required", continuationId, ... }`
 *      pending outcome to the browser (NOT a final result, and NOT a blocked
 *      worker), and
 *   3. let a fresh authenticated request drive the retry through the shared
 *      `/api/web/mrtr/continuation/resume` route (PR3b) — the direct-op resume
 *      wrapper.
 *
 * The suspend machinery, the resume primitive, the codec, the caps, and the
 * redaction all live in PR3a/PR3b and are REUSED verbatim here; PR4 only adds
 * the direct-op entry glue and the browser-facing pending-or-complete envelope.
 *
 * ## Version handshake
 *
 * MRTR is opt-in per request via `hostedMrtrVersion`. A browser that declares an
 * INCOMPATIBLE version fails fast (409) rather than being handed a
 * `continuationId` it can neither render nor resume. A browser that declares no
 * version stays on today's non-MRTR path: the collector is not injected, so
 * `buildCapabilities` does not advertise `elicitation` and a spec-compliant
 * modern server never embeds a round.
 */
import type { z } from "zod";
import type { MCPClientManager, MrtrInputCollector } from "@mcpjam/sdk";
import {
  createManualHostedConnection,
  ErrorCode,
  WebRouteError,
  webError,
  mapRuntimeError,
  readJsonBody,
} from "./auth.js";
import {
  attachHostedRpcLogs,
  createHostedRpcLogCollector,
} from "./hosted-rpc-logs.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  computeMrtrBindingFingerprint,
  createHostedMrtrCollector,
  deriveServerConfigDigest,
  isMrtrSuspendedSignal,
  resolveMrtrNegotiatedEra,
  type HostedMrtrCollectorDeps,
} from "../../utils/mrtr-hosted-collector.js";
import {
  HOSTED_MRTR_VERSION,
  isCompatibleMrtrVersion,
  type MrtrInputRequestDisplay,
  type MrtrInputRequiredEvent,
  type MrtrOperationMethod,
} from "@/shared/mrtr-continuation";

/**
 * The browser-facing SUSPEND envelope of a hosted direct MRTR operation. When a
 * direct op does NOT suspend it returns its verb's normal result verbatim (so
 * existing tools/execute, prompts/get, and resources/read response shapes are
 * unchanged); only a suspend produces this discriminated `input_required`
 * envelope. It is a superset of the shared {@link MrtrInputRequiredEvent} plus
 * `negotiatedEra`, which the browser echoes back to `/resume` (part of the
 * binding fingerprint). Consumers discriminate on `status === "input_required"`.
 */
export interface HostedDirectMrtrPending {
  status: "input_required";
  continuationId: string;
  /** Handshake echo — a stale browser detects a version it cannot honor. */
  version: number;
  serverId: string;
  serverName?: string;
  method: MrtrOperationMethod;
  operationLabel?: string;
  round: number;
  inputRequests: MrtrInputRequestDisplay[];
  expiresAt: number;
  /** Echoed to `/resume`; part of the binding fingerprint. */
  negotiatedEra: string;
}

function pendingOutcomeFromEvent(
  event: MrtrInputRequiredEvent,
  negotiatedEra: string,
): HostedDirectMrtrPending {
  return {
    status: "input_required",
    continuationId: event.continuationId,
    version: event.version,
    serverId: event.serverId,
    ...(event.serverName ? { serverName: event.serverName } : {}),
    method: event.method,
    ...(event.operationLabel ? { operationLabel: event.operationLabel } : {}),
    round: event.round,
    inputRequests: event.inputRequests,
    expiresAt: event.expiresAt,
    negotiatedEra,
  };
}

/** Test-only seams. Default to the real connection + bearer + store client. */
export interface HostedDirectMrtrSeams {
  connect?: typeof createManualHostedConnection;
  getBearer?: (c: any) => Promise<string>;
  createContinuation?: HostedMrtrCollectorDeps["create"];
  mintContinuationId?: () => string;
}

/**
 * Decide whether a request opts into hosted MRTR, from its declared
 * `hostedMrtrVersion`. Pure so the version handshake is unit-testable without a
 * live connection.
 *
 * - a compatible version ⇒ enabled;
 * - an incompatible version ⇒ throws a 409 (fail fast — the browser is stale);
 * - absent ⇒ disabled (non-MRTR backwards-compatible path).
 */
export function resolveHostedMrtrGate(rawBody: Record<string, unknown>): boolean {
  const declared = rawBody.hostedMrtrVersion;
  if (declared === undefined || declared === null) return false;
  if (typeof declared !== "number" || !isCompatibleMrtrVersion(declared)) {
    throw new WebRouteError(
      409,
      ErrorCode.VALIDATION_ERROR,
      `This tab is running an outdated hosted client (hosted-MRTR ` +
        `v${String(declared)}; the server speaks v${HOSTED_MRTR_VERSION}). ` +
        `Refresh the page to continue.`,
    );
  }
  return true;
}

/**
 * Run a hosted direct MRTR-capable operation and return its
 * pending-or-complete JSON envelope. `runVerb` performs the actual
 * tools/execute | prompts/get | resources/read against the live manager; if it
 * suspends (the collector throws `MrtrSuspendedSignal`), the worker returns the
 * pending outcome instead of blocking.
 */
export async function runHostedDirectMrtrOperation<S extends z.ZodTypeAny, R>(
  c: any,
  schema: S,
  meta: { method: MrtrOperationMethod },
  runVerb: (
    manager: MCPClientManager,
    body: z.infer<S>,
    forwardLogMessages: (serverId: string) => void,
  ) => Promise<R>,
  options?: {
    timeoutMs?: number;
    rpcLogs?: boolean;
    guestUnsupportedMessage?: string;
    seams?: HostedDirectMrtrSeams;
  },
): Promise<Response> {
  void meta;
  const connect = options?.seams?.connect ?? createManualHostedConnection;
  const getBearer = options?.seams?.getBearer ?? getConvexBearerForRequest;

  let rpcCollector: ReturnType<typeof createHostedRpcLogCollector> | undefined;
  try {
    const rawBody = await readJsonBody<Record<string, unknown>>(c);
    if (options?.rpcLogs !== false) {
      rpcCollector = createHostedRpcLogCollector(rawBody);
    }

    // Fails fast (409) on a stale browser; false leaves this on the non-MRTR path.
    const mrtrEnabled = resolveHostedMrtrGate(rawBody);

    const bearer = await getBearer(c);
    const targetServerId =
      typeof rawBody.serverId === "string" ? rawBody.serverId : "";
    const projectId =
      typeof rawBody.projectId === "string" ? rawBody.projectId : "";
    const serverName =
      typeof rawBody.serverName === "string" ? rawBody.serverName : undefined;
    const authPrincipal =
      (c.get?.("userId") as string | undefined) ??
      (c.get?.("guestId") as string | undefined) ??
      "anonymous";

    // The collector runs during the verb call — strictly AFTER the holder below
    // is populated — so it can read the manager's post-connect negotiated
    // identity to compute the SAME binding fingerprint the resume route recomputes.
    const managerHolder: { manager?: MCPClientManager } = {};
    let captured:
      | { event: MrtrInputRequiredEvent; negotiatedEra: string }
      | undefined;

    const mrtrInputCollectorForServer = mrtrEnabled
      ? (serverId: string): MrtrInputCollector | undefined => {
          // Only the operation's own server suspends; others stay non-MRTR.
          if (serverId !== targetServerId) return undefined;
          return async (args) => {
            const mgr = managerHolder.manager;
            if (!mgr) {
              throw new Error(
                "MRTR collector invoked before the manager was ready",
              );
            }
            const negotiatedEra = resolveMrtrNegotiatedEra(mgr, serverId);
            const bindingFingerprint = computeMrtrBindingFingerprint({
              serverId,
              negotiatedEra,
              serverConfigDigest: deriveServerConfigDigest(mgr, serverId),
              authPrincipal,
            });
            const inner = createHostedMrtrCollector({
              bearer,
              projectId,
              serverId,
              ...(serverName ? { serverName } : {}),
              negotiatedEra,
              bindingFingerprint,
              // Direct ops have no SSE stream — capture the round in-process and
              // return it as the JSON pending outcome instead of streaming a part.
              emit: (e) => {
                if (e.kind === "input_required") {
                  captured = { event: e, negotiatedEra };
                }
              },
              ...(options?.seams?.createContinuation
                ? { create: options.seams.createContinuation }
                : {}),
              ...(options?.seams?.mintContinuationId
                ? { mintId: options.seams.mintContinuationId }
                : {}),
            });
            return inner(args);
          };
        }
      : undefined;

    const { manager, body } = await connect(c, rawBody, schema, {
      ...(options?.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
      ...(options?.guestUnsupportedMessage
        ? { guestUnsupportedMessage: options.guestUnsupportedMessage }
        : {}),
      ...(rpcCollector ? { rpcLogger: rpcCollector.rpcLogger } : {}),
      ...(mrtrInputCollectorForServer ? { mrtrInputCollectorForServer } : {}),
    });
    managerHolder.manager = manager;

    const forwardLogMessages = (serverId: string) => {
      if (rpcCollector) manager.setPerRequestLogLevel(serverId, "debug");
    };

    // On completion the verb's own result shape is returned verbatim; only a
    // suspend produces the discriminated `input_required` envelope.
    let outcome: R | HostedDirectMrtrPending;
    try {
      outcome = await runVerb(manager, body as z.infer<S>, forwardLogMessages);
    } catch (error) {
      // A suspend is NOT a failure: the round was persisted + captured; return
      // the pending outcome so the browser drives the resume out of band.
      if (!isMrtrSuspendedSignal(error)) throw error;
      if (!captured) {
        throw new Error(
          "MRTR operation suspended but no input_required round was captured",
        );
      }
      outcome = pendingOutcomeFromEvent(captured.event, captured.negotiatedEra);
    } finally {
      // Disconnect BEFORE building the envelope so `_rpcLogs` reflects records
      // flushed during teardown — parity with `withEphemeralConnection`.
      await manager.disconnectAllServers();
    }
    return c.json(attachHostedRpcLogs(outcome, rpcCollector), 200);
  } catch (error) {
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details,
      rpcCollector?.buildEnvelope() as Record<string, unknown> | undefined,
    );
  }
}
