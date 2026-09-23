import { FALLBACK_HINT } from "../../src/oauth/state-machines/shared/dynamic-client-registration.js";
import {
  describeAuthenticatedRequestFailure,
  describeTokenRequestFailure,
  responseFailureFindingKey,
} from "../../src/oauth/state-machines/shared/response-error.js";
import { stepFailureFindingKey } from "../../src/oauth/state-machines/shared/step-failure-key.js";

const tokenFailure = (status: number, statusText: string, body: unknown) =>
  describeTokenRequestFailure({ status, statusText, body } as never);

describe("responseFailureFindingKey", () => {
  // Round-trips through the real writer, so the parser cannot drift from the
  // format it reads.
  it("keeps label, status and the OAuth error code", () => {
    expect(
      responseFailureFindingKey(
        tokenFailure(400, "Bad Request", {
          error: "invalid_grant",
          error_description: "Authorization code not found or expired",
        }),
      ),
    ).toBe("Token request failed: 400: invalid_grant");
  });

  it("gives one finding one key across servers' wording", () => {
    // PLB-63 and INSPECTOR-CLIENT-2GA: the same `invalid_*` code, phrased and
    // status-texted differently by different servers.
    const a = tokenFailure(400, "Bad Request", {
      error: "invalid_client",
      error_description: "client 3f9a1c27 not found",
    });
    const b = tokenFailure(400, "", {
      error: "invalid_client",
      error_description: "invalid_client_secret",
    });
    const c = tokenFailure(400, "Client Error", { error: "invalid_client" });
    expect(new Set([a, b, c].map(responseFailureFindingKey))).toEqual(
      new Set(["Token request failed: 400: invalid_client"]),
    );
  });

  it("keeps different codes apart", () => {
    expect(
      responseFailureFindingKey(tokenFailure(400, "", { error: "invalid_grant" })),
    ).not.toBe(
      responseFailureFindingKey(tokenFailure(400, "", { error: "invalid_client" })),
    );
  });

  it("falls back to label and status when the reason opens with no code", () => {
    expect(
      responseFailureFindingKey(
        tokenFailure(503, "Service Unavailable", "<html>upstream down</html>"),
      ),
    ).toBe("Token request failed: 503");
  });

  it("reads the authenticated-request form too", () => {
    expect(
      responseFailureFindingKey(
        describeAuthenticatedRequestFailure({
          status: 401,
          statusText: "Unauthorized",
          body: { error: "invalid_token", error_description: "expired at 12:03" },
        } as never),
      ),
    ).toBe("Authenticated request failed: 401: invalid_token");
  });

  it("is undefined for anything that is not a response failure", () => {
    expect(responseFailureFindingKey("Dynamic Client Registration failed (400).")).toBeUndefined();
  });
});

describe("stepFailureFindingKey", () => {
  it("keeps a registration failure together with and without the advisory", () => {
    // Both registration forms: the error ending in a period plus " HINT", and
    // the one without a period plus ". HINT".
    expect(
      stepFailureFindingKey(`Dynamic Client Registration failed (401). ${FALLBACK_HINT}`),
    ).toBe(stepFailureFindingKey("Dynamic Client Registration failed (401)."));
    expect(
      stepFailureFindingKey(`Client registration failed: fetch failed. ${FALLBACK_HINT}`),
    ).toBe(stepFailureFindingKey("Client registration failed: fetch failed"));
  });

  it("keeps different registration statuses apart", () => {
    expect(stepFailureFindingKey("Dynamic Client Registration failed (400).")).not.toBe(
      stepFailureFindingKey("Dynamic Client Registration failed (401)."),
    );
  });

  // Review of #5473: the cause of a discovery failure comes AFTER the first
  // period, so cutting there merged all three into one issue.
  it("keeps discovery failures with different causes apart", () => {
    const prefix = "Could not discover authorization server metadata. Last error:";
    const keys = [
      `${prefix} undefined`,
      `${prefix} HTTP 500 from https://auth.example.com/.well-known/oauth-authorization-server`,
      `${prefix} Failed to fetch`,
    ].map(stepFailureFindingKey);
    expect(new Set(keys).size).toBe(3);
  });

  it("keeps one discovery cause together across servers' URLs", () => {
    const prefix = "Could not discover authorization server metadata. Last error:";
    expect(
      stepFailureFindingKey(`${prefix} HTTP 500 from https://a.example/.well-known/x`),
    ).toBe(stepFailureFindingKey(`${prefix} HTTP 500 from https://b.example/other`));
  });

  it("replaces ids that would split one finding per request", () => {
    expect(
      stepFailureFindingKey("Failed to request resource metadata: trace 4f2a9c81e7b34d0aa1c2 rejected"),
    ).toBe(
      stepFailureFindingKey("Failed to request resource metadata: trace 9b1d77e0c4aa4f2e8830 rejected"),
    );
    expect(
      stepFailureFindingKey("x 123e4567-e89b-12d3-a456-426614174000 y"),
    ).toBe("x <id> y");
  });

  it("leaves ordinary words alone", () => {
    // Long, but no digit: not an id.
    expect(
      stepFailureFindingKey("Protected resource metadata is missing authorization_servers."),
    ).toBe("Protected resource metadata is missing authorization_servers");
  });

  it("caps the key, so no message yields an unbounded number of keys", () => {
    expect(stepFailureFindingKey(`Boom: ${"word ".repeat(200)}`).length).toBeLessThanOrEqual(160);
  });

  it("reduces a token failure through the response rule", () => {
    expect(
      stepFailureFindingKey(
        tokenFailure(400, "Bad Request", { error: "invalid_grant", error_description: "nope" }),
      ),
    ).toBe("Token request failed: 400: invalid_grant");
  });
});
