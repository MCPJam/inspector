import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SendFeedbackDialog } from "../SendFeedbackDialog";

const { sendMock, toastMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/hooks/useSendPlatformFeedback", () => ({
  useSendPlatformFeedback: () => sendMock,
}));
vi.mock("@/lib/toast", () => ({ toast: toastMock }));

const RECEIPT = { id: "fb_1", receivedAt: 1, duplicate: false };

function typeSummary(text: string) {
  fireEvent.change(screen.getByTestId("send-feedback-summary"), {
    target: { value: text },
  });
}

function submit() {
  fireEvent.click(screen.getByTestId("send-feedback-submit"));
}

describe("SendFeedbackDialog", () => {
  beforeEach(() => {
    sendMock.mockReset();
    toastMock.success.mockReset();
    sendMock.mockResolvedValue(RECEIPT);
  });

  it("says where the text goes, and guides the details", () => {
    render(<SendFeedbackDialog open onOpenChange={() => {}} />);
    expect(
      screen.getByText(
        "Sent to the MCPJam team and kept for 180 days. Don't include secrets.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("send-feedback-details")).toHaveAttribute(
      "placeholder",
      "What were you trying to do? What did you expect? What got in the way?",
    );
  });

  it("will not send without a summary", () => {
    render(<SendFeedbackDialog open onOpenChange={() => {}} />);
    expect(screen.getByTestId("send-feedback-submit")).toBeDisabled();
    typeSummary("   ");
    expect(screen.getByTestId("send-feedback-submit")).toBeDisabled();
  });

  it("sends the report, thanks the user and closes", async () => {
    const onOpenChange = vi.fn();
    render(<SendFeedbackDialog open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByLabelText("Something is missing"));
    typeSummary("  cannot export a suite  ");
    fireEvent.change(screen.getByTestId("send-feedback-details"), {
      target: { value: "Wanted YAML." },
    });
    submit();

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(sendMock).toHaveBeenCalledWith({
      kind: "missing_capability",
      summary: "cannot export a suite",
      details: "Wanted YAML.",
      idempotencyKey: expect.any(String),
    });
    expect(toastMock.success).toHaveBeenCalledWith(
      "Sent to the MCPJam team, thanks",
    );
  });

  it("says a duplicate was already received", async () => {
    sendMock.mockResolvedValue({ ...RECEIPT, duplicate: true });
    render(<SendFeedbackDialog open onOpenChange={() => {}} />);
    typeSummary("crash");
    submit();
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        "Already received, thanks",
      ),
    );
  });

  it("carries a prefilled request id and error code, and shows the id", async () => {
    render(
      <SendFeedbackDialog
        open
        onOpenChange={() => {}}
        defaults={{
          kind: "bug",
          requestId: "req_0123456789abcdef",
          errorCode: "INTERNAL_ERROR",
        }}
      />,
    );
    expect(screen.getByTestId("send-feedback-request-id")).toHaveTextContent(
      "req_0123456789abcdef",
    );
    typeSummary("the run page crashed");
    submit();
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1));
    expect(sendMock.mock.calls[0]![0]).toMatchObject({
      kind: "bug",
      requestId: "req_0123456789abcdef",
      errorCode: "INTERNAL_ERROR",
    });
  });

  it("shows the refusal and keeps the dialog open", async () => {
    sendMock.mockRejectedValue(
      Object.assign(new Error("Server Error"), {
        data: {
          code: "rate_limited",
          message: "You've sent a lot of feedback recently.",
        },
      }),
    );
    const onOpenChange = vi.fn();
    render(<SendFeedbackDialog open onOpenChange={onOpenChange} />);
    typeSummary("crash");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You've sent a lot of feedback recently.",
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("mints one idempotency key per opening", async () => {
    sendMock.mockRejectedValueOnce(new Error("network down"));
    const { rerender } = render(
      <SendFeedbackDialog open onOpenChange={() => {}} />,
    );
    typeSummary("crash");
    submit();
    await screen.findByRole("alert");
    // A retry within the same opening reuses the key, so a report that did
    // land the first time is not filed twice.
    submit();
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(2));
    const firstKey = sendMock.mock.calls[0]![0].idempotencyKey;
    expect(sendMock.mock.calls[1]![0].idempotencyKey).toBe(firstKey);

    // Opening the dialog again is a new report, with a new key.
    rerender(<SendFeedbackDialog open={false} onOpenChange={() => {}} />);
    rerender(<SendFeedbackDialog open onOpenChange={() => {}} />);
    typeSummary("crash");
    submit();
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(3));
    expect(sendMock.mock.calls[2]![0].idempotencyKey).not.toBe(firstKey);
  });
});
