import { describe, expect, it, vi } from "vitest";
import { PlatformApiClient } from "../../src/platform/client.js";
const capabilities = (available: boolean) => ({ available, protocolVersion: 1, scopeTypes: ["project", "organization"] });
function setup(available: boolean, failure?: string) {
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (failure === "capability" || (failure === "acceptance" && init?.method === "POST")) throw new Error("Lost response");
    const body = path.endsWith("capabilities") ? capabilities(available) : init?.method === "DELETE" ? { id: "p1", deleted: true } : { requestId: "r1" };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  const client = new PlatformApiClient({ baseUrl: "https://example.test/api/v1", getAuth: () => "token", fetch });
  return { client, fetch };
}
describe("deletion negotiation", () => {
  it("uses legacy deletion only after explicit unavailable capability", async () => {
    const { client, fetch } = setup(false);
    expect(await client.deleteProject({ projectId: "p1" })).toEqual({ id: "p1", deleted: true });
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "DELETE"]);
  });
  it("uses request protocol with stable key when available", async () => {
    const { client, fetch } = setup(true);
    expect(await client.deleteProject({ projectId: "p1" }, { idempotencyKey: "key" })).toEqual({ requestId: "r1" });
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "POST"]);
  });
  it.each(["capability", "acceptance"])("never falls back after %s failure", async (failure) => {
    const { client, fetch } = setup(true, failure);
    await expect(client.deleteProject({ projectId: "p1" }, { idempotencyKey: "key" })).rejects.toThrow();
    expect(fetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });
  it("explicit request refuses unavailable protocol without deleting", async () => {
    const { client, fetch } = setup(false);
    await expect(client.requestDeletion({ scope: { type: "organization", id: "o1" } }, { idempotencyKey: "key" })).rejects.toMatchObject({ code: "FEATURE_NOT_SUPPORTED" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });  it("replays an existing receipt without capability lookup or new intake", async () => {
    const { client, fetch } = setup(false);
    expect(await client.replayDeletion({ scope: { type: "project", id: "p1" } }, { idempotencyKey: "saved-key" })).toEqual({ requestId: "r1" });
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://example.test/api/v1/deletions/replay");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("saved-key");
  });
  it("rejects replay without an existing key before sending a request", async () => {
    const { client, fetch } = setup(false);
    await expect(client.replayDeletion({ scope: { type: "project", id: "p1" } }, { idempotencyKey: "" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetch).not.toHaveBeenCalled();
  });

});
