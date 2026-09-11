import { describe, expect, it } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { RunClientsCell } from "../run-clients-cell";
import type { SuiteRunHistoryRow } from "../../evaluate/suite-detail-model";

const row = (
  client: string,
  models: string[],
): SuiteRunHistoryRow =>
  ({
    client,
    models,
  }) as SuiteRunHistoryRow;

describe("RunClientsCell", () => {
  it("lists pairings inline without an expand control", () => {
    renderWithProviders(
      <RunClientsCell
        rows={[row("Claude", ["gpt-5-nano"]), row("Cursor", ["haiku"])]}
      />,
    );
    expect(screen.getByLabelText("Claude · gpt-5-nano, Cursor · haiku")).toBeVisible();
    expect(screen.getByText(/Claude/)).toBeVisible();
    expect(screen.getByText(/gpt-5-nano/)).toBeVisible();
    expect(screen.getByText(/Cursor/)).toBeVisible();
    expect(screen.getByText(/haiku/)).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/client : model pairings/i)).toBeNull();
    expect(screen.queryByText("+1")).toBeNull();
  });

  it("overflows extra pairings behind a hover +N listing", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RunClientsCell
        rows={[
          row("Claude", ["gpt-5-nano"]),
          row("Cursor", ["haiku"]),
          row("ChatGPT", ["gpt-5.1"]),
        ]}
      />,
    );
    expect(screen.getByText(/Claude/)).toBeVisible();
    expect(screen.getByText(/Cursor/)).toBeVisible();
    expect(screen.queryByText(/ChatGPT/)).toBeNull();
    const more = screen.getByLabelText("1 more client and model pairings");
    expect(more).toHaveTextContent("+1");
    await user.hover(more);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("ChatGPT · gpt-5.1");
    expect(tooltip).toHaveTextContent("Claude · gpt-5-nano");
    expect(tooltip).toHaveTextContent("Cursor · haiku");
  });
});
