/**
 * Saved evidence shaped like `serverFeatureEvidence:getForServer`, and the
 * evaluations the real catalog and evaluator produce from it.
 */
import {
  SERVER_FEATURE_CATALOG,
  evaluateServerFeatures,
  selectServerEvidence,
  type CheckResultEvidence,
  type ServerFeatureEvaluation,
  type StoredServerEvidence,
} from "@mcpjam/sdk/browser";

export const CTX_A = "ctx_aaaaaaaaaaaaaaaa";
export const CTX_B = "ctx_bbbbbbbbbbbbbbbb";
export const CAPTURED_AT = Date.UTC(2026, 10, 15, 12, 20);

const COMPLETE = {
  serverInfo: "complete",
  capabilities: "complete",
  instructions: "complete",
  tools: "complete",
  toolMeta: "complete",
  toolSchemas: "complete",
  resources: "complete",
  resourceTemplates: "complete",
  prompts: "complete",
  skills: "complete",
  listHints: "complete",
} as const;

export const CONTEXT_A = {
  transport: "streamable-http",
  protocolVersion: "2025-11-25",
  clientExtensions: ["io.modelcontextprotocol/ui"],
};

export function storedEvidence(
  overrides: Partial<{
    latestAttempt: unknown;
    secondContext: boolean;
    clientExtensions: string[];
  }> = {},
): StoredServerEvidence {
  return {
    inspection: {
      snapshot: {
        serverId: "srv",
        transport: "streamable-http",
        discovery: {
          protocolVersion: "2025-11-25",
          serverInfo: { name: "atlas-workspace", version: "1.8.0" },
          capabilities: { tools: { listChanged: true }, resources: {} },
        },
        tools: [
          {
            name: "create_board",
            description: "Create a board.",
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: false },
          },
        ],
        resources: [{ uri: "file:///readme.md", name: "readme" }],
        resourceTemplates: [],
        prompts: [],
        skills: [],
        coverage: COMPLETE,
      },
      latestEnvelopeVersion: 3,
      latestCapturedAt: CAPTURED_AT,
      latestCaptureContextHash: CTX_A,
      latestCaptureContext: overrides.clientExtensions
        ? { ...CONTEXT_A, clientExtensions: overrides.clientExtensions }
        : CONTEXT_A,
      latestAttempt: overrides.latestAttempt,
    },
    probeResults: [
      {
        contextHash: CTX_A,
        captureContext: CONTEXT_A,
        probes: [],
        failures: [
          { probeId: "server-card", status: "failed", at: CAPTURED_AT, detail: "404" },
        ],
        updatedAt: CAPTURED_AT,
      },
      ...(overrides.secondContext
        ? [
            {
              contextHash: CTX_B,
              captureContext: {
                transport: "streamable-http",
                protocolVersion: "2026-07-28",
              },
              probes: [],
              updatedAt: CAPTURED_AT - 60_000,
            },
          ]
        : []),
    ],
    observations: [
      {
        featureId: "tools.list",
        contextHash: CTX_A,
        count: 3,
        firstSeenAt: CAPTURED_AT,
        lastSeenAt: CAPTURED_AT,
        lastSource: "rpc",
      },
    ],
  };
}

export function evaluate(
  stored: StoredServerEvidence,
  options: { connected: boolean; checks?: CheckResultEvidence[] } = {
    connected: true,
  },
): ServerFeatureEvaluation {
  const selected = selectServerEvidence(stored, options);
  return evaluateServerFeatures(SERVER_FEATURE_CATALOG, selected.input);
}

/** Nothing saved and never connected: every feature is "Not checked yet". */
export function neverConnectedEvaluation(): ServerFeatureEvaluation {
  return evaluateServerFeatures(SERVER_FEATURE_CATALOG, { connected: false });
}

export { SERVER_FEATURE_CATALOG };
