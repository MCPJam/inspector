import { describe, expect, it, vi } from "vitest";
import {
  AccountDeletionClient,
  AccountDeletionError,
} from "../../src/platform/account-deletion.js";

const capability = {
  available: true,
  protocolVersion: 1,
  scopeTypes: ["account"],
  canCancel: false,
};
const receipt = {
  requestId: "request",
  scope: { type: "account", id: "user" },
  state: "accepted",
  acceptedAt: 1,
  dueAt: 2,
  canCancel: false,
  journalConfirmedAt: null,
  liveDataDeletedAt: null,
  closedAt: null,
};
const recovery = {
  receiptSecret: "a".repeat(64),
  idempotencyKey: "stable-key",
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
describe("account deletion transport", () => {
  it("negotiates availability before accepting and distinguishes acceptance", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(capability))
      .mockResolvedValueOnce(response(receipt, 202));
    const api = new AccountDeletionClient({
      baseUrl: "/account",
      authenticatedFetch: fetch,
    });
    expect(
      await api.request({
        ...recovery,
        ownershipCheckpointSha256: "c".repeat(64),
      })
    ).toEqual(receipt);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "/account/capabilities",
      "/account/request",
    ]);
    expect(fetch.mock.calls[1][1]?.body).toBe(
      JSON.stringify({ ...recovery, ownershipCheckpointSha256: "c".repeat(64) })
    );
    expect(receipt).not.toHaveProperty("deleted");
  });
  it.each([false, null])(
    "does not submit when unavailable or absent (%s)",
    async (available) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(
          response(available === null ? {} : { ...capability, available })
        );
      const api = new AccountDeletionClient({
        baseUrl: "/account",
        authenticatedFetch: fetch,
      });
      await expect(
        api.request({ ...recovery, ownershipCheckpointSha256: "c".repeat(64) })
      ).rejects.toBeInstanceOf(AccountDeletionError);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );
  it("receipt recovery is uncached, credential-free and independent of capability", async () => {
    const authenticatedFetch = vi.fn<typeof fetch>();
    const publicFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(receipt))
      .mockResolvedValueOnce(response(null));
    const api = new AccountDeletionClient({
      baseUrl: "/account",
      authenticatedFetch,
      publicFetch,
    });
    expect(await api.receipt(recovery)).toEqual(receipt);
    expect(await api.receipt(recovery)).toBeNull();
    expect(authenticatedFetch).not.toHaveBeenCalled();
    expect(publicFetch.mock.calls[0]).toEqual([
      "/account/receipt",
      expect.objectContaining({
        method: "POST",
        cache: "no-store",
        credentials: "omit",
        body: JSON.stringify(recovery),
        headers: { "Content-Type": "application/json" },
      }),
    ]);
  });
  it("transport and invalid-response errors contain no bearer or raw diagnostics", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error(recovery.receiptSecret))
      .mockResolvedValueOnce(
        response({ receiptSecret: recovery.receiptSecret })
      );
    const api = new AccountDeletionClient({
      baseUrl: "/account",
      authenticatedFetch: fetch,
      publicFetch: fetch,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await api.receipt(recovery);
        throw new Error("Expected refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(AccountDeletionError);
        expect(String(error)).not.toContain(recovery.receiptSecret);
      }
    }
  });
});
