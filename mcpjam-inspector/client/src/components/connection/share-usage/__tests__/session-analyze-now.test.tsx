import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SessionAnalyzeNowButton,
  analyzeNowErrorMessage,
} from "../session-analyze-now";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";

const { mockRequest, mockToast, member } = vi.hoisted(() => ({
  mockRequest: vi.fn(),
  mockToast: { success: vi.fn(), error: vi.fn() },
  member: { value: true as boolean | undefined },
}));

vi.mock("convex/react", () => ({
  useMutation: () => mockRequest,
}));
vi.mock("sonner", () => ({ toast: mockToast }));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => member.value,
}));

type Thread = Pick<SharedChatThread, "_id" | "sourceType" | "analysisPhase">;
const thread = (over: Partial<Thread> = {}): Thread => ({
  _id: "session-1",
  sourceType: "scenario",
  analysisPhase: "owed",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  member.value = true;
  mockRequest.mockResolvedValue({ queued: true });
});

describe("SessionAnalyzeNowButton", () => {
  it.each(["owed", "provisional", "failed"] as const)(
    "offers Analyze now for a %s session and asks for that session",
    async (phase) => {
      const user = userEvent.setup();
      render(
        <SessionAnalyzeNowButton thread={thread({ analysisPhase: phase })} />,
      );
      await user.click(screen.getByRole("button", { name: /Analyze now/ }));
      expect(mockRequest).toHaveBeenCalledWith({ sessionId: "session-1" });
      await waitFor(() =>
        expect(mockToast.success).toHaveBeenCalledWith(
          "Analyzing this session",
        ),
      );
    },
  );

  it("reads Analyzing… and stays inert while a pass runs", () => {
    render(
      <SessionAnalyzeNowButton
        thread={thread({ analysisPhase: "analyzing" })}
      />,
    );
    expect(screen.getByRole("button", { name: /Analyzing…/ })).toBeDisabled();
  });

  it.each(["final", "guest", "deferred", "none", undefined] as const)(
    "renders nothing for a %s session",
    (phase) => {
      render(
        <SessionAnalyzeNowButton thread={thread({ analysisPhase: phase })} />,
      );
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    },
  );

  it("renders nothing outside User Testing", () => {
    render(
      <SessionAnalyzeNowButton thread={thread({ sourceType: "swarm" })} />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("hides the button from a guest, and while membership is unknown", () => {
    member.value = false;
    const { rerender } = render(<SessionAnalyzeNowButton thread={thread()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    member.value = undefined;
    rerender(<SessionAnalyzeNowButton thread={thread()} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the refusal the backend wrote, not a stack", async () => {
    const user = userEvent.setup();
    mockRequest.mockRejectedValue(
      new ConvexError({
        code: "rate_limited",
        message: "Too many insight requests. Try again in a minute.",
      }),
    );
    render(<SessionAnalyzeNowButton thread={thread()} />);
    await user.click(screen.getByRole("button", { name: /Analyze now/ }));
    await waitFor(() =>
      expect(mockToast.error).toHaveBeenCalledWith(
        "Too many insight requests. Try again in a minute.",
      ),
    );
    // Usable again once the request settles.
    expect(screen.getByRole("button", { name: /Analyze now/ })).toBeEnabled();
  });

  it("does not report a request for a session the reader has left", async () => {
    const user = userEvent.setup();
    let resolve: (value: unknown) => void = () => undefined;
    mockRequest.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { rerender } = render(<SessionAnalyzeNowButton thread={thread()} />);
    await user.click(screen.getByRole("button", { name: /Analyze now/ }));
    rerender(
      <SessionAnalyzeNowButton
        thread={thread({ _id: "session-2", analysisPhase: "provisional" })}
      />,
    );
    resolve({ queued: true });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Analyze now/ })).toBeEnabled(),
    );
    expect(mockToast.success).not.toHaveBeenCalled();
  });
});

describe("analyzeNowErrorMessage", () => {
  it("prefers the backend's copy, and says something useful otherwise", () => {
    expect(
      analyzeNowErrorMessage(new ConvexError({ message: "Sign in first." })),
    ).toBe("Sign in first.");
    expect(analyzeNowErrorMessage(new ConvexError("Plain refusal"))).toBe(
      "Plain refusal",
    );
    expect(analyzeNowErrorMessage(new Error("Server Error"))).toBe(
      "Could not start the analysis. Try again in a minute.",
    );
  });
});
