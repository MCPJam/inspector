import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NegativeTestScorecard } from "../NegativeTestScorecard";
import type { NegativeTestsInput } from "@/lib/xaa/discovery-client";

const runMock = vi.fn();
vi.mock("@/lib/xaa/discovery-client", () => ({
  runNegativeTests: (input: unknown) => runMock(input),
}));

const INPUT: NegativeTestsInput = {
  audience: "https://auth.example.com",
  resource: "https://mcp.example.com",
  registrationId: "app_1",
};

describe("NegativeTestScorecard", () => {
  beforeEach(() => {
    runMock.mockReset();
  });

  it("starts expanded and shows the unavailable reason when there is no auth-server target", () => {
    render(
      <NegativeTestScorecard
        input={null}
        unlocked={false}
        unavailableReason="MCPJam test auth server has nothing to test."
      />
    );

    expect(
      screen.getByText("MCPJam test auth server has nothing to test.")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /run negative tests/i })
    ).toBeNull();
  });

  it("locks the run button until a positive run unlocks it", () => {
    render(<NegativeTestScorecard input={INPUT} unlocked={false} />);

    expect(
      screen.getByRole("button", { name: /run negative tests/i })
    ).toBeDisabled();
    expect(
      screen.getByText(/run a successful flow first/i)
    ).toBeInTheDocument();
  });

  it("runs immediately when unlocked and renders per-case verdicts", async () => {
    const onResultsReady = vi.fn();
    const onExpandedChange = vi.fn();
    runMock.mockResolvedValue({
      failures: 1,
      results: [
        {
          mode: "expired",
          label: "Expired",
          expectedFailure: "AS should reject expired",
          outcome: "accepted",
          verdict: "fail",
          status: 200,
          detail: "Issued a token for an expired assertion.",
        },
        {
          mode: "wrong_audience",
          label: "Wrong Audience",
          expectedFailure: "AS should reject the audience",
          outcome: "rejected",
          verdict: "pass",
          status: 400,
          diff: {
            field: "aud",
            sent: "https://wrong-audience.example.com",
            expected: "https://auth.example.com",
          },
        },
        {
          mode: "unknown_sub",
          label: "Unknown Subject",
          expectedFailure: "Observe the subject-resolution policy",
          outcome: "accepted",
          verdict: "policy",
          status: 200,
        },
      ],
    });

    const user = userEvent.setup();
    render(
      <NegativeTestScorecard
        input={INPUT}
        unlocked
        onResultsReady={onResultsReady}
        onExpandedChange={onExpandedChange}
      />
    );

    await user.click(
      screen.getByRole("button", { name: /run negative tests/i })
    );

    await waitFor(() =>
      expect(screen.getByTestId("xaa-negtest-row-expired")).toBeInTheDocument()
    );
    expect(screen.getByTestId("xaa-negtest-row-expired")).toHaveAttribute(
      "data-verdict",
      "fail"
    );
    expect(
      screen.getByTestId("xaa-negtest-row-wrong_audience")
    ).toHaveAttribute("data-verdict", "pass");
    expect(screen.getByTestId("xaa-negtest-row-unknown_sub")).toHaveAttribute(
      "data-verdict",
      "policy"
    );
    // Outcome-based copy: a pass reads as a result, not an instruction.
    expect(screen.getByText(/rejected as expected/i)).toBeInTheDocument();
    expect(screen.getByText(/accepted — security risk/i)).toBeInTheDocument();
    expect(
      screen.getByText(/accepted — policy-dependent/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/1 of 2 strict rejection checks passed/i)
    ).toBeInTheDocument();
    expect(
      screen.getByText(/1 policy probe reported separately/i)
    ).toBeInTheDocument();
    // Expected-vs-actual diff for the tampered claim.
    expect(
      screen.getByText(/https:\/\/wrong-audience\.example\.com/)
    ).toBeInTheDocument();
    expect(runMock).toHaveBeenCalledWith(INPUT);
    expect(onResultsReady).toHaveBeenCalledTimes(1);

    const scorecardToggle = screen.getByRole("button", {
      name: /negative-test scorecard/i,
    });
    await user.click(scorecardToggle);
    expect(onExpandedChange).toHaveBeenLastCalledWith(false, true);
    expect(screen.queryByTestId("xaa-negtest-row-expired")).toBeNull();

    await user.click(scorecardToggle);
    expect(onExpandedChange).toHaveBeenLastCalledWith(true, true);
    expect(screen.getByTestId("xaa-negtest-row-expired")).toBeInTheDocument();
  });

  it("unlocks via the owner checkbox for the half-built-AS case", async () => {
    runMock.mockResolvedValue({ failures: 0, results: [] });

    const user = userEvent.setup();
    render(<NegativeTestScorecard input={INPUT} unlocked={false} />);

    // The run button stays disabled until the owner toggle is checked.
    expect(
      screen.getByRole("button", { name: /run negative tests/i })
    ).toBeDisabled();

    await user.click(screen.getByRole("checkbox"));

    const runButton = screen.getByRole("button", {
      name: /run negative tests/i,
    });
    expect(runButton).toBeEnabled();
    await user.click(runButton);
    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));
  });

  it("clears stale results when the target changes (e.g. config cleared)", async () => {
    runMock.mockResolvedValue({
      failures: 1,
      results: [
        {
          mode: "expired",
          label: "Expired",
          expectedFailure: "AS should reject expired",
          outcome: "accepted",
          verdict: "fail",
          status: 200,
          detail: "Issued a token for an expired assertion.",
        },
      ],
    });

    const user = userEvent.setup();
    const { rerender } = render(
      <NegativeTestScorecard input={INPUT} unlocked />
    );
    await user.click(
      screen.getByRole("button", { name: /run negative tests/i })
    );

    await waitFor(() =>
      expect(screen.getByTestId("xaa-negtest-row-expired")).toBeInTheDocument()
    );

    rerender(
      <NegativeTestScorecard
        input={null}
        unlocked={false}
        unavailableReason="Run the flow first so the token endpoint is discovered."
      />
    );

    await waitFor(() =>
      expect(screen.queryByTestId("xaa-negtest-row-expired")).toBeNull()
    );
  });

  it("clears completed rows when the policy mode or person changes for the same endpoint", async () => {
    runMock.mockResolvedValue({
      failures: 0,
      results: [
        {
          mode: "expired",
          label: "Expired",
          expectedFailure: "AS should reject expired",
          outcome: "rejected",
          verdict: "pass",
          status: 400,
        },
      ],
    });

    const managedInput: NegativeTestsInput = {
      ...INPUT,
      policyMode: "managed",
      testIdentityId: "xperson_alice",
      resourceAppId: "app_1",
    };
    const onTargetChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <NegativeTestScorecard
        input={managedInput}
        unlocked
        onTargetChange={onTargetChange}
      />
    );
    await user.click(
      screen.getByRole("button", { name: /run negative tests/i })
    );
    await waitFor(() =>
      expect(screen.getByTestId("xaa-negtest-row-expired")).toBeInTheDocument()
    );
    onTargetChange.mockClear();

    // A different person is a different evaluator subject — prior rows say
    // nothing about them.
    rerender(
      <NegativeTestScorecard
        input={{ ...managedInput, testIdentityId: "xperson_sam" }}
        unlocked
        onTargetChange={onTargetChange}
      />
    );
    await waitFor(() =>
      expect(screen.queryByTestId("xaa-negtest-row-expired")).toBeNull()
    );
    expect(onTargetChange).toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: /run negative tests/i })
    );
    await waitFor(() =>
      expect(screen.getByTestId("xaa-negtest-row-expired")).toBeInTheDocument()
    );
    onTargetChange.mockClear();

    // Managed → unmanaged: a different evaluator ruled on the prior rows, so
    // they must not survive the policy-mode switch.
    rerender(
      <NegativeTestScorecard
        input={{ ...INPUT, policyMode: "unmanaged", resourceAppId: "app_1" }}
        unlocked
        onTargetChange={onTargetChange}
      />
    );
    await waitFor(() =>
      expect(screen.queryByTestId("xaa-negtest-row-expired")).toBeNull()
    );
    expect(onTargetChange).toHaveBeenCalled();
  });

  it("surfaces a run error", async () => {
    runMock.mockRejectedValue(new Error("URL not allowed"));

    const user = userEvent.setup();
    render(<NegativeTestScorecard input={INPUT} unlocked />);
    await user.click(
      screen.getByRole("button", { name: /run negative tests/i })
    );

    await waitFor(() =>
      expect(screen.getByTestId("xaa-negtest-error")).toHaveTextContent(
        "URL not allowed"
      )
    );
  });
});
