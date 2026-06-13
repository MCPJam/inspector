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

async function expand(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: /negative-test scorecard/i }),
  );
}

describe("NegativeTestScorecard", () => {
  beforeEach(() => {
    runMock.mockReset();
  });

  it("shows the unavailable reason when there is no auth-server target", async () => {
    const user = userEvent.setup();
    render(
      <NegativeTestScorecard
        input={null}
        unlocked={false}
        unavailableReason="MCPJam test auth server has nothing to test."
      />,
    );
    await expand(user);

    expect(
      screen.getByText("MCPJam test auth server has nothing to test."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /run negative tests/i }),
    ).toBeNull();
  });

  it("locks the run button until a positive run unlocks it", async () => {
    const user = userEvent.setup();
    render(<NegativeTestScorecard input={INPUT} unlocked={false} />);
    await expand(user);

    expect(
      screen.getByRole("button", { name: /run negative tests/i }),
    ).toBeDisabled();
    expect(
      screen.getByText(/run a successful flow first/i),
    ).toBeInTheDocument();
  });

  it("runs immediately when unlocked and renders per-case verdicts", async () => {
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
        },
      ],
    });

    const user = userEvent.setup();
    render(<NegativeTestScorecard input={INPUT} unlocked />);
    await expand(user);

    await user.click(
      screen.getByRole("button", { name: /run negative tests/i }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("xaa-negtest-row-expired")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("xaa-negtest-row-expired")).toHaveAttribute(
      "data-verdict",
      "fail",
    );
    expect(
      screen.getByTestId("xaa-negtest-row-wrong_audience"),
    ).toHaveAttribute("data-verdict", "pass");
    expect(runMock).toHaveBeenCalledWith(INPUT);
  });

  it("unlocks via the typed override for the half-built-AS case", async () => {
    runMock.mockResolvedValue({ failures: 0, results: [] });

    const user = userEvent.setup();
    render(<NegativeTestScorecard input={INPUT} unlocked={false} />);
    await expand(user);

    // The run button stays disabled until the exact phrase is typed.
    expect(screen.getByRole("button", { name: /^unlock$/i })).toBeDisabled();

    await user.type(
      screen.getByLabelText("Override confirmation"),
      "run anyway",
    );
    await user.click(screen.getByRole("button", { name: /^unlock$/i }));

    const runButton = screen.getByRole("button", {
      name: /run negative tests/i,
    });
    expect(runButton).toBeEnabled();
    await user.click(runButton);
    await waitFor(() => expect(runMock).toHaveBeenCalledTimes(1));
  });

  it("surfaces a run error", async () => {
    runMock.mockRejectedValue(new Error("URL not allowed"));

    const user = userEvent.setup();
    render(<NegativeTestScorecard input={INPUT} unlocked />);
    await expand(user);
    await user.click(
      screen.getByRole("button", { name: /run negative tests/i }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("xaa-negtest-error")).toHaveTextContent(
        "URL not allowed",
      ),
    );
  });
});
