import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatAuthChallengeCards } from "../ChatAuthChallengeCards";
import {
  AUTH_CHALLENGE_EXPIRED_MESSAGE,
  CHAT_AUTH_RECOVERY_MESSAGE,
  recordChatAuthRecoveryFailure,
} from "@/lib/chat-auth-recovery";

vi.mock("@/lib/sentry", () => ({ captureSentryMessage: vi.fn() }));
vi.mock("@/lib/auth-challenge-lifecycle", () => ({
  useChatAuthChallengeCards: () => [],
  useAuthChallengeNoticeStore: (select: (value: unknown) => unknown) =>
    select({ notices: {} }),
}));
vi.mock("../AuthChallengeCard", () => ({
  AuthChallengeCard: () => null,
  authChallengeConnectMessage: () => null,
}));
beforeEach(() => sessionStorage.clear());

it("keeps one notice per failed call through remount and remembers dismissal", () => {
  recordChatAuthRecoveryFailure("resume_failed", {
    toolCallId: "tool",
    continuationId: "cont",
  });
  recordChatAuthRecoveryFailure("cancel_failed", {
    toolCallId: "tool",
    continuationId: "cont",
  });
  recordChatAuthRecoveryFailure("resume_failed", {
    toolCallId: "other-tool",
    continuationId: "other-cont",
  });
  const first = render(<ChatAuthChallengeCards toolCallIds={["tool"]} />);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByText(CHAT_AUTH_RECOVERY_MESSAGE)).toBeInTheDocument();
  first.unmount();
  const second = render(<ChatAuthChallengeCards toolCallIds={["tool"]} />);
  expect(screen.getByRole("alert")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  second.unmount();
  render(<ChatAuthChallengeCards toolCallIds={["tool"]} />);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each(["awaiting_click", "awaiting_oauth"])(
  "says the call expired when the card ran out in %s",
  (phase) => {
    recordChatAuthRecoveryFailure(
      "expired",
      { toolCallId: "tool", continuationId: "cont", phase },
      { report: false },
    );
    render(<ChatAuthChallengeCards toolCallIds={["tool"]} />);
    expect(
      screen.getByText(AUTH_CHALLENGE_EXPIRED_MESSAGE),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(CHAT_AUTH_RECOVERY_MESSAGE),
    ).not.toBeInTheDocument();
  },
);

it("keeps the retry copy when the call expired after the user signed in", () => {
  recordChatAuthRecoveryFailure("expired", {
    toolCallId: "tool",
    continuationId: "cont",
    phase: "ready",
  });
  render(<ChatAuthChallengeCards toolCallIds={["tool"]} />);
  expect(screen.getByText(CHAT_AUTH_RECOVERY_MESSAGE)).toBeInTheDocument();
});
