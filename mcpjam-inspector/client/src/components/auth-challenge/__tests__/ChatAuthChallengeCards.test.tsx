import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChatAuthChallengeCards } from "../ChatAuthChallengeCards";
import {
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
