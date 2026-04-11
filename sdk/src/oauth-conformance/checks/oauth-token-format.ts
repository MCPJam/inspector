import type { OAuthFlowState } from "../../oauth/state-machines/types.js";
import type { OAuthConformanceCheckId, StepResult } from "../types.js";

export interface OAuthTokenFormatCheckOutcome {
  step: Extract<OAuthConformanceCheckId, "oauth_token_format">;
  status: StepResult["status"];
  durationMs: number;
  error?: StepResult["error"];
}

interface OAuthTokenFormatCheckInput {
  tokenRequestStep?: StepResult;
  state: Pick<OAuthFlowState, "accessToken" | "tokenType" | "expiresIn">;
}

export function runTokenFormatCheck(
  input: OAuthTokenFormatCheckInput,
): OAuthTokenFormatCheckOutcome {
  const startedAt = Date.now();
  const body =
    input.tokenRequestStep?.http?.response?.body &&
    typeof input.tokenRequestStep.http.response.body === "object"
      ? (input.tokenRequestStep.http.response.body as Record<string, unknown>)
      : undefined;

  const missingFields = [
    typeof (body?.access_token ?? input.state.accessToken) !== "string"
      ? "access_token"
      : undefined,
    typeof (body?.token_type ?? input.state.tokenType) !== "string"
      ? "token_type"
      : undefined,
  ].filter(Boolean) as string[];

  if (missingFields.length > 0) {
    return {
      step: "oauth_token_format",
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: {
        message: `Token response is missing required fields: ${missingFields.join(", ")}`,
        details: body ?? {
          access_token: input.state.accessToken,
          token_type: input.state.tokenType,
          expires_in: input.state.expiresIn,
        },
      },
    };
  }

  const expiresIn = body?.expires_in ?? input.state.expiresIn;
  if (expiresIn !== undefined && typeof expiresIn !== "number") {
    return {
      step: "oauth_token_format",
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: {
        message: "Token response field has an invalid type: expires_in must be a number when present",
        details: body ?? {
          access_token: input.state.accessToken,
          token_type: input.state.tokenType,
          expires_in: input.state.expiresIn,
        },
      },
    };
  }

  return {
    step: "oauth_token_format",
    status: "passed",
    durationMs: Date.now() - startedAt,
  };
}
