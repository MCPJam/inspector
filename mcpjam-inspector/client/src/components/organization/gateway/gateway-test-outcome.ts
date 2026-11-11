/**
 * What the gateway editor makes of a connection Test, whichever side ran it:
 * the alert it shows, the field focus moves to, the APIs and models it fills
 * in, and the name it suggests. Pure, so each outcome is testable on its own.
 */
import {
  GATEWAY_APIS,
  GATEWAY_API_LABELS,
  gatewayBaseKey,
  gatewayHost,
  type GatewayApi,
  type GatewayConnectionTestResult,
  type GatewayModel,
} from "@/shared/gateway-connection";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import type { GatewayRuntimeLocation } from "./gateway-works-with";

export type GatewayField = "baseUrl" | "secret";

/** A Test that returned, or one that couldn't run (rate limit, network). */
export type GatewayTestResponse =
  GatewayConnectionTestResult | { error: string };

export type GatewayTestOutcome = {
  tone: "success" | "warning" | "destructive";
  title: string;
  message?: string;
  /** The field focus moves to, when one is at fault. */
  focus?: GatewayField;
  /** MCPJam's servers refused a private address: running from the Inspector is the fix. */
  offerInspector?: boolean;
  /** Which side ran the Test; absent when it couldn't run. */
  testedFrom?: string;
};

export function testedFromLabel(origin: "backend" | "inspector"): string {
  return origin === "inspector"
    ? "Tested from your Inspector"
    : "Tested from MCPJam's servers";
}

function statusTitle(status: number | undefined): string {
  if (status === 401) return "The provider needs a valid API key";
  if (status === 403) return "The provider refused the request";
  return "The provider test failed. Check the base URL and key, then test again.";
}

/** A 401 is the key; a 404 is the address. A 403 is the provider's own policy. */
function statusFocus(status: number | undefined): GatewayField | undefined {
  if (status === 401) return "secret";
  if (status === 404) return "baseUrl";
  return undefined;
}

const listLabels = (apis: readonly GatewayApi[]) =>
  apis.map((api) => GATEWAY_API_LABELS[api]).join(", ");

export function gatewayTestOutcome(
  response: GatewayTestResponse,
): GatewayTestOutcome {
  if ("error" in response) {
    return {
      tone: "destructive",
      title: "Could not start the provider test. Try again.",
      message: response.error,
    };
  }
  const testedFrom = testedFromLabel(response.origin);
  if (response.refusal) {
    return {
      tone: "destructive",
      title:
        response.origin === "inspector"
          ? "Your Inspector won't call this URL"
          : "MCPJam's servers won't call this URL",
      message: response.refusal.message,
      focus: "baseUrl",
      offerInspector:
        response.origin === "backend" &&
        response.refusal.code === "endpoint_private",
      testedFrom,
    };
  }
  if (!response.reachable) {
    return {
      tone: "destructive",
      title:
        "Couldn't reach the provider. Check the base URL, then test again.",
      message: response.message,
      focus: "baseUrl",
      testedFrom,
    };
  }
  const status = response.status;
  if (status !== undefined && (status < 200 || status >= 300)) {
    return {
      tone: "destructive",
      title: statusTitle(status),
      message: response.message,
      focus: statusFocus(status),
      testedFrom,
    };
  }
  if (response.message) {
    return {
      tone: "warning",
      title: "The provider listed no models",
      message: response.message,
      testedFrom,
    };
  }
  const tried = GATEWAY_APIS.filter((api) => response.apis[api]);
  const failed = tried.filter((api) => response.apis[api]?.result === "failed");
  const answered = tried.filter((api) => response.apis[api]?.result === "ok");
  const firstFailure = failed.length > 0 ? response.apis[failed[0]] : undefined;
  if (failed.length > 0 && answered.length === 0) {
    return {
      tone: "destructive",
      title: "No API answered. Check the base URL and key, then test again.",
      message: firstFailure?.message,
      focus: statusFocus(firstFailure?.status),
      testedFrom,
    };
  }
  if (failed.length > 0) {
    return {
      tone: "warning",
      title: `${listLabels(failed)} didn't answer`,
      message: firstFailure?.message,
      testedFrom,
    };
  }
  const models = response.models.length;
  return {
    tone: "success",
    title: "Connected",
    message: `${models} ${models === 1 ? "model" : "models"} listed. ${
      answered.length > 0
        ? `${listLabels(answered)} answered.`
        : "No API was tried."
    }`,
    testedFrom,
  };
}

