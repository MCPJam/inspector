import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderWithProviders, screen } from "@/test";
import { MondayReportingDashboard } from "../monday-reporting-dashboard";

describe("MondayReportingDashboard", () => {
  it("reports eval cases and opens their user value chain outputs", async () => {
    const user = userEvent.setup();
    renderWithProviders(<MondayReportingDashboard />);

    expect(
      screen.getByRole("heading", { name: "Eval test cases" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("20 cases · 2 clients · 10 iterations each")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Copilot" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "ChatGPT" })
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("monday-client-result-copilot")).toHaveLength(
      20
    );
    expect(screen.getAllByTestId("monday-client-result-chatgpt")).toHaveLength(
      20
    );
    expect(
      screen.getAllByTestId("monday-client-latency-chart-copilot")
    ).toHaveLength(20);
    expect(
      screen.getAllByTestId("monday-client-tokens-chart-chatgpt")
    ).toHaveLength(20);
    expect(
      screen.getAllByTestId("monday-client-tool-calls-chart-copilot")
    ).toHaveLength(20);
    expect(screen.getByText("Item lifecycle")).toBeInTheDocument();
    expect(screen.getByText("Multi-step flows")).toBeInTheDocument();

    expect(screen.getByTestId("monday-value-chain")).toBeInTheDocument();
    expect(
      screen.getByText(
        "change_item_column_values returned 500 on 7 of 40 calls."
      )
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Connection/i }));
    expect(
      screen.getByText(
        "No finding landed on this stage. This is not evidence that the stage passed."
      )
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Duplicate check before creating/i })
    );
    expect(
      screen.getByText(
        "No primitive exposes a duplicate check, so agents improvised search."
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "The missing duplicate-check primitive breaks the chain at discovery."
      )
    ).toBeInTheDocument();
  });
});
