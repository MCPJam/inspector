import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async (c: any) => {
    if (!c.req.header("authorization")) throw new Error("missing bearer");
    return "disposable-delegated-bearer";
  },
}));
import forms from "../plugin-form-answers";

describe("owned private form upload proxy", () => {
  const app = new Hono().route("/forms", forms);
  const send = (
    body: string,
    query = "kind=legacy&id=disposable&round=0",
    headers: Record<string, string> = {},
  ) =>
    app.request(`/forms/answer-upload?${query}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer synthetic-api-key",
        ...headers,
      },
      body,
    });
  const remote = vi.fn();
  beforeEach(() => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://disposable-store.invalid/ignored");
    vi.stubGlobal("fetch", remote);
    remote.mockReset().mockResolvedValue(
      Response.json({
        ok: true,
        storageId: "owned-receipt",
        url: "https://private.invalid/secret",
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });
  it("forwards exact oversized typed JSON with delegated authority to one fixed private destination", async () => {
    const body = JSON.stringify({
      note: "disposable ".repeat(8000),
      values: ["one", "two"],
      flag: false,
      count: 0,
    });
    const response = await send(body);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      storageId: "owned-receipt",
    });
    const [url, request] = remote.mock.lastCall!;
    expect(String(url)).toBe(
      "https://disposable-store.invalid/web/plugin-forms/answer-upload?kind=legacy&id=disposable&round=0",
    );
    expect(request.headers.authorization).toBe(
      "Bearer disposable-delegated-bearer",
    );
    expect(new TextDecoder().decode(request.body)).toBe(body);
    expect(request.redirect).toBe("error");
  });
  it.each([
    "kind=other&id=x&round=0",
    "kind=legacy&id=x&round=1",
    "kind=mrtr&id=x&round=-1",
    "kind=mrtr&id=x&round=1.5",
    "kind=mrtr&id=x&round=9007199254740992",
    "kind=legacy&id=&round=0",
  ])("rejects bad scope %s before network", async (query) => {
    expect((await send("{}", query)).status).toBe(400);
    expect(remote).not.toHaveBeenCalled();
  });
  it("requires JSON and actual bytes within the cap before backend upload", async () => {
    expect(
      (await send("{}", undefined, { "content-type": "text/plain" })).status,
    ).toBe(415);
    expect((await send("é".repeat(131073))).status).toBe(413);
    expect(remote).not.toHaveBeenCalled();
  });
  it.each([401, 403, 409, 413, 429, 503])(
    "preserves bounded refusal %s without leaking backend payload",
    async (status) => {
      remote.mockResolvedValue(new Response("private diagnostic", { status }));
      const reply = await send("{}");
      expect(reply.status).toBe(status === 503 ? 502 : status);
      expect(await reply.text()).not.toContain("private diagnostic");
    },
  );
  it.each([
    null,
    {},
    { ok: true, storageId: "" },
    { ok: true, storageId: "x".repeat(513) },
  ])("rejects malformed successful receipts", async (receipt) => {
    remote.mockResolvedValue(Response.json(receipt));
    expect((await send("{}")).status).toBe(502);
  });
  it("refuses a non-JSON storage success without exposing the payload", async () => {
    remote.mockResolvedValue(new Response("private diagnostic"));
    const reply = await send("{}");
    expect(reply.status).toBe(502);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(await reply.text()).not.toContain("private diagnostic");
  });
  it("cancels a stalled browser body on peer abort before uploading", async () => {
    let cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const reply = app.fetch(
      new Request(
        "http://localhost/forms/answer-upload?kind=legacy&id=x&round=0",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer synthetic-api-key",
          },
          body,
          signal: controller.signal,
          duplex: "half",
        } as RequestInit,
      ),
    );
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    const response = await reply;
    expect(response.ok).toBe(false);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(remote).not.toHaveBeenCalled();
  });
});