/**
 * What a Test from this Inspector shows instead of running, or null when it
 * can run. The Inspector never sees a saved connection's key, so probing a
 * keyed gateway without one typed would report a working gateway as
 * rejecting its key.
 */
export function inspectorTestKeyOutcome(
  existing: Pick<OrgModelProvider, "hasSecret"> | null,
  runtimeLocation: GatewayRuntimeLocation,
  secret: string,
): GatewayTestOutcome | null {
  if (runtimeLocation !== "local" || !existing?.hasSecret || secret.trim()) {
    return null;
  }
  return {
    tone: "warning",
    title: "Your Inspector can't use the saved key",
    message: "Enter the API key, then test again.",
    focus: "secret",
  };
}

/** The APIs that answered, in the editor's order. */
export function apisFromTest(
  result: GatewayConnectionTestResult,
): GatewayApi[] {
  return GATEWAY_APIS.filter((api) => result.apis[api]?.result === "ok");
}

/**
 * The model list after a Test: every listed model, with the Test's suggested
 * mapping where the admin hasn't mapped it yet. An admin's mapping and
 * capability corrections survive a re-test, and models the gateway no longer
 * lists stay until the admin removes them.
 */
export function modelsFromTest(
  result: GatewayConnectionTestResult,
  current: readonly GatewayModel[],
): GatewayModel[] {
  const byName = new Map(current.map((model) => [model.nativeModelId, model]));
  const listed = result.models.map((suggestion): GatewayModel => {
    const kept = byName.get(suggestion.nativeModelId);
    if (kept?.modelId || !suggestion.suggestedModelId) {
      return kept ?? { nativeModelId: suggestion.nativeModelId };
    }
    return {
      ...kept,
      nativeModelId: suggestion.nativeModelId,
      modelId: suggestion.suggestedModelId,
      ...(suggestion.suggestionSource
        ? { mappingSource: suggestion.suggestionSource }
        : {}),
    };
  });
  const names = new Set(listed.map((model) => model.nativeModelId));
  return [
    ...listed,
    ...current.filter((model) => !names.has(model.nativeModelId)),
  ];
}

const GENERIC_HOST_LABELS = new Set(["www", "api", "gateway", "llm", "ai"]);

const NAME_FALLBACK = "custom-provider";

/** A provider name from its host: `litellm.acme.internal` → `litellm`. */
export function suggestedGatewayName(baseUrl: string): string {
  const host = gatewayHost(baseUrl)?.replace(/:\d+$/, "") ?? "";
  if (!host || /^[\d.]+$/.test(host) || host.startsWith("["))
    return NAME_FALLBACK;
  return (
    host.split(".").find((label) => !GENERIC_HOST_LABELS.has(label)) ??
    NAME_FALLBACK
  );
}

/**
 * Why a save would be refused for repointing a keyed connection without its
 * key, or null. The backend refuses the same save with the same sentence.
 */
export function baseUrlKeyProblem(
  existing: Pick<OrgModelProvider, "baseUrl" | "hasSecret"> | null,
  baseUrl: string,
  secret: string,
): string | null {
  if (!existing?.hasSecret || secret.trim() || !baseUrl.trim()) return null;
  if (
    existing.baseUrl !== undefined &&
    gatewayBaseKey(existing.baseUrl) === gatewayBaseKey(baseUrl)
  ) {
    return null;
  }
  return `Changing the base URL needs the API key again. Enter the key for ${
    gatewayHost(baseUrl) ?? baseUrl.trim()
  }.`;
}
