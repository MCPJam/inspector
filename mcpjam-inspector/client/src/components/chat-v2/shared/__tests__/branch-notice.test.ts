import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { showBranchCreatedNotice } from "../branch-notice";

const mocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  getCachedChatHistoryDetail: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

vi.mock("@/components/chat-v2/history/chat-history-prefetch", () => ({
  getCachedChatHistoryDetail: mocks.getCachedChatHistoryDetail,
}));

describe("showBranchCreatedNotice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The notice logs the underlying cause on failure; keep it out of the test
    // output while still asserting it happened.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers an action that fetches the original's detail and reopens it", async () => {
    const detail = { ok: true, session: { chatSessionId: "old" } };
    mocks.getCachedChatHistoryDetail.mockResolvedValue(detail);
    const reopen = vi.fn().mockResolvedValue(undefined);

    showBranchCreatedNotice({
      previousChatSessionId: "old",
      projectId: "project-1",
      reopen,
    });

    expect(mocks.success).toHaveBeenCalledTimes(1);
    const options = mocks.success.mock.calls[0][1];
    await options.action.onClick();

    expect(mocks.getCachedChatHistoryDetail).toHaveBeenCalledWith({
      chatSessionId: "old",
      projectId: "project-1",
    });
    expect(reopen).toHaveBeenCalledWith(detail);
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("outlives Sonner's ~4s default, since it is the only path back to the original", async () => {
    // No lineage field exists in the schema, so once this toast is gone the
    // relationship between the branch and the original is invisible. An
    // explicit duration is required — the default would take the only way back
    // off screen after four seconds.
    mocks.getCachedChatHistoryDetail.mockResolvedValue({ ok: true });

    showBranchCreatedNotice({
      previousChatSessionId: "old",
      reopen: vi.fn(),
    });

    const options = mocks.success.mock.calls[0][1];
    expect(options.duration).toBeGreaterThan(10000);
  });

  it("surfaces an error instead of failing silently when the detail fetch fails", async () => {
    mocks.getCachedChatHistoryDetail.mockRejectedValue(new Error("offline"));
    const reopen = vi.fn();

    showBranchCreatedNotice({
      previousChatSessionId: "old",
      reopen,
    });

    const options = mocks.success.mock.calls[0][1];
    await options.action.onClick();

    expect(reopen).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledTimes(1);
    // Logged so this is distinguishable from a reopen failure in a console.
    expect(console.error).toHaveBeenCalledWith(
      "Failed to reopen the original thread",
      expect.objectContaining({ message: "offline" })
    );
  });

  it("treats an { ok: false } detail as a failure instead of handing it to reopen", async () => {
    // The API reports failure in-band, not by rejecting. Passing this straight
    // through sent a payload with no usable `session` into
    // `loadHistorySession`, which surfaced as its generic catch-all message
    // rather than this notice's own.
    mocks.getCachedChatHistoryDetail.mockResolvedValue({ ok: false });
    const reopen = vi.fn();

    showBranchCreatedNotice({
      previousChatSessionId: "old",
      reopen,
    });

    const options = mocks.success.mock.calls[0][1];
    await options.action.onClick();

    expect(reopen).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("reports a failure in the caller's restore path too", async () => {
    // The other half of the catch: the fetch succeeded, `reopen` threw. Same
    // message (the user's options are identical), distinguishable in a console.
    mocks.getCachedChatHistoryDetail.mockResolvedValue({ ok: true });
    const reopen = vi.fn().mockRejectedValue(new Error("restore blew up"));

    showBranchCreatedNotice({
      previousChatSessionId: "old",
      reopen,
    });

    const options = mocks.success.mock.calls[0][1];
    await options.action.onClick();

    expect(reopen).toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to reopen the original thread",
      expect.objectContaining({ message: "restore blew up" })
    );
  });
});
