import {
  describeError,
  ERROR_CATALOG,
  sanitizeTraceErrorMessage,
  type NormalizedError,
} from "@mcpjam/sdk/browser";
import { isRecord } from "./host-capabilities";
import {
  readCredentialRefusal,
  type CredentialRefusal,
} from "./credential-refusal";
import {
  redactStackLikeText,
  withTechnicalDetails,
} from "./error-technical-details";
import { isSessionRevokedBody } from "./auth/session-revoked";

export type ConnectionFailureFacts = {
  code?: "SIGN_IN_REQUIRED" | "SESSION_REVOKED";
  credentialRefusal?: CredentialRefusal;
};

export type ConnectionErrorPresentation = {
  title: string;
  explanation: string;
  recovery: "settings" | "sign-in" | "reconnect" | "copy-details";
  diagnostics: NormalizedError;
};

const record = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};
const clean = (value: unknown, limit = 2_000): string =>
  typeof value === "string"
    ? sanitizeTraceErrorMessage(value, { maxLength: limit }).replace(
        /\u0000/g,
        "",
      )
    : "";

export function readConnectionFailureFacts(
  input: unknown,
): ConnectionFailureFacts {
  const source = record(input);
  const facts = isRecord(source.failureFacts) ? source.failureFacts : source;
  const details = record(source.details);
  const code =
    facts.code ?? source.rawCode ?? record(source.normalized).rawCode;
  const revoked = isSessionRevokedBody({ code, details });
  const refusalFrom = (value: Record<string, unknown>) => {
    const kind = record(value.credentialRefusal).kind;
    return kind === "origin_mismatch" ||
      kind === "export_denied" ||
      value.secretOriginMismatch === true ||
      value.exportDenied === true
      ? readCredentialRefusal(value)
      : null;
  };
  const refusal = refusalFrom(facts) ?? refusalFrom(details);
  return {
    ...(code === "SIGN_IN_REQUIRED" || details.reason === "SIGN_IN_REQUIRED"
      ? { code: "SIGN_IN_REQUIRED" as const }
      : revoked
        ? { code: "SESSION_REVOKED" as const }
        : {}),
    ...(refusal
      ? {
          credentialRefusal:
            refusal.kind === "export_denied"
              ? refusal
              : {
                  kind: "origin_mismatch" as const,
                  boundOrigin: clean(refusal.boundOrigin, 240) || null,
                  targetOrigin: clean(refusal.targetOrigin, 240) || null,
                },
        }
      : {}),
  };
}

export function connectionFailureFields(input: unknown) {
  return {
    normalized: readConnectionDiagnostics(input),
    failureFacts: readConnectionFailureFacts(input),
  };
}

export function readConnectionDiagnostics(input: unknown): NormalizedError {
  const source = record(input);
  const wire = isRecord(source.normalized) ? source.normalized : source;
  const message = clean(
    wire.rawMessage ?? source.message ?? source.error ?? input,
  );
  const local = describeError({ message, code: wire.rawCode ?? source.code });
  const entry =
    Object.values(ERROR_CATALOG).find((item) => item.slug === wire.slug) ??
    Object.values(ERROR_CATALOG).find((item) => item.slug === local.slug) ??
    ERROR_CATALOG["internal/unknown"];
  const captured = withTechnicalDetails(
    { ...entry, rawMessage: message },
    input,
  );
  const cause = record(wire.cause);
  const rawCode = wire.rawCode ?? source.code;
  const origin = wire.origin;
  return {
    ...entry,
    rawMessage: [
      message,
      wire.slug && wire.slug !== entry.slug
        ? `Reported slug: ${clean(wire.slug, 120)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    ...(typeof rawCode === "string"
      ? { rawCode: clean(rawCode, 120) }
      : typeof rawCode === "number" && Number.isFinite(rawCode)
        ? { rawCode }
        : {}),
    ...(typeof cause.name === "string" && typeof cause.message === "string"
      ? {
          cause: {
            name: clean(cause.name, 120),
            message: clean(cause.message),
          },
        }
      : {}),
    ...(origin === "mcpjam" ||
    origin === "user_server" ||
    origin === "user_config" ||
    origin === "ambiguous"
      ? { origin }
      : {}),
    requestId: clean(wire.requestId ?? captured.requestId, 240) || undefined,
    errorType: clean(wire.errorType ?? captured.errorType, 120) || undefined,
    stack:
      redactStackLikeText(
        typeof wire.stack === "string" ? wire.stack : captured.stack,
      ) || undefined,
  };
}

export function presentConnectionError(
  input: unknown,
  context: {
    serverName: string;
    operation?: "connect" | "reconnect" | "authorize";
    facts?: ConnectionFailureFacts;
    oauthStage?: string;
    recoveries?: readonly ConnectionErrorPresentation["recovery"][];
  },
): ConnectionErrorPresentation {
  const diagnostics = readConnectionDiagnostics(input);
  if (context.oauthStage)
    diagnostics.rawMessage += `\nOAuth stage: ${clean(context.oauthStage, 160)}`;
  const entry = ERROR_CATALOG[diagnostics.slug];
  const facts = readConnectionFailureFacts(context.facts ?? input);
  const name =
    clean(context.serverName, 160)
      .replace(/[\r\n\t]+/g, " ")
      .trim() || "this server";
  const operation = context.operation ?? "connect";
  const title =
    operation === "authorize"
      ? `Couldn't authorize ${name}.`
      : `Couldn't ${operation} to ${name}.`;
  let explanation: string;
  let recovery: ConnectionErrorPresentation["recovery"] = "settings";
  if (facts.code) {
    explanation =
      facts.code === "SESSION_REVOKED"
        ? "Your MCPJam sign-in expired. Sign in to MCPJam to continue."
        : "Sign in to MCPJam to continue.";
    recovery = "sign-in";
  } else if (facts.credentialRefusal?.kind === "export_denied") {
    explanation =
      "Your organization keeps these saved credentials in MCPJam-hosted connections. Connect from MCPJam in the browser, or ask an organization admin to change the credential export policy.";
  } else if (facts.credentialRefusal?.kind === "origin_mismatch") {
    explanation =
      "The server address changed after its credentials were saved. Open the server settings and re-enter the credentials for the new address.";
  } else if (entry.slug === "internal/unknown") {
    explanation =
      "We couldn't determine why the connection stopped. Open the server settings to review the connection, or copy the details for support.";
  } else {
    explanation = [entry.oneLine, ...entry.nextSteps]
      .join(" ")
      .replace(/\b(?:Failed to|Could not|Unable to)\b/g, "Couldn't");
    if (entry.slug === "auth/consent_required") recovery = "reconnect";
  }
  if (context.recoveries && !context.recoveries.includes(recovery))
    recovery = "copy-details";
  return { title, explanation, recovery, diagnostics };
}
