import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import elicitation, { initElicitationCallback } from "../elicitation.js";

type Callback = (request: Record<string, unknown>) => Promise<unknown>;

function fakeManager() {
  let callback: Callback | undefined;
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  return {
    setElicitationCallback: (cb: Callback) => {
      callback = cb;
    },
    getPendingElicitations: () => pending,
    respondToElicitation: (requestId: string, response: unknown) => {
      const entry = pending.get(requestId);
      if (!entry) return false;
      pending.delete(requestId);
      entry.resolve(response);
      return true;
    },
    ask: (requestId: string) =>
      callback!({ requestId, serverId: "weather", message: `Q ${requestId}` }),
  };
}

function appFor(manager: ReturnType<typeof fakeManager>) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as unknown as { mcpClientManager: unknown }).mcpClientManager = manager;
    await next();
  });
  app.route("/", elicitation);
  return app;
}

/** The data events a fresh subscriber is sent before any live traffic. */
async function firstEvents(
  app: Hono,
): Promise<Array<{ type: string; requestId?: string; requestIds?: string[] }>> {
  const abort = new AbortController();
  const response = await app.request("/stream", { signal: abort.signal });
  const reader = response.body!.getReader();
  let text = "";
  const deadline = Date.now() + 200;
  while (Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20)),
    ]);
    if (!chunk || chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  abort.abort();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

describe("elicitation stream replay", () => {
  it("sends a new subscriber the questions still waiting, and not answered ones", async () => {
    const manager = fakeManager();
    initElicitationCallback(manager as never);
    const app = appFor(manager);

    const answered = manager.ask("req-answered");
    void manager.ask("req-open");

    const respond = await app.request("/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "req-answered", action: "decline" }),
    });
    expect(respond.status).toBe(200);
    await expect(answered).resolves.toEqual({ action: "decline" });

    const events = await firstEvents(app);
    // The open set comes first, so a reconnecting listener can drop the rest.
    expect(events[0]).toEqual({
      type: "elicitation_open",
      requestIds: ["req-open"],
    });
    const replayed = events.slice(1);
    expect(replayed.map((e) => e.requestId)).toEqual(["req-open"]);
    expect(replayed[0]).toMatchObject({
      type: "elicitation_request",
      serverId: "weather",
      message: "Q req-open",
    });

    manager.respondToElicitation("req-open", { action: "cancel" });
  });
});
