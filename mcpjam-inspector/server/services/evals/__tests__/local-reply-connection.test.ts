import { fileURLToPath } from "node:url";
import { MCPClientManager } from "@mcpjam/sdk";
import type { Context } from "hono";
import { expect, it, vi } from "vitest";
import { inputAnswerResolverOf, openInputAnswerConnection } from "../input-answers.js";
import { openLocalEvalRun } from "../local-run-manager.js";

vi.mock("../route-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../route-helpers.js")>()),
  createConvexClient: () => ({ query: async () => null }),
}));

it("opens a separate stdio connection for saved replies in a suite without a project", async () => {
  const app = new MCPClientManager();
  const path = fileURLToPath(new URL(
    "../../plugins/__tests__/fixtures/fake-stdio-mcp-server.mjs",
    import.meta.url,
  ));
  await app.connectToServer("local", { command: process.execPath, args: [path] });
  try {
    const run = await openLocalEvalRun(
      { mcpClientManager: app } as Context,
      { convexAuthToken: "test", suiteId: "unscoped" },
    );
    const replies = [{ tool: "echo", action: "accept" as const, content: { ok: true } }];
    const caseManager = await openInputAnswerConnection(run.manager, replies, ["local"]);
    try {
      expect(run.manager).toBe(app);
      expect(inputAnswerResolverOf(app)).toBeUndefined();
      expect(inputAnswerResolverOf(caseManager)?.answers).toEqual(replies);
      const appResult = await app.executeTool("local", "echo", { text: "app" });
      const caseResult = await caseManager.executeTool("local", "echo", { text: "case" });
      const appPid = JSON.stringify(appResult).match(/echo:app:(\d+)/)?.[1];
      const casePid = JSON.stringify(caseResult).match(/echo:case:(\d+)/)?.[1];
      expect(appPid).toBeTruthy();
      expect(casePid).toBeTruthy();
      expect(casePid).not.toBe(appPid);
    } finally {
      await caseManager.disconnectAllServers();
      await run.close();
    }
    expect(await app.executeTool("local", "echo", {})).toMatchObject({
      content: [{ type: "text", text: expect.stringMatching(/^echo:/) }],
    });
  } finally {
    await app.disconnectAllServers();
  }
});
