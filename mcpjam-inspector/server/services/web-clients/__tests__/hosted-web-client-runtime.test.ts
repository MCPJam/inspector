import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebClientService } from "../backend-connector-resolver.js";
import type { ProfileForRun } from "../hosted-web-client-environment.js";

const hoisted = vi.hoisted(() => ({
  openBrowser: vi.fn(async (_args: Record<string, unknown>) => ({
    browserSessionId: "browser-1",
    chatSessionId: "shell-chat",
    driver: {},
    exportProfile: async () => new Uint8Array(),
  })),
  environments: [] as Array<{
    openHostedBrowser(args: { profile: ProfileForRun }): Promise<unknown>;
  }>,
}));

vi.mock("../hosted-browser.js", () => ({
  openWebClientHostedBrowser: hoisted.openBrowser,
}));
vi.mock("../../../utils/inspector-public-url.js", () => ({
  configuredInspectorPublicUrl: () => "https://inspector.example.test",
}));
vi.mock("../../internal-backend.js", () => ({
  getInternalBackendConfig: () => ({
    convexUrl: "https://backend.example.test",
    serviceToken: "service-token",
  }),
}));
vi.mock("../recovery/profile-cipher.js", () => ({
  openWebProfile: (sealed: Uint8Array) => sealed,
}));
vi.mock("../hosted-web-client-environment.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../hosted-web-client-environment.js")
  >()),
  createHostedWebClientEnvironment: (
    args: (typeof hoisted.environments)[number],
  ) => {
    hoisted.environments.push(args);
    return {};
  },
}));

import { createHostedWebClientEnvironmentFactory } from "../hosted-web-client-runtime.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a hosted web client turn's browser", () => {
  it("boots in a chat of its own on the account's profile, never in the chat the turn runs in", async () => {
    const service: WebClientService = {
      read: async () => undefined,
      apply: async () => undefined,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([7, 8, 9]))),
    );
    const factory = createHostedWebClientEnvironmentFactory({ service });
    await factory?.({
      runtimeId: "claude-web",
      projectId: "project-1",
      runId: "run-1",
      chatSessionId: "playground-chat",
      bearer: "Bearer person",
      actor: { actorUserId: "user-1" },
    });
    await hoisted.environments[0]?.openHostedBrowser({
      profile: {
        webAccountId: "acct-1",
        profileVersion: 2,
        downloadUrl: "https://storage.example.test/profile",
        dataKey: Buffer.from("key").toString("base64"),
        sizeBytes: 3,
        sha256: "digest",
        savedAt: 0,
      },
    });
    expect(hoisted.openBrowser).toHaveBeenCalledOnce();
    const opened = hoisted.openBrowser.mock.calls[0]?.[0];
    expect(opened).toMatchObject({ profileArchive: new Uint8Array([7, 8, 9]) });
    expect(opened).not.toHaveProperty("chatSessionId");
  });
});
