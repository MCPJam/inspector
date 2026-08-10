import { beforeEach, describe, expect, it, vi } from "vitest";

// authFetch adds session plumbing irrelevant here; a plain passthrough keeps
// the tests about THIS module's contract (headers, storage effects).
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session-token", () => ({
  authFetch: (input: RequestInfo | URL, init?: RequestInit) =>
    fetchMock(input, init),
}));

import {
  clearStoredLocalComputerConsent,
  grantLocalComputerConsent,
  loadStoredLocalComputerConsent,
  mintLocalComputerConsent,
  persistLocalComputerConsent,
  revokeLocalComputerConsentOnServer,
} from "../local-computer-consent";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("local-computer-consent client", () => {
  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
  });

  it("grant stores the token; does NOT set Authorization (authFetch owns it)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { token: "tok_".padEnd(40, "x"), grantedAt: "2026-08-09" }),
    );
    expect(await grantLocalComputerConsent()).toBe(true);
    expect(loadStoredLocalComputerConsent()?.token).toMatch(/^tok_/);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/api/mcp/computers/local-consent/grant");
    // A manual Authorization would trip authFetch's callerProvidedAuthorization
    // guard and disable the on-401 session-token refresh.
    expect(
      (init?.headers as Record<string, string>).Authorization,
    ).toBeUndefined();
  });

  it("a failed grant stores nothing", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));
    expect(await grantLocalComputerConsent()).toBe(false);
    expect(loadStoredLocalComputerConsent()).toBeNull();
  });

  it("mint returns the token WITHOUT persisting (the hook persists separately)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { token: "tok_".padEnd(40, "x"), grantedAt: "now" }),
    );
    const minted = await mintLocalComputerConsent();
    expect(minted?.token).toMatch(/^tok_/);
    // Mint is network-only — nothing is written to storage yet.
    expect(loadStoredLocalComputerConsent()).toBeNull();
  });

  it("persist stores a minted token and returns true", () => {
    expect(
      persistLocalComputerConsent({ token: "tok_abc".padEnd(40, "x"), grantedAt: "now" }),
    ).toBe(true);
    expect(loadStoredLocalComputerConsent()?.token).toMatch(/^tok_abc/);
  });

  it("grant reports FALSE when persistence fails — no phantom granted state", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { token: "tok_".padEnd(40, "x"), grantedAt: "now" }),
    );
    const setItem = vi
      .spyOn(localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("quota exceeded");
      });
    try {
      expect(await grantLocalComputerConsent()).toBe(false);
      expect(loadStoredLocalComputerConsent()).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });

  it("server revoke is storage-free (the hook clears storage separately)", async () => {
    // The revoke primitive must NOT touch localStorage — that separation is
    // what stops a slow revoke from deleting a token a newer grant just stored.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { token: "tok_".padEnd(40, "x"), grantedAt: "now" }),
    );
    await grantLocalComputerConsent();
    expect(loadStoredLocalComputerConsent()).not.toBeNull();

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await revokeLocalComputerConsentOnServer();
    // Storage is untouched by the server primitive.
    expect(loadStoredLocalComputerConsent()).not.toBeNull();
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toBe(
      "/api/mcp/computers/local-consent/revoke",
    );
  });

  it("server revoke is token-scoped when given a token, bodiless otherwise", async () => {
    // Scoped: the server must receive the token being revoked so a delayed
    // revoke can't sever a capability a newer grant rotated in.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await revokeLocalComputerConsentOnServer("tok_scoped".padEnd(40, "x"));
    const [, scopedInit] = fetchMock.mock.calls.at(-1)!;
    expect(JSON.parse(String(scopedInit?.body))).toEqual({
      token: "tok_scoped".padEnd(40, "x"),
    });

    // No stored token → no body → the server unlinks unconditionally.
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    await revokeLocalComputerConsentOnServer();
    const [, bareInit] = fetchMock.mock.calls.at(-1)!;
    expect(bareInit?.body).toBeUndefined();
  });

  it("server revoke swallows a network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(revokeLocalComputerConsentOnServer()).resolves.toBeUndefined();
  });

  it("reads garbage storage as absent", () => {
    localStorage.setItem("mcp-local-computer-consent-v1", '{"token":123}');
    expect(loadStoredLocalComputerConsent()).toBeNull();
    clearStoredLocalComputerConsent();
  });
});
