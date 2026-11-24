/** A replay opens a project's servers again; a mock goes back at the version the run used. */
import { describe, expect, it, vi } from "vitest";

const authorizedManager = vi.hoisted(() => vi.fn(async () => ({ manager: { disconnectAllServers: vi.fn() } })));

vi.mock("../../../routes/web/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../routes/web/auth.js")>()),
  createAuthorizedManager: authorizedManager,
}));
vi.mock("../route-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../route-helpers.js")>()),
  createConvexClient: () => ({
    query: async () => [{ _id: "mock-1", name: "Echo mock", url: "https://mock.mcpjam.invalid/mock-1" }],
  }),
  connectReplayManagerServers: vi.fn(async () => {}),
}));
vi.mock("../suite-account-choices.js", () => ({ loadSuiteConnectionIdSets: async () => undefined }));
vi.mock("../../xaa-mint.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../xaa-mint.js")>()),
  resolveXaaIssuer: () => "https://issuer.test",
}));

import { localReplayServers } from "../local-run-manager.js";

const context = { get: () => undefined, set: () => undefined, var: {} } as never;
const target = (mockPins: Array<{ serverId: string; version: number; contentHash: string }>) => ({
  projectId: "proj1",
  suiteId: "suite1",
  replayConfig: { runId: "r1", suiteId: "suite1", servers: [] },
  environment: { servers: ["mock-1"] },
  mockPins,
});

describe("localReplayServers", () => {
  it("authorizes a mock again at the version the run used", async () => {
    const opened = await localReplayServers(context, "token")(
      target([{ serverId: "mock-1", version: 4, contentHash: "h".repeat(64) }]),
    );
    expect(opened?.serverIds).toEqual(["mock-1"]);
    const options = (authorizedManager.mock.calls.at(-1) as unknown as unknown[])[7];
    expect(options).toMatchObject({ mockVersions: { "mock-1": 4 } });
  });

  it("opens the head of a mock that the run did not pin", async () => {
    await localReplayServers(context, "token")(target([]));
    const options = (authorizedManager.mock.calls.at(-1) as unknown as unknown[])[7] as Record<string, unknown>;
    expect(options.mockVersions).toBeUndefined();
  });
});
