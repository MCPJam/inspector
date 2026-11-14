import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/session-token", () => ({ authFetch: f.fetch }));
import { createThreadAppApi, type ThreadAppHandle } from "../thread-app-api";
const scope = {
  projectId: "project",
  hostId: "host",
  threadId: "thread",
  pluginWorkspace: { version: 1 as const, workspaceId: "workspace" },
};
const handle = {
  instanceToken: "a".repeat(43),
  instanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  generation: 1,
  operationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  resourceUri: "ui://app",
  toolTitle: "App",
  appToolsEnabled: true,
  widgetContent: { html: "<p>App</p>" },
} satisfies ThreadAppHandle;
const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
let release: ((value: Response) => void) | undefined;
function respond(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status });
}
beforeEach(() => {
  vi.useFakeTimers();
  requests.length = 0;
  release = undefined;
  f.fetch.mockReset();
  f.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ url, body });
    if (url === "/api/mcp/turn-authorization")
      return respond({ renewed: true, tokenExpiresAt: Date.now() + 300_000 });
    if (url.endsWith("/renew")) {
      if (body.cancelAuthorization)
        return respond({ status: "renewed", expiresAt: Date.now() + 1800_000 });
      const operation = body.operation;
      return respond({
        status: "renewed",
        expiresAt: Date.now() + 1800_000,
        operationAuthorization: {
          type: "data-turn-authorization",
          data: {
            handle: crypto.randomUUID(),
            projectId: "project",
            requestId: operation.requestId,
            tokenExpiresAt: Date.now() + 300_000,
            expiresAt: Date.now() + 7200_000,
            pluginOperation: {
              workspaceId: "workspace",
              instanceId: handle.instanceId,
              generation: 1,
              hostId: "host",
              serverId: "server",
              invocationId: operation.invocationId,
              bindingHash: "f".repeat(64),
            },
          },
        },
      });
    }
    return new Promise<Response>((resolve, reject) => {
      release = resolve;
      init.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  });
});
afterEach(() => vi.useRealTimers());
it.each(["", "model/"])(
  "preflights %s App authority and renews one original call without changing false or zero",
  async (prefix) => {
    const pending = createThreadAppApi(scope, prefix).invoke(
      handle,
      new AbortController().signal,
      vi.fn(),
      { name: "review", arguments: { agree: false, count: 0 } },
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await vi.advanceTimersByTimeAsync(90_000);
    const calls = requests.filter((r) => r.url.endsWith("/call"));
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      params: { name: "review", arguments: { agree: false, count: 0 } },
      authorization: {
        projectId: "project",
        pluginOperation: {
          instanceId: handle.instanceId,
          generation: 1,
          hostId: "host",
          serverId: "server",
        },
      },
    });
    expect(
      requests.filter((r) => r.url === "/api/mcp/turn-authorization").length,
    ).toBeGreaterThan(1);
    release!(
      respond({
        status: "completed",
        result: { content: [], structuredContent: { agree: false, count: 0 } },
      }),
    );
    expect(await pending).toMatchObject({
      structuredContent: { agree: false, count: 0 },
    });
    const count = requests.length;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(requests).toHaveLength(count);
    expect(requests.at(-1)?.body).toHaveProperty("cancelAuthorization");
  },
);
it("stops renewal on owner abort without replaying the dispatched call", async () => {
  const owner = new AbortController();
  const pending = createThreadAppApi(scope).invoke(
    handle,
    owner.signal,
    vi.fn(),
    { name: "review", arguments: {} },
  );
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  owner.abort();
  await rejected;
  const count = requests.length;
  await vi.advanceTimersByTimeAsync(120_000);
  expect(requests).toHaveLength(count);
  expect(requests.filter((r) => r.url.endsWith("/call"))).toHaveLength(1);
});
