import {
  readProtocolVersionRefusal,
  type ProtocolVersionRefusal,
} from "@/shared/conformance-connection";
import type {
  OAuthSuiteState,
  ProtocolSuiteState,
  ProtocolVersionPin,
} from "@/hooks/conformance-suite-state";

export interface ConformanceFailureCase {
  id: string;
  status: string;
  error?: unknown;
  details?: unknown;
}

export function conformanceVersionRefusal(
  checks: readonly ConformanceFailureCase[],
  protocolVersion?: string | null,
): ProtocolVersionRefusal | undefined {
  for (const check of checks) {
    // This check deliberately sends a bogus version; its rejection is not
    // evidence about the version selected for the run.
    if (
      check.status !== "failed" ||
      check.id === "modern-unsupported-version-error"
    )
      continue;
    const refusal = readProtocolVersionRefusal(
      { cause: check.error, details: check.details },
      protocolVersion ?? undefined,
    );
    if (refusal) return refusal;
  }
  return undefined;
}

export function liveConformanceVersionRefusal(
  protocol: ProtocolSuiteState,
  oauth: OAuthSuiteState,
  pin: ProtocolVersionPin,
) {
  const version = pin === "auto" ? undefined : pin;
  return (
    conformanceVersionRefusal(
      protocol.result?.checks ?? [],
      protocol.result?.protocolVersion ?? version,
    ) ??
    conformanceVersionRefusal(
      oauth.result?.steps.map((step) => ({ ...step, id: step.step })) ?? [],
      oauth.result?.protocolVersion,
    ) ??
    conformanceVersionRefusal(
      [protocol.error, oauth.error].map((error) => ({
        id: "execution",
        status: "failed",
        error,
      })),
      version,
    )
  );
}
