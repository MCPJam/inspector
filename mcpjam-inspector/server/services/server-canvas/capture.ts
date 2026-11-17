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
 * Hosted, the capture has its own budget inside the Connect deadline: a list
 * still running when it ends is left out with its coverage not captured, and
 * the connect goes on with what was listed.
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
    /** Listing budget; hosted defaults to {@link HOSTED_CAPTURE_BUDGET_MS}. */
    budgetMs?: number;
  } = {},
): Promise<ServerFeatureCapture> {
  const budgetMs =
    options.budgetMs ?? (HOSTED_MODE ? HOSTED_CAPTURE_BUDGET_MS : undefined);
  let initInfo: unknown;
  let server: ServerFeatureSnapshotServerV3;
  try {
    const state = await collectConnectedServerDoctorState(manager, managerKey, {
      verifySkills: false,
      ...(budgetMs !== undefined ? { signal: AbortSignal.timeout(budgetMs) } : {}),
    });
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
  };
}
