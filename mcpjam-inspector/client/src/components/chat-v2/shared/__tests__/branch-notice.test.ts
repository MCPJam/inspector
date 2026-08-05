import { beforeEach, describe, expect, it, vi } from "vitest";
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
  });
});
