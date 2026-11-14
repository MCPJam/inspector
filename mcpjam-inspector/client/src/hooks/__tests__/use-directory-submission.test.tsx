/**
 * Saving answers against a revision, and what a refused save does.
 *
 * A person on the page and an agent on the API edit the same submission.
 * When the backend refuses a save because a field it touched changed, the
 * page shows the saved value and holds the person's own until they choose;
 * a refusal that names none of their fields is reapplied without asking.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAUDE_CONNECTOR_FLOW } from "@mcpjam/sdk/browser";
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
  /** How the hook starts a run, as the run poller would call it. */
  start: undefined as ((key: string) => Promise<unknown>) | undefined,
}));
vi.mock("@/hooks/use-directory-readiness-run", () => ({
  useDirectoryReadinessRun: (options: { start: typeof runner.start }) => {
    runner.start = options.start;
    return runner;
  },
}));

function viewAt(revision: number, name: string): SubmissionView {
  return {
    id: "sub_1",
    projectId: "proj_1",
    serverId: "srv_1",
    directory: "claude",
    flowId: "claude-connector",
    flowVersion: CLAUDE_CONNECTOR_FLOW.version,
    answers: [{ key: "listing.name", value: name, origin: "set", revision }],
    revision,
    createdBy: "user_1",
    createdAt: 1,
    updatedAt: revision,
    fieldIssues: [],
    steps: [],
    resultsRunId: null,
    submissionUrl: CLAUDE_CONNECTOR_FLOW.submissionUrl,
  };
}

function conflict(
  currentRevision: number,
  keys: string[],
  current?: SubmissionView,
) {
  return new PlatformApiError(
    "This submission changed since you read it.",
    "CONFLICT",
    {
      status: 409,
      details: { currentRevision, conflictingKeys: keys, current },
    },
  );
}

const SCOPE = { projectId: "proj_1", submissionId: "sub_1" };

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function openSubmission() {
  const hook = renderHook(() =>
    useDirectorySubmission({
      projectId: "proj_1",
      submissionId: "sub_1",
      server: { name: "Sample server" },
    }),
  );
  await settle();
  return hook;
}

