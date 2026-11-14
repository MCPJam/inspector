/**
 * A ChatGPT plugin submission's plugin: chosen at once, guarded by the
 * revision on screen like an answer, and the version a run grades. A
 * package field nobody imported is not reported missing.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHATGPT_PLUGIN_FLOW } from "@mcpjam/sdk/browser";
import { PlatformApiError } from "@mcpjam/sdk/platform";
import type { SubmissionView } from "@/lib/apis/directory-submissions-api";
import { useDirectorySubmission } from "../use-directory-submission";

const api = vi.hoisted(() => ({
  getDirectoryFlow: vi.fn(),
  getDirectorySubmission: vi.fn(),
  updateDirectorySubmission: vi.fn(),
  startDirectorySubmissionRun: vi.fn(),
}));
vi.mock("@/lib/apis/directory-submissions-api", () => api);

const runner = vi.hoisted(() => ({
  state: { status: "idle" },
  run: vi.fn(),
  watch: vi.fn(),
  start: undefined as ((key: string) => Promise<unknown>) | undefined,
}));
vi.mock("@/hooks/use-directory-readiness-run", () => ({
  useDirectoryReadinessRun: (options: {
    start?: (key: string) => Promise<unknown>;
  }) => {
    runner.start = options.start;
    return runner;
  },
}));

const SCOPE = { projectId: "proj_1", submissionId: "sub_1" };

function viewAt(
  revision: number,
  plugin: { pluginId?: string; pluginVersionId?: string } = {},
): SubmissionView {
  return {
    id: "sub_1",
    projectId: "proj_1",
    serverId: "srv_1",
    directory: "openai",
    flowId: CHATGPT_PLUGIN_FLOW.id,
    flowVersion: CHATGPT_PLUGIN_FLOW.version,
    answers: [
      {
        key: "listing.developer",
        value: "Sample Co",
        origin: "imported",
        revision: 1,
      },
    ],
    revision,
    createdBy: "user_1",
    ...plugin,
    createdAt: 1,
    updatedAt: revision,
    fieldIssues: [],
    steps: [],
    resultsRunId: null,
    submissionUrl: CHATGPT_PLUGIN_FLOW.submissionUrl,
  };
}

async function openSubmission() {
  const hook = renderHook(() =>
    useDirectorySubmission({
      projectId: "proj_1",
      submissionId: "sub_1",
      server: { name: "Sample server" },
    }),
  );
  await act(async () => {});
  return hook;
}

describe("useDirectorySubmission with a ChatGPT plugin", () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
    api.getDirectoryFlow.mockResolvedValue(CHATGPT_PLUGIN_FLOW);
    api.getDirectorySubmission.mockResolvedValue(viewAt(3));
  });

  it("saves the plugin at once with the revision on screen", async () => {
    const chosen = { pluginId: "plg_1", pluginVersionId: "ver_2" };
    api.updateDirectorySubmission.mockResolvedValue(viewAt(4, chosen));
    const { result } = await openSubmission();
    await act(() => result.current.setPlugin(chosen));
    expect(api.updateDirectorySubmission).toHaveBeenCalledWith(SCOPE, {
      expectedRevision: 3,
      plugin: chosen,
    });
    expect(result.current.view?.pluginVersionId).toBe("ver_2");
    expect(result.current.pluginError).toBeNull();
  });

  it("shows the plugin someone else saved in between, and says so", async () => {
    const theirs = viewAt(5, { pluginId: "plg_2", pluginVersionId: "ver_9" });
    api.updateDirectorySubmission.mockRejectedValue(
      new PlatformApiError("This submission changed.", "CONFLICT", {
        status: 409,
        details: { currentRevision: 5, conflictingKeys: ["plugin"], current: theirs },
      }),
    );
    const { result } = await openSubmission();
    await act(() =>
      result.current.setPlugin({ pluginId: "plg_1", pluginVersionId: "ver_2" }),
    );
    expect(result.current.view?.pluginVersionId).toBe("ver_9");
    expect(result.current.pluginError).toBe(
      "The plugin changed in another session, so yours was not saved. The page shows the saved one; choose yours again to replace it.",
    );
    expect(result.current.pluginSaving).toBe(false);
  });

  it("says why any other refusal kept the plugin", async () => {
    api.updateDirectorySubmission.mockRejectedValue(
      new PlatformApiError("Plugin version not found", "NOT_FOUND", { status: 404 }),
    );
    const { result } = await openSubmission();
    await act(() => result.current.setPlugin({ pluginVersionId: "ver_0" }));
    expect(result.current.pluginError).toBe(
      "The plugin was not saved. Plugin version not found Choose it again.",
    );
  });

  it("starts a run on the version saved when it starts", async () => {
    api.getDirectorySubmission.mockResolvedValue(
      viewAt(3, { pluginId: "plg_1", pluginVersionId: "ver_2" }),
    );
    await openSubmission();
    await runner.start?.("key_1");
    // A run started with no test plan revision names none.
    expect(api.startDirectorySubmissionRun).toHaveBeenCalledWith(
      SCOPE,
      "key_1",
      "ver_2",
      undefined,
    );
  });

  it("reports package fields only once an import stored them", async () => {
    const { result } = await openSubmission();
    const keys = result.current.issues.map((issue) => issue.key);
    expect(keys).not.toContain("listing.displayName");
    expect(keys).toContain("reviewer.loginUrl");
  });
});
