import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeGuestMintFailure,
  mintGuestToken,
  type GuestMintFailureReason,
} from "../src/guestMint.js";
import { getBearerToken } from "../src/server.js";

const MINT_URL = "http://localhost:6274/api/web/guest-token";

function env(overrides: Partial<Env> = {}): Env {
  return {
    MCPJAM_GUEST_MINT_URL: MINT_URL,
    MCPJAM_INSPECTOR_SERVICE_TOKEN: "service-token",
    ...overrides,
  } as unknown as Env;
}

function stubMint(respond: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async () => respond());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mintGuestToken", () => {
  it("returns the minted token and its expiry", async () => {
    const expiresAt = Date.now() + 3_600_000;
    stubMint(() => Response.json({ token: "guest-jwt", expiresAt }));

    await expect(mintGuestToken(env(), "203.0.113.7")).resolves.toEqual({
      ok: true,
      token: "guest-jwt",
      expiresAt,
    });
  });

  it.each<[number, GuestMintFailureReason]>([
    [401, "rejected"],
    [403, "rejected"],
    [429, "rate_limited"],
    [503, "unavailable"],
    [404, "unavailable"],
  ])("maps a %i from the mint route to %s", async (status, reason) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubMint(() => Response.json({ error: "nope" }, { status }));

    await expect(mintGuestToken(env(), undefined)).resolves.toEqual({
      ok: false,
      failure: { reason, status },
    });
  });

  it("logs which credentials to align when the service token is refused", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    stubMint(() => new Response("unauthorized", { status: 401 }));

    await mintGuestToken(env(), undefined);

    const logged = String(errors.mock.calls[0]?.[0]);
    expect(logged).toContain(MINT_URL);
    expect(logged).toContain("INSPECTOR_SERVICE_TOKEN");
    expect(logged).toContain("ALLOW_LOCAL_DEV_SERVICE_TOKEN");
    expect(logged).not.toContain("service-token\"");
  });

  it("reports an unreachable mint route as unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubMint(() => {
      throw new TypeError("fetch failed");
    });

    await expect(mintGuestToken(env(), undefined)).resolves.toEqual({
      ok: false,
      failure: { reason: "unavailable" },
    });
  });

  it.each([
    ["a non-JSON body", () => new Response("<html>", { status: 200 })],
    ["no token", () => Response.json({ expiresAt: 1 })],
  ])("reports %s as an invalid response", async (_label, respond) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubMint(respond);

    await expect(mintGuestToken(env(), undefined)).resolves.toEqual({
      ok: false,
      failure: { reason: "invalid_response", status: 200 },
    });
  });

  it("does not call out when the mint credentials are missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = stubMint(() => Response.json({}));

    await expect(
      mintGuestToken(
        env({ MCPJAM_INSPECTOR_SERVICE_TOKEN: undefined }),
        undefined
      )
    ).resolves.toEqual({ ok: false, failure: { reason: "not_configured" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("describeGuestMintFailure", () => {
  it.each<GuestMintFailureReason>([
    "not_configured",
    "rejected",
    "rate_limited",
    "unavailable",
    "invalid_response",
  ])("gives %s a next step and no bearer jargon", (reason) => {
    const text = describeGuestMintFailure({ reason });
    expect(text).toMatch(/sign in to MCPJam/i);
    expect(text).not.toMatch(/bearer/i);
  });
});

describe("getBearerToken", () => {
  it("passes a verified token through without minting", async () => {
    const fetchMock = stubMint(() => Response.json({}));

    await expect(
      getBearerToken(env(), "user-jwt", undefined)
    ).resolves.toEqual({ ok: true, token: "user-jwt" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the mint failure and retries on the next call", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ip = "198.51.100.23";
    const fetchMock = stubMint(
      () => new Response("unauthorized", { status: 401 })
    );

    await expect(getBearerToken(env(), undefined, ip)).resolves.toEqual({
      ok: false,
      failure: { reason: "rejected", status: 401 },
    });

    fetchMock.mockImplementation(async () =>
      Response.json({ token: "guest-jwt", expiresAt: Date.now() + 3_600_000 })
    );
    await expect(getBearerToken(env(), undefined, ip)).resolves.toEqual({
      ok: true,
      token: "guest-jwt",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
