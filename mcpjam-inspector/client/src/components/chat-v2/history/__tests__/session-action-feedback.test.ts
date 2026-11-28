import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({ toast: toastMock }));

import {
  showSessionActionFailure,
  showSessionActionSuccess,
} from "../session-action-feedback";

type ToastAction = { label: string; onClick: () => void };

function actionOf(call: unknown[]): ToastAction {
  return (call[1] as { action: ToastAction }).action;
}

describe("session action feedback", () => {
  beforeEach(() => {
    toastMock.success.mockReset();
    toastMock.error.mockReset();
  });

  it("says where a shared session went", () => {
    showSessionActionSuccess("share", { undoArchive: vi.fn() });
    expect(toastMock.success).toHaveBeenCalledWith(
      "Shared with your team's project. It's now in Shared Sessions.",
    );
  });

  it("says where an unshared session went", () => {
    showSessionActionSuccess("unshare", { undoArchive: vi.fn() });
    expect(toastMock.success).toHaveBeenCalledWith(
      "Stopped sharing. It's back in your Sessions.",
    );
  });

  it("stays quiet for pin, which shows in the row", () => {
    showSessionActionSuccess("pin", { undoArchive: vi.fn() });
    expect(toastMock.success).not.toHaveBeenCalled();
  });

  it("offers Undo after archiving and restores the session", async () => {
    const undoArchive = vi.fn().mockResolvedValue(undefined);
    showSessionActionSuccess("archive", { undoArchive });

    expect(toastMock.success.mock.calls[0][0]).toBe("Session archived.");
    const undo = actionOf(toastMock.success.mock.calls[0]);
    expect(undo.label).toBe("Undo");

    undo.onClick();
    await vi.waitFor(() => expect(undoArchive).toHaveBeenCalledTimes(1));
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it("offers a retry when Undo fails", async () => {
    const undoArchive = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    showSessionActionSuccess("archive", { undoArchive });

    actionOf(toastMock.success.mock.calls[0]).onClick();
    await vi.waitFor(() => expect(toastMock.error).toHaveBeenCalledTimes(1));
    expect(toastMock.error.mock.calls[0][0]).toBe(
      "Couldn't restore the session. Try again.",
    );

    const retry = actionOf(toastMock.error.mock.calls[0]);
    expect(retry.label).toBe("Try again");
    retry.onClick();
    await vi.waitFor(() => expect(undoArchive).toHaveBeenCalledTimes(2));
  });

  it("shows the server's refusal when it gives one", () => {
    showSessionActionFailure(
      "share",
      new ConvexError({ message: "Only the session owner can share" }),
    );
    expect(toastMock.error).toHaveBeenCalledWith(
      "Only the session owner can share",
    );
  });

  it("falls back to copy naming the action", () => {
    showSessionActionFailure("archive", new Error("network"));
    expect(toastMock.error).toHaveBeenCalledWith(
      "Couldn't archive the session. Try again.",
    );
  });
});
