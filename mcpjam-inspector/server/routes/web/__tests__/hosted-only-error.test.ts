import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  ErrorCode,
  FEATURE_REQUIRES_HOSTED,
  WebRouteError,
  hostedOnlyResponse,
  hostedOnlyRouteError,
  mapRuntimeError,
  webErrorFromRoute,
} from "../errors.js";
import {
  ServiceCredentialUnavailableError,
  requireServiceCredential,
} from "../../../services/service-credential.js";
import { getInternalBackendConfig } from "../../../services/internal-backend.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hosted-only route error", () => {
  it("is FEATURE_NOT_SUPPORTED with a stable reason, the feature and the hosted URL", () => {
    const error = hostedOnlyRouteError("Saving browser profiles");
    expect(error).toBeInstanceOf(WebRouteError);
    expect(error.status).toBe(422);
    expect(error.code).toBe(ErrorCode.FEATURE_NOT_SUPPORTED);
    expect(error.details).toEqual({
      reason: FEATURE_REQUIRES_HOSTED,
      feature: "Saving browser profiles",
      hostedUrl: "https://app.mcpjam.com",
    });
    expect(error.message).toMatch(/only available in the hosted MCPJam app/);
  });

  it("names a configured hosted origin, and falls back when it is invalid", () => {
    vi.stubEnv("MCPJAM_HOSTED_API_URL", "https://staging.mcpjam.com");
    expect(hostedOnlyRouteError("X").details?.hostedUrl).toBe(
      "https://staging.mcpjam.com",
    );
    vi.stubEnv("MCPJAM_HOSTED_API_URL", "http://evil.example");
    expect(hostedOnlyRouteError("X").details?.hostedUrl).toBe(
      "https://app.mcpjam.com",
    );
  });

  it("mapRuntimeError turns a thrown ServiceCredentialUnavailableError into it", () => {
    const mapped = mapRuntimeError(
      new ServiceCredentialUnavailableError("Org model providers"),
    );
    expect(mapped.status).toBe(422);
    expect(mapped.code).toBe(ErrorCode.FEATURE_NOT_SUPPORTED);
    expect(mapped.details?.reason).toBe(FEATURE_REQUIRES_HOSTED);
    expect(mapped.details?.feature).toBe("Org model providers");
    // A self-hosted build's missing credential pages nobody.
    expect(mapped.captured).not.toBe(true);
  });

  it("covers getInternalBackendConfig's missing-credential throw too", () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://backend.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    let thrown: unknown;
    try {
      getInternalBackendConfig("Slack linking");
    } catch (error) {
      thrown = error;
    }
    expect(mapRuntimeError(thrown).details?.feature).toBe("Slack linking");
  });

  it("serializes the same envelope from a route", async () => {
    const app = new Hono();
    app.get("/explicit", (c) => hostedOnlyResponse(c, "Bench"));
    app.get("/thrown", () => {
      requireServiceCredential("Score", {});
      return new Response("unreachable");
    });
    app.onError((error, c) => webErrorFromRoute(c, mapRuntimeError(error)));

    for (const [path, feature] of [
      ["/explicit", "Bench"],
      ["/thrown", "Score"],
    ] as const) {
      const response = await app.request(path);
      expect(response.status).toBe(422);
      const body = await response.json();
      expect(body).toMatchObject({
        code: "FEATURE_NOT_SUPPORTED",
        details: { reason: "FEATURE_REQUIRES_HOSTED", feature },
      });
    }
  });
});
