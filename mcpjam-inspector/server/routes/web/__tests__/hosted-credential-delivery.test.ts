import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@axiomhq/js", () => ({
  Axiom: vi.fn().mockImplementation(() => ({
    ingest: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  })),
}));

// The hosted deployment: the credential calls below run in this process and
// keep the tokens they get back.
vi.mock("../../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config.js")>()),
  HOSTED_MODE: true,
}));

import { authorizeBatch } from "../auth.js";
import { forceRefreshHostedOAuthAccessToken } from "../../../utils/hosted-oauth-refresh.js";
import { hostedCredentialDeliveryHeaders } from "../../../services/service-credential.js";

const SERVICE_TOKEN = "svc-token-for-tests-0123456789";

function sentHeaders(fetchMock: ReturnType<typeof vi.fn>) {
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
  return init?.headers as Record<string, string>;
}

describe("hostedCredentialDeliveryHeaders", () => {
  it("names the hosted Inspector only in hosted mode with a credential", () => {
    expect(
      hostedCredentialDeliveryHeaders(true, {
        INSPECTOR_SERVICE_TOKEN: SERVICE_TOKEN,
      }),
    ).toEqual({ "x-inspector-service-token": SERVICE_TOKEN });
    expect(hostedCredentialDeliveryHeaders(true, {})).toEqual({});
    expect(
      hostedCredentialDeliveryHeaders(false, {
        INSPECTOR_SERVICE_TOKEN: SERVICE_TOKEN,
      }),
    ).toEqual({});
  });
});

describe("hosted credential requests identify the hosted Inspector", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", SERVICE_TOKEN);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("batch authorize sends the service token beside the user's own bearer", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ results: {} }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await authorizeBatch({}, "user-jwt", "project-1", ["server-1"]);

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://convex.test/web/authorize-batch",
    );
    // The bearer still says who the user is; the header only says the
    // tokens stay in the hosted Inspector.
    expect(sentHeaders(fetchMock)).toMatchObject({
      Authorization: "Bearer user-jwt",
      "x-inspector-service-token": SERVICE_TOKEN,
    });
  });

  it("the hosted force-refresh sends it too", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, accessToken: "fresh-token" }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);

    await forceRefreshHostedOAuthAccessToken(
      "user-jwt",
      "project-1",
      "server-1",
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://convex.test/web/oauth/force-refresh",
    );
    expect(sentHeaders(fetchMock)).toMatchObject({
      Authorization: "Bearer user-jwt",
      "x-inspector-service-token": SERVICE_TOKEN,
    });
  });
});
