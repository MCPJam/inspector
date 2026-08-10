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
  revokeLocalComputerConsent,
  verifyStoredLocalComputerConsent,
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

  it("grant stores the minted token and sends the verified bearer", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { token: "tok_".padEnd(40, "x"), grantedAt: "2026-08-09" }),
    );
    expect(await grantLocalComputerConsent("workos-jwt")).toBe(true);
    expect(loadStoredLocalComputerConsent()?.token).toMatch(/^tok_/);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/api/mcp/computers/local-consent/grant");
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer workos-jwt",
    );
  });

  it("a failed grant stores nothing", async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: "unauthorized" }));
    expect(await grantLocalComputerConsent("workos-jwt")).toBe(false);
    expect(loadStoredLocalComputerConsent()).toBeNull();
  });

  it("verify: a definitive server NO clears the stale token (re-prompt path)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { token: "tok_".padEnd(40, "x"), grantedAt: "now" }),
    );
    await grantLocalComputerConsent("workos-jwt");

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { valid: false }));
    expect(await verifyStoredLocalComputerConsent("workos-jwt")).toBe(false);
    expect(loadStoredLocalComputerConsent()).toBeNull();
  });

  it("verify: a network failure does NOT clear (capability may still be good)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { token: "tok_".padEnd(40, "x"), grantedAt: "now" }),
    );
    await grantLocalComputerConsent("workos-jwt");

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await verifyStoredLocalComputerConsent("workos-jwt")).toBe(false);
    expect(loadStoredLocalComputerConsent()).not.toBeNull();
  });

  it("verify: a stale 'no' for token A does NOT delete a replacement token B", async () => {
    // Grant A, then a concurrent grant rotates to B while A's verify is in
    // flight; A's late valid:false must not clobber B.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { token: "tokA".padEnd(40, "a"), grantedAt: "now" }),
    );
    await grantLocalComputerConsent("workos-jwt");

    let resolveVerify: (r: Response) => void = () => {};
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((r) => {
        resolveVerify = r;
      }),
    );
    const verifyPromise = verifyStoredLocalComputerConsent("workos-jwt");

    // Token B lands mid-flight.
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { token: "tokB".padEnd(40, "b"), grantedAt: "now" }),
    );
    await grantLocalComputerConsent("workos-jwt");

    resolveVerify(jsonResponse(200, { valid: false }));
    expect(await verifyPromise).toBe(false);
    expect(loadStoredLocalComputerConsent()?.token).toMatch(/^tokB/);
  });

  it("verify without a stored token never calls the server", async () => {
    expect(await verifyStoredLocalComputerConsent("workos-jwt")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
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
      expect(await grantLocalComputerConsent("workos-jwt")).toBe(false);
      expect(loadStoredLocalComputerConsent()).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });

  it("revoke forgets locally even when the server call fails", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { token: "tok_".padEnd(40, "x"), grantedAt: "now" }),
    );
    await grantLocalComputerConsent("workos-jwt");

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await revokeLocalComputerConsent("workos-jwt");
    expect(loadStoredLocalComputerConsent()).toBeNull();
  });

  it("reads garbage storage as absent", () => {
    localStorage.setItem("mcp-local-computer-consent-v1", '{"token":123}');
    expect(loadStoredLocalComputerConsent()).toBeNull();
    clearStoredLocalComputerConsent();
  });
});
