import { afterEach, expect, it, vi } from "vitest";
import { generateKeyPair, jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { MCPClientManager } from "@mcpjam/sdk";
import { handleMCPJamFreeChatModel } from "../mcpjam-stream-handler.js";
import { TurnAuthorizationRegistry, type TurnAuthorization } from "../../services/turn-authorization.js";
import { RevokedSessionCache, setRevokedSessionCacheForTests } from "../../services/revoked-session-cache.js";

function sse(events: object[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } });
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); setRevokedSessionCacheForTests(null); });

it.each([false, true])("emulated UI stream renews before post-form model continuation; revoked=%s", async (revoked) => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://emulated.invalid");
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const keys = await generateKeyPair("RS256");
  const mint = () => new SignJWT({ sid: "same-session", org_id: "same-org" })
    .setProtectedHeader({ alg: "RS256" }).setSubject("same-actor")
    .setIssuedAt(Math.floor(now / 1000)).setExpirationTime(Math.floor(now / 1000) + 300).sign(keys.privateKey);
  const original = await mint();
  const verify = async (token: string) => {
    const { payload } = await jwtVerify(token, keys.publicKey, { currentDate: new Date(now) });
    return { sub: payload.sub!, sid: "same-session", orgId: "same-org" };
  };
  const registry = new TurnAuthorizationRegistry(verify);
  const owner = { subject: "same-actor", sessionId: "same-session", organizationId: "same-org" };
  const cache = new RevokedSessionCache({ fetchPage: async () => ({ sessions: [], cursor: null, isDone: true, watermark: now }) });
  await cache.scan(); setRevokedSessionCacheForTests(cache);
  let lease: ReturnType<typeof registry.create> | undefined;
  const started = vi.fn();
  const dispose = vi.fn(() => lease?.dispose());
  const authorization: TurnAuthorization = {
    start: (turnId, writer) => {
      started(turnId);
      lease = registry.create(owner, { projectId: "project", chatSessionId: "chat", turnId,
        requestId: "a094d256-5ee7-4a8c-b677-2f18a692f121" }, original);
      writer.write({ type: "data-turn-authorization", transient: true, data: lease.data });
    },
    getAuthorization: async () => lease!.getAuthorization(),
    getCleanupAuthorization: async () => lease!.getCleanupAuthorization(),
    dispose,
  };
  let fresh = "";
  const execute = vi.fn(async () => {
    now += 360_000;
    await cache.scan();
    await expect(verify(original)).rejects.toThrow();
    fresh = await mint();
    await registry.renew(lease!.data, owner, fresh);
    if (revoked) cache.markRevokedLocally("same-session");
    await authorization.getAuthorization();
    return { accepted: true, tolerance: 0 };
  });
  const fetchModel = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    expect(started).toHaveBeenCalledOnce();
    const expected = fetchModel.mock.calls.length === 1 ? original : fresh;
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${expected}`);
    await verify(expected);
    return fetchModel.mock.calls.length === 1
      ? sse([{ type: "tool-input-available", toolCallId: "only-call", toolName: "review", input: {} }, { type: "finish", finishReason: "tool-calls" }])
      : sse([{ type: "text-start", id: "answer" }, { type: "text-delta", id: "answer", delta: "accepted once" },
        { type: "text-end", id: "answer" }, { type: "finish", finishReason: "stop" }]);
  });
  const response = await handleMCPJamFreeChatModel({
    messages: [{ role: "user", content: "Wait for my form answer" }],
    modelId: "openai/gpt-5-nano", systemPrompt: "",
    tools: { review: { inputSchema: z.object({}), execute } },
    mcpClientManager: new MCPClientManager({}), turnAuthorization: authorization,
    authHeader: `Bearer ${original}`, heartbeatIntervalMs: 0,
    onStreamComplete: dispose,
  });
  const stream = await response.text();
  expect(started).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledOnce();
  expect(fetchModel).toHaveBeenCalledTimes(revoked ? 1 : 2);
  expect(stream).toContain('"type":"data-turn-authorization"');
  expect(stream).toContain('"transient":true');
  expect(stream).toContain(revoked ? '"type":"error"' : "accepted once");
  expect(dispose).toHaveBeenCalledOnce();
  await expect(authorization.getAuthorization()).rejects.toThrow();
});
