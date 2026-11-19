/**
 * The gateway editor's "Works with" list: before saving, which features and
 * harness clients this connection will serve, from the APIs it serves, where
 * its calls come from and which of its models are mapped.
 *
 * Harness rules come from the descriptors (`harnessWireApi`,
 * `harnessTakesOrgKeys`) and the evidence table, never from a vendor name:
 * Claude Code and OpenCode need Anthropic Messages, Codex and Copilot CLI need
 * Responses, Cursor runs on each user's own Cursor account. A harness also
 * needs a mapped model its evidence table supports, because a harness lease on
 * an unmapped or unverified model is refused.
 */
import {
  GATEWAY_API_LABELS,
  type GatewayApi,
  type GatewayModel,
} from "@/shared/gateway-connection";
import { HARNESS_DESCRIPTORS } from "@/shared/harness-descriptors";
import {
  harnessTakesOrgKeys,
  harnessWireApi,
} from "@/shared/harness-connection-api";
import {
  harnessDisplayName,
  harnessModelSupportAtPinnedVersion,
} from "@/shared/harness-model-support";

export type WorksWithRow = {
  id: string;
  label: string;
  ready: boolean;
  /** Why not, or a note on how it runs. */
  reason?: string;
};

export type GatewayRuntimeLocation = "cloud" | "local";

const CHAT_APIS: readonly GatewayApi[] = [
  "chatCompletions",
  "anthropicMessages",
];

const SERVERS_ONLY =
  "Runs on MCPJam's servers. Set calls to come from MCPJam's servers to use it.";
const POLICY_BLOCKS =
  "Your organization's key policy doesn't allow calls from each user's Inspector.";

/** Harness clients in descriptor order, with Cursor (no org path) last. */
const HARNESS_IDS = Object.keys(HARNESS_DESCRIPTORS).sort(
  (a, b) =>
    Number(harnessWireApi(a) === null) - Number(harnessWireApi(b) === null),
);

export const joinNames = (names: readonly string[]) =>
  names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** The harness clients that call an API, by name. */
export const harnessesOn = (api: GatewayApi) =>
  HARNESS_IDS.filter((id) => harnessWireApi(id) === api).map(
    harnessDisplayName,
  );

/** The line under each API saying which features use it. */
export function gatewayApiUsedBy(api: GatewayApi): string {
  const harnesses = harnessesOn(api);
  switch (api) {
    case "chatCompletions":
      return "Used by Playground chat, evals, judges, insights, test generation and Ask MCPJam.";
    case "anthropicMessages":
      return `Used by ${joinNames(harnesses)}, and by chat features when Chat Completions isn't served.`;
    case "responses":
      return `Used by ${joinNames(harnesses)}.`;
    case "embeddings":
      return "Used by session map embeddings.";
  }
}

type WorksWithInput = {
  apis: readonly GatewayApi[];
  runtimeLocation: GatewayRuntimeLocation;
  models: readonly GatewayModel[];
  requireOrgKeys: boolean;
};

export function gatewayWorksWith(input: WorksWithInput): WorksWithRow[] {
  const served = new Set(input.apis);
  const chat = CHAT_APIS.some((api) => served.has(api));
  const local = input.runtimeLocation === "local";

  /** A chat feature; `inInspector` when it can run in the user's Inspector. */
  const feature = (
    id: string,
    label: string,
    inInspector: boolean,
  ): WorksWithRow => {
    if (!chat) {
      return {
        id,
        label,
        ready: false,
        reason: "Needs Chat Completions or Anthropic Messages.",
      };
    }
    if (!local) return { id, label, ready: true };
    if (!inInspector) return { id, label, ready: false, reason: SERVERS_ONLY };
    if (input.requireOrgKeys)
      return { id, label, ready: false, reason: POLICY_BLOCKS };
    return { id, label, ready: true, reason: "Runs in each user's Inspector." };
  };

  const harness = (harnessId: string): WorksWithRow => {
    const label = harnessDisplayName(harnessId);
    const row = (reason?: string): WorksWithRow => ({
      id: harnessId,
      label,
      ready: reason === undefined,
      ...(reason ? { reason } : {}),
    });
    const api = harnessWireApi(harnessId);
    if (!api)
      return row(
        `${label} runs on each user's own account, never on organization connections.`,
      );
    if (!served.has(api)) {
      return row(
        `Needs ${GATEWAY_API_LABELS[api]}, which this provider doesn't serve.`,
      );
    }
    if (!harnessTakesOrgKeys(harnessId)) {
      return row(`${label} doesn't run on organization connections yet.`);
    }
    if (local) return row(SERVERS_ONLY);
    const verified = input.models.some(
      (model) =>
        model.modelId !== undefined &&
        harnessModelSupportAtPinnedVersion({
          harnessId,
          modelId: model.modelId,
        }).status === "supported",
    );
    return verified
      ? row()
      : row(
          `No model here maps to one ${label} is verified on. Map one under Models.`,
        );
  };

  return [
    feature("chat", "Playground chat", true),
    feature("evals", "Evals", true),
    feature("judges", "Judges", false),
    ...HARNESS_IDS.map(harness),
  ];
}

/** Harness clients no setting here makes ready (Cursor, say). */
const NEVER_READY = new Set(
  HARNESS_IDS.filter(
    (id) => harnessWireApi(id) === null || !harnessTakesOrgKeys(id),
  ),
);

/**
 * What a custom provider's row and configure panel flag for an admin: the
 * features a setting here could make ready but doesn't, and the models not
 * mapped to a catalog model.
 */
export function providerAttention(input: WorksWithInput) {
  const rows = gatewayWorksWith(input);
  return {
    rows,
    blocked: rows.filter((row) => !row.ready && !NEVER_READY.has(row.id)),
    unmapped: input.models.filter((model) => !model.modelId).length,
  };
}

/** "Codex and GitHub Copilot CLI unavailable", or "3 features unavailable". */
export function blockedLabel(blocked: readonly WorksWithRow[]): string | null {
  if (blocked.length === 0) return null;
  return blocked.length > 2
    ? `${blocked.length} features unavailable`
    : `${joinNames(blocked.map((row) => row.label))} unavailable`;
}
