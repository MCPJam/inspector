import { afterEach, expect, it, vi } from "vitest";
const fetcher = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session-token", () => ({ authFetch: fetcher }));
import { createThreadAppApi, type ThreadAppHandle } from "../thread-app-api";
const scope = {
  projectId: "p",
  hostId: "h",
  threadId: "t",
  pluginWorkspace: { version: 1 as const, workspaceId: "w" },
};
const handle = {
  instanceToken: "a".repeat(43),
  instanceId: "instance",
  generation: 1,
  operationId: "op",
  resourceUri: "ui://a",
  toolTitle: "App",
  appToolsEnabled: true,
  widgetContent: { html: "" },
} satisfies ThreadAppHandle;
afterEach(() => vi.clearAllMocks());
it("blocks only new invocations while the existing operation finishes normally", async () => {
  let allowed = true,
    finish!: (value: Response) => void;
  fetcher.mockImplementation(async (url: string) =>
    url.endsWith("/renew")
      ? Response.json({ status: "renewed" })
      : new Promise<Response>((resolve) => {
          finish = resolve;
        }),
  );
  const api = createThreadAppApi(scope, "", () => allowed);
  const pending = api.invoke(handle, new AbortController().signal, vi.fn(), {
    name: "review",
    arguments: {},
  });
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  allowed = false;
  await expect(
    api.invoke(handle, new AbortController().signal, vi.fn(), {
      name: "second",
      arguments: {},
    }),
  ).rejects.toThrow();
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).endsWith("/call")),
  ).toHaveLength(1);
  finish(
    Response.json({
      status: "completed",
      result: { content: [{ type: "text", text: "original result" }] },
    }),
  );
  await expect(pending).resolves.toMatchObject({
    content: [{ text: "original result" }],
  });
});
