/**
 * Connect-time capture for the server canvas: the v3 inspection snapshot of
 * one live connection and the context it was captured under.
 *
 * Lists only. `collectConnectedServerDoctorState` lists tools, resources,
 * templates, prompts and skills on the connection that already exists, with
 * skill verification off, so no skill file is read and nothing here can make
 * the server ask the user for input. The raw handshake comes from the client
 * manager's logging tap, so nothing is sent beyond those lists.
 *
 * The capture has its own budget inside the connect's deadline, hosted and
 * local, and stops early when the connect is cancelled: a list still running
 * then is left out with its coverage not captured, and the connect goes on
 * with what was listed.
 */
import {
  SERVER_FEATURE_SNAPSHOT_VERSION,
  clientExtensionIds,
  collectConnectedServerDoctorState,
  computeCaptureContextHash,
  hashClientCapabilities,
  normalizeCaptureContext,
  normalizeCaptureTransport,
  protocolEra,
  stableHash,
  type CaptureContext,
  type ConnectedServerDoctorState,
  type MCPClientManager,
  type ServerFeatureSnapshotServerV3,
  type ServerFeatureSnapshotV3,
} from "@mcpjam/sdk";
import { HOSTED_MODE } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { buildSnapshotServerV3, type SkillsSupportInput } from "./snapshot-v3.js";

export interface ServerFeatureCapture {
  snapshot: ServerFeatureSnapshotV3;
  context: CaptureContext;
  contextHash: string;
  /**
   * The doctor state the snapshot was built from, kept in memory for the
   * background probes (Apps grading reads its lists, the skills probe its
   * skill listing). Absent when the capture failed. Never stored.
   */
  doctor?: ConnectedServerDoctorState;
}

export interface CaptureContextOptions {
  /**
   * The connection's account: an OAuth connection or credential id. Hashed
   * before it is stored; never a token.
   */
  accountKey?: string;
  hostProfile?: string;
}

/**
 * How long a hosted capture may list, well inside the 45 s Connect deadline
 * that also covers connecting and the first tool listing.
 */
export const HOSTED_CAPTURE_BUDGET_MS = 10_000;

/**
 * How long a local capture may list. The local connect's 20 s deadline also
 * covers connecting and authorization, and a capture that ran into it would
 * turn a connect that worked into a timeout.
 */
export const LOCAL_CAPTURE_BUDGET_MS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The context a capture describes, from the manager's initialization info:
 * negotiated version, transport, and what MCPJam advertised as a client.
 */
export function buildCaptureContext(
  initInfo: unknown,
  options: CaptureContextOptions = {},
): CaptureContext {
  const info = isRecord(initInfo) ? initInfo : {};
  const protocolVersion =
    typeof info.protocolVersion === "string" && info.protocolVersion
      ? info.protocolVersion
      : undefined;
  const clientCapabilities = isRecord(info.clientCapabilities)
    ? info.clientCapabilities
    : undefined;
  const clientExtensions = clientExtensionIds(clientCapabilities);
  return normalizeCaptureContext({
    transport: normalizeCaptureTransport(info.transport),
    era: protocolEra(protocolVersion),
    ...(protocolVersion ? { protocolVersion } : {}),
    ...(clientCapabilities
      ? { clientCapabilitiesHash: hashClientCapabilities(clientCapabilities) }
      : {}),
    ...(clientExtensions.length > 0 ? { clientExtensions } : {}),
    ...(options.hostProfile ? { hostProfile: options.hostProfile } : {}),
    ...(options.accountKey
      ? { accountBinding: `acct_${stableHash(["account", options.accountKey])}` }
      : {}),
  });
}

function skillsSupport(
  manager: MCPClientManager,
  managerKey: string,
): SkillsSupportInput | undefined {
  try {
    return manager.getSkillsSupport(managerKey);
  } catch {
    // Unknown support leaves skills coverage not captured.
    return undefined;
  }
}

/** Ends listing at the budget, or sooner when the caller's signal aborts. */
function listingSignal(budgetMs: number, signal?: AbortSignal): AbortSignal {
  const deadline = AbortSignal.timeout(budgetMs);
  return signal ? AbortSignal.any([deadline, signal]) : deadline;
}

/**
 * Captures the v3 snapshot of `managerKey` and its context. Never throws: a
 * failure lands in the server's `captureError` with nothing marked captured.
 * The snapshot's `serverId` is `snapshotServerId` (the project server id).
 */
export async function captureServerFeatures(
  manager: MCPClientManager,
  managerKey: string,
  snapshotServerId: string,
  options: CaptureContextOptions & {
    logPrefix?: string;
    /**
     * Listing budget; defaults to {@link HOSTED_CAPTURE_BUDGET_MS} hosted and
     * {@link LOCAL_CAPTURE_BUDGET_MS} locally.
     */
    budgetMs?: number;
    /** The connect's own signal: a cancelled connect stops listing. */
    signal?: AbortSignal;
  } = {},
): Promise<ServerFeatureCapture> {
  const budgetMs =
    options.budgetMs ??
    (HOSTED_MODE ? HOSTED_CAPTURE_BUDGET_MS : LOCAL_CAPTURE_BUDGET_MS);
  let initInfo: unknown;
  let server: ServerFeatureSnapshotServerV3;
  let doctor: ConnectedServerDoctorState | undefined;
  try {
    const state = await collectConnectedServerDoctorState(manager, managerKey, {
      verifySkills: false,
      signal: listingSignal(budgetMs, options.signal),
    });
    doctor = state;
    initInfo = state.initInfo;
    server = buildSnapshotServerV3({
      serverId: snapshotServerId,
      state,
      handshake: manager.getCapturedEventsCapability(managerKey),
      skillsSupport: skillsSupport(manager, managerKey),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[${options.logPrefix ?? "server-canvas"}] Failed to capture server features`,
      { managerKey, snapshotServerId, error: message },
    );
    server = { serverId: snapshotServerId, tools: [], captureError: message };
  }
  const context = buildCaptureContext(initInfo, options);
  return {
    snapshot: {
      version: SERVER_FEATURE_SNAPSHOT_VERSION,
      capturedAt: Date.now(),
      servers: [server],
    },
    context,
    contextHash: computeCaptureContextHash(context),
    ...(doctor ? { doctor } : {}),
  };
}

/**
 * Whether the capture failed outright: collecting threw, or the server's
 * tools could not be listed (the backend keeps such a snapshot out of the
 * stored inspection).
 */
export function captureFailed(capture: ServerFeatureCapture): boolean {
  return (
    !capture.doctor ||
    capture.snapshot.servers.some((server) => server.captureError !== undefined)
  );
}
