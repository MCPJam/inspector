import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

// vi.mock is hoisted above imports — declare mock fns via vi.hoisted so
// they're available when the factory runs.
const { toastSuccessMock, toastErrorMock, posthogCaptureMock } = vi.hoisted(
  () => ({
    toastSuccessMock: vi.fn(),
    toastErrorMock: vi.fn(),
    posthogCaptureMock: vi.fn(),
  }),
);

vi.mock("sonner", () => ({
  toast: { success: toastSuccessMock, error: toastErrorMock },
}));

vi.mock("posthog-js/react", () => ({
  usePostHog: () => ({ capture: posthogCaptureMock }),
}));

import {
  clearPendingTopup,
  stashPendingTopup,
} from "../useCreditTopup";
import { useCreditTopupReturnFlow } from "../useCreditTopupReturnFlow";

const STASH_KEY = "mcpjam.topup.pending";

let replaceStateSpy: ReturnType<typeof vi.spyOn>;
let originalLocation: Location;

function setLocationSearch(search: string) {
  // jsdom doesn't let us reassign window.location, but we can stub the
  // properties the hook reads. The hook reads .search, .pathname, .hash.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      ...originalLocation,
      search,
      pathname: "/",
      hash: "",
    },
  });
}

describe("useCreditTopupReturnFlow", () => {
  beforeEach(() => {
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    posthogCaptureMock.mockReset();
    window.sessionStorage.clear();
    originalLocation = window.location;
    // Spy on replaceState so the hook's URL cleanup doesn't hit jsdom's
    // SecurityError for cross-document URL changes.
    replaceStateSpy = vi
      .spyOn(window.history, "replaceState")
      .mockImplementation(() => {});
    setLocationSearch("");
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
    replaceStateSpy.mockRestore();
    window.sessionStorage.clear();
  });

  it("is a no-op when no topup query param is present", () => {
    setLocationSearch("");
    const sendMessage = vi.fn();
    renderHook(() =>
      useCreditTopupReturnFlow({
        chatSessionId: "chat-1",
        sendMessage,
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it("strips topup + session_id params and leaves stash alone on cancelled", () => {
    setLocationSearch("?topup=cancelled&session_id=cs_test_xyz&keep=1");
    stashPendingTopup({ chatSessionId: "chat-1", message: "hello" });

    const sendMessage = vi.fn();
    renderHook(() =>
      useCreditTopupReturnFlow({
        chatSessionId: "chat-1",
        sendMessage,
      }),
    );

    expect(sendMessage).not.toHaveBeenCalled();
    // URL was cleaned: replaceState called with only `keep=1` preserved.
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    expect(replaceStateSpy.mock.calls[0]?.[2]).toBe("/?keep=1");
    // Stash preserved for retry.
    expect(window.sessionStorage.getItem(STASH_KEY)).not.toBeNull();
    // Telemetry: cancelled with stash present.
    expect(posthogCaptureMock).toHaveBeenCalledWith(
      "credit_topup_return_cancelled",
      { had_pending_stash: true },
    );
  });

  it("resends and clears stash on success when chat session matches", () => {
    setLocationSearch("?topup=success&session_id=cs_test_xyz");
    stashPendingTopup({ chatSessionId: "chat-1", message: "hello again" });

    const sendMessage = vi.fn();
    renderHook(() =>
      useCreditTopupReturnFlow({
        chatSessionId: "chat-1",
        sendMessage,
      }),
    );

    expect(sendMessage).toHaveBeenCalledWith({ text: "hello again" });
    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull();
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    expect(replaceStateSpy.mock.calls[0]?.[2]).toBe("/");
    // Telemetry: success, stash present, session matched, resend executed.
    expect(posthogCaptureMock).toHaveBeenCalledWith(
      "credit_topup_return_success",
      {
        had_pending_stash: true,
        chat_session_matched: true,
        resend_executed: true,
      },
    );
  });

  it("clears stash on success when chat session does not match (does not resend)", () => {
    setLocationSearch("?topup=success");
    stashPendingTopup({
      chatSessionId: "chat-other",
      message: "from another tab",
    });

    const sendMessage = vi.fn();
    renderHook(() =>
      useCreditTopupReturnFlow({
        chatSessionId: "chat-1",
        sendMessage,
      }),
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(STASH_KEY)).toBeNull();
    // Telemetry: success, stash present, session NOT matched, no resend.
    expect(posthogCaptureMock).toHaveBeenCalledWith(
      "credit_topup_return_success",
      {
        had_pending_stash: true,
        chat_session_matched: false,
        resend_executed: false,
      },
    );
  });

  it("preserves stash and surfaces an error toast when sendMessage throws", () => {
    setLocationSearch("?topup=success");
    stashPendingTopup({ chatSessionId: "chat-1", message: "retry me" });

    const sendMessage = vi.fn().mockImplementation(() => {
      throw new Error("send failed");
    });

    renderHook(() =>
      useCreditTopupReturnFlow({
        chatSessionId: "chat-1",
        sendMessage,
      }),
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).not.toHaveBeenCalled();
    // Stash preserved so the user can retry.
    expect(window.sessionStorage.getItem(STASH_KEY)).not.toBeNull();
    // Telemetry: success, stash present, matched, but resend FAILED.
    expect(posthogCaptureMock).toHaveBeenCalledWith(
      "credit_topup_return_success",
      {
        had_pending_stash: true,
        chat_session_matched: true,
        resend_executed: false,
      },
    );
  });

  it("does nothing extra when topup=success arrives without a stash", () => {
    setLocationSearch("?topup=success");
    clearPendingTopup();

    const sendMessage = vi.fn();
    renderHook(() =>
      useCreditTopupReturnFlow({
        chatSessionId: "chat-1",
        sendMessage,
      }),
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(replaceStateSpy).toHaveBeenCalledTimes(1);
    // Telemetry: success but no stash present.
    expect(posthogCaptureMock).toHaveBeenCalledWith(
      "credit_topup_return_success",
      {
        had_pending_stash: false,
        chat_session_matched: false,
        resend_executed: false,
      },
    );
  });
});