describe("useDirectorySubmission", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of Object.values(api)) mock.mockReset();
    api.getDirectoryFlow.mockResolvedValue(CLAUDE_CONNECTOR_FLOW);
    api.getDirectorySubmission.mockResolvedValue(viewAt(3, "Sample"));
    // Closing the hook saves whatever is still waiting.
    api.updateDirectorySubmission.mockResolvedValue(viewAt(4, "Saved"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves an edit with the revision it was made on", async () => {
    api.updateDirectorySubmission.mockResolvedValue(viewAt(4, "Edited"));
    const { result } = await openSubmission();
    expect(result.current.values["listing.name"]).toBe("Sample");

    act(() => result.current.setAnswer("listing.name", "Edited"));
    expect(result.current.values["listing.name"]).toBe("Edited");
    await settle(800);

    expect(api.updateDirectorySubmission).toHaveBeenCalledWith(SCOPE, {
      expectedRevision: 3,
      answers: { "listing.name": "Edited" },
    });
    expect(result.current.view?.revision).toBe(4);
    expect(result.current.savedAt).not.toBeNull();
  });

  it("validates the answers as the person types", async () => {
    const { result } = await openSubmission();
    act(() => result.current.setAnswer("listing.oneLiner", "x".repeat(201)));
    expect(result.current.issues).toContainEqual(
      expect.objectContaining({ key: "listing.oneLiner", code: "tooLong" }),
    );
  });

  it("on a conflict over an edited field, shows the saved value and offers to reapply", async () => {
    api.updateDirectorySubmission
      .mockRejectedValueOnce(conflict(5, ["listing.name"], viewAt(5, "Theirs")))
      .mockResolvedValueOnce(viewAt(6, "Theirs"))
      .mockResolvedValueOnce(viewAt(7, "Mine"));
    const { result } = await openSubmission();

    act(() => {
      result.current.setAnswer("listing.name", "Mine");
      result.current.setAnswer("listing.slug", "mine");
    });
    await settle(800);

    // Their value is on screen; this tab's is held, not sent.
    expect(result.current.values["listing.name"]).toBe("Theirs");
    expect(result.current.conflict).toEqual({ "listing.name": "Mine" });

    // The edit nobody else touched goes again on the current revision.
    await settle(800);
    expect(api.updateDirectorySubmission).toHaveBeenLastCalledWith(SCOPE, {
      expectedRevision: 5,
      answers: { "listing.slug": "mine" },
    });

    act(() => result.current.reapply());
    expect(result.current.conflict).toBeNull();
    await settle(800);
    expect(api.updateDirectorySubmission).toHaveBeenLastCalledWith(SCOPE, {
      expectedRevision: 6,
      answers: { "listing.name": "Mine" },
    });
    expect(result.current.values["listing.name"]).toBe("Mine");
  });

  it("keeps the saved value when the person chooses it", async () => {
    api.updateDirectorySubmission.mockRejectedValueOnce(
      conflict(5, ["listing.name"], viewAt(5, "Theirs")),
    );
    const { result } = await openSubmission();
    act(() => result.current.setAnswer("listing.name", "Mine"));
    await settle(800);

    act(() => result.current.keepSaved());
    await settle(800);
    expect(result.current.conflict).toBeNull();
    expect(result.current.values["listing.name"]).toBe("Theirs");
    expect(api.updateDirectorySubmission).toHaveBeenCalledTimes(1);
  });

  it("reapplies by itself when the refusal names none of the edited fields", async () => {
    api.updateDirectorySubmission
      .mockRejectedValueOnce(conflict(8, [], viewAt(8, "Sample")))
      .mockResolvedValueOnce(viewAt(9, "Mine"));
    const { result } = await openSubmission();
    act(() => result.current.setAnswer("listing.name", "Mine"));
    await settle(800);
    await settle(800);

    expect(result.current.conflict).toBeNull();
    expect(api.updateDirectorySubmission).toHaveBeenLastCalledWith(SCOPE, {
      expectedRevision: 8,
      answers: { "listing.name": "Mine" },
    });
    expect(result.current.values["listing.name"]).toBe("Mine");
  });

  it("a refresh never moves the revision of edits still waiting", async () => {
    api.updateDirectorySubmission.mockResolvedValue(viewAt(11, "Mine"));
    const { result } = await openSubmission();
    act(() => result.current.setAnswer("listing.name", "Mine"));
    // Someone else saved meanwhile, and a refresh brought it in.
    api.getDirectorySubmission.mockResolvedValue(viewAt(10, "Theirs"));
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await settle(800);

    expect(result.current.view?.revision).toBe(11);
    expect(api.updateDirectorySubmission).toHaveBeenCalledWith(SCOPE, {
      expectedRevision: 3,
      answers: { "listing.name": "Mine" },
    });
  });

  it("does not retry a save refused for another reason until the person acts", async () => {
    api.updateDirectorySubmission.mockRejectedValueOnce(
      new PlatformApiError("The slug is not valid.", "VALIDATION_ERROR", {
        status: 400,
      }),
    );
    const { result } = await openSubmission();
    act(() => result.current.setAnswer("listing.slug", "Not A Slug"));
    await settle(800);
    expect(result.current.error).toBe("The slug is not valid.");

    await settle(10_000);
    expect(api.updateDirectorySubmission).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.saveNow();
    });
    expect(api.updateDirectorySubmission).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
  });

  it("saves what is waiting before it starts a run", async () => {
    api.updateDirectorySubmission.mockResolvedValue(viewAt(4, "Edited"));
    const { result } = await openSubmission();
    act(() => result.current.setAnswer("listing.name", "Edited"));
    await act(async () => {
      await result.current.startRun();
    });
    expect(api.updateDirectorySubmission).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(
      api.updateDirectorySubmission.mock.invocationCallOrder[0],
    ).toBeLessThan(runner.run.mock.invocationCallOrder[0]);
  });

  it("starts a run with the test plan revision it was started with, and no other", async () => {
    const start = () => runner.start?.("key_1");
    runner.run.mockImplementationOnce(start).mockImplementationOnce(start);
    const { result } = await openSubmission();
    await act(async () => {
      await result.current.startRun(3);
    });
    await act(async () => {
      await result.current.startRun();
    });
    expect(api.startDirectorySubmissionRun.mock.calls).toEqual([
      [SCOPE, "key_1", undefined, 3],
      [SCOPE, "key_1", undefined, undefined],
    ]);
  });
});
