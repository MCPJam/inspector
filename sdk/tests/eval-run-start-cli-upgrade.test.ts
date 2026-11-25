import { afterEach, expect, it, vi } from "vitest";
vi.hoisted(() => vi.resetModules());
vi.unmock("../src/eval-run-start.js");
import { startEvalRun } from "../src/eval-run-start.js";

afterEach(() => vi.unstubAllGlobals());

it("names the CLI upgrade required by the server without retrying or blaming credentials", async () => {
  const fetcher = vi.fn(async () =>
    Response.json(
      {
        code: "VALIDATION_ERROR",
        message: "untrusted server text",
        details: { reason: "CLI_UPGRADE_REQUIRED", minimumCliVersion: "6.4.1" },
      },
      { status: 400 }
    )
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(
    startEvalRun({
      apiKey: "sk_test",
      mcpjam: { baseUrl: "http://localhost:3000" },
      plannedIterations: 1,
      surface: "cli",
      clientVersion: "6.0.1",
    })
  ).rejects.toMatchObject({
    code: "CLI_UPGRADE_REQUIRED",
    message: expect.stringContaining("npm install -g @mcpjam/cli@latest"),
  });
  expect(fetcher).toHaveBeenCalledOnce();
});
