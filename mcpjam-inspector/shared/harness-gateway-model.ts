/**
 * A harness on an organization gateway (`custom:*`): the upstream profile its
 * lease runs, whether the gateway can run one of its models for that harness,
 * and the selection lease start reads. Mirrors the backend's lease rule
 * (`harnessLeaseModel.ts`, `harnessOrgReadiness.ts`): the gateway serves the
 * API the harness speaks, its calls come from MCPJam's servers, the model maps
 * to a catalog model, and the harness's evidence table supports that catalog
 * model at the runtime version. Lease start refuses an `unknown` verdict for
 * a gateway model as well as an `unsupported` one, so only `supported` runs
 * here, Playground chat included.
 */
import { GATEWAY_API_LABELS, type GatewayApi } from "./gateway-connection";
import {
  connectionServesHarnessApi,
  harnessTakesOrgKeys,
  harnessWireApi,
  type HarnessConnection,
} from "./harness-connection-api";
import {
  harnessDisplayName,
  harnessModelSupport,
  harnessOrgProviderUnsupportedReason,
  harnessPinnedVersion,
  type HarnessOrgUpstreamProfile,
} from "./harness-model-support";

/** Whether a model id names a gateway's model (`custom:<slug>/<model>`). */
export function isGatewayModelId(modelId: string): boolean {
  return modelId.startsWith("custom:");
}

/**
 * The profile an org lease for `modelId` runs on: `org-gateway` for a gateway
 * model, else the vendor API the harness speaks. Lease start echoes the same
 * profile; this is the answer before the lease exists (the runtime
 * fingerprint, the native discovery route).
 */
export function harnessOrgUpstreamProfile(
  harnessId: string,
  modelId: string,
): HarnessOrgUpstreamProfile | undefined {
  if (isGatewayModelId(modelId)) return "org-gateway";
  switch (harnessWireApi(harnessId)) {
    case "anthropicMessages":
      return "anthropic-native";
    case "responses":
      return "openai-native";
    default:
      return undefined;
  }
}

/** A gateway connection as the visible org config describes it. */
export type HarnessGatewayConnection = HarnessConnection & {
  runtimeLocation?: "cloud" | "local";
  models?: ReadonlyArray<{ nativeModelId: string; modelId?: string }>;
};

/**
 * One gateway model as a harness reads it: the gateway (its key and APIs),
 * where its calls come from, and the catalog model the entry maps to (absent
 * when unmapped).
 */
export type HarnessGatewayModel = HarnessConnection & {
  apis: readonly GatewayApi[];
  runtimeLocation?: "cloud" | "local";
  modelId?: string;
};

/** What `connection` says about its model named `name`. */
export function gatewayModelFor(
  connection: HarnessGatewayConnection,
  name: string,
): HarnessGatewayModel {
  const modelId = connection.models?.find(
    (model) => model.nativeModelId === name,
  )?.modelId;
  return {
    providerKey: connection.providerKey,
    apis: connection.apis ?? [],
    ...(connection.runtimeLocation
      ? { runtimeLocation: connection.runtimeLocation }
      : {}),
    ...(modelId ? { modelId } : {}),
  };
}

/**
 * The gateway's own name for the model a selection names, as the backend
 * reads it (`gatewayModelName`): its native id, else the id after
 * `custom:<slug>/` (or the older `custom:<slug>:`).
 */
export function gatewayModelName(
  providerKey: string,
  selection: { modelId: string; nativeModelId?: string },
): string {
  const native = gatewayLeaseSelection(selection).nativeModelId?.trim();
  if (native) return native;
  for (const separator of ["/", ":"]) {
    const prefix = `${providerKey}${separator}`;
    if (selection.modelId.startsWith(prefix)) {
      return selection.modelId.slice(prefix.length);
    }
  }
  return selection.modelId;
}

/**
 * The catalog model a harness runs for a gateway model, or why it can't run
 * it at `runtimeVersion` (the pinned version when absent). The connection
 * problems use the backend's launch preflight words.
 */
export function gatewayHarnessModel(
  harnessId: string,
  gateway: HarnessGatewayModel,
  runtimeVersion: string | null | undefined = harnessPinnedVersion(harnessId),
): { modelId: string } | { refusal: string } {
  const api = harnessWireApi(harnessId);
  if (!api || !harnessTakesOrgKeys(harnessId)) {
    return { refusal: harnessOrgProviderUnsupportedReason(harnessId) };
  }
  const label = harnessDisplayName(harnessId);
  if (gateway.runtimeLocation === "local") {
    return {
      refusal: `This connection's calls come from each user's Inspector, so ${label} can't run on it. Choose a connection whose calls come from MCPJam's servers.`,
    };
  }
  if (!connectionServesHarnessApi(gateway, api)) {
    const name = GATEWAY_API_LABELS[api];
    return {
      refusal: `This provider doesn't serve ${name}, which ${label} needs. Turn on ${name} for it in Organization models, or choose another connection.`,
    };
  }
  if (!gateway.modelId) {
    return {
      refusal: `Map this provider model to a model in Organization models to use it with ${label}.`,
    };
  }
  const verdict = harnessModelSupport({
    harnessId,
    runtimeVersion,
    modelId: gateway.modelId,
  });
  return verdict.status === "supported"
    ? { modelId: gateway.modelId }
    : { refusal: verdict.reason };
}

/**
 * A gateway selection as lease start reads it: `nativeModelId` is the
 * gateway's own model name, which the backend matches against the gateway's
 * models. A picker row's selection carries the row id
 * (`custom:<slug>:<model>`) there instead, so that spelling is cut back to the
 * name. Every other selection is returned as it is.
 */
export function gatewayLeaseSelection<
  S extends { modelId: string; nativeModelId?: string },
>(selection: S): S {
  const row = /^(custom:[^:/]+):(.+)$/.exec(selection.nativeModelId ?? "");
  const sameGateway =
    row !== null &&
    ["/", ":"].some((separator) =>
      selection.modelId.startsWith(`${row[1]}${separator}`),
    );
  return sameGateway ? { ...selection, nativeModelId: row[2] } : selection;
}
