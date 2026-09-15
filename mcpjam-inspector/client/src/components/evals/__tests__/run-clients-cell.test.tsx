import { describe, expect, it } from "vitest";
import { within } from "@testing-library/react";
import { renderWithProviders, screen, userEvent } from "@/test";
import { RunClientsCell } from "../run-clients-cell";
import type { SuiteRunHistoryRow } from "../../evaluate/suite-detail-model";

const row = (client: string, models: string[]): SuiteRunHistoryRow =>
  ({
    client,
    models,
  }) as SuiteRunHistoryRow;

describe("RunClientsCell", () => {
  it("shows only clients in the client column", () => {
    renderWithProviders(
      <RunClientsCell
        column="client"
        rows={[row("Claude", ["haiku"]), row("Cursor", ["gpt-5"])]}
      />,
    );
    expect(screen.getByText("Claude")).toBeVisible();
    expect(screen.getByText("Cursor")).toBeVisible();
    expect(screen.queryByText("haiku")).toBeNull();
    expect(screen.queryByText("gpt-5")).toBeNull();
  });

  it("shows only models in matching order in the model column", () => {
    renderWithProviders(
      <RunClientsCell
        column="model"
        rows={[row("Claude", ["haiku"]), row("Cursor", ["gpt-5"])]}
      />,
    );
    expect(
      within(screen.getByTestId("expanded-run-models")).getByText("haiku"),
    ).toBeVisible();
    expect(screen.getByText("gpt-5")).toBeVisible();
    expect(screen.queryByText("Claude")).toBeNull();
    expect(screen.queryByText("Cursor")).toBeNull();
  });

  it("shows one model and counts distinct extra models in the compact layout", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <RunClientsCell
        column="model"
        rows={[
          row("Claude", ["haiku", "sonnet"]),
          row("Cursor", ["haiku", "gpt-5"]),
        ]}
      />,
    );
    const compact = within(screen.getByTestId("compact-run-models"));
    expect(compact.getByText("haiku")).toBeVisible();
    expect(compact.queryByText("sonnet")).toBeNull();
    const more = compact.getByLabelText("2 more models");
    expect(more).toHaveTextContent("+2");
    await user.hover(more);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("sonnet");
    expect(tooltip).toHaveTextContent("gpt-5");
  });

  it("lists pairings inline without an expand control", () => {
    renderWithProviders(
      <RunClientsCell
        rows={[row("Claude", ["gpt-5-nano"]), row("Cursor", ["haiku"])]}
      />,
    );
    expect(
      screen.getByLabelText("Claude · gpt-5-nano, Cursor · haiku"),
    ).toBeVisible();
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

it("counts unique clients rather than client-model pairs", () => {
  renderWithProviders(
    <RunClientsCell
      column="client"
      rows={[
        row("Claude", ["haiku"]),
        row("Claude", ["sonnet"]),
        row("Cursor", ["gpt-5"]),
        row("Other", ["model"]),
      ]}
    />,
  );
  expect(screen.getAllByText("Claude")).toHaveLength(1);
  expect(screen.getByText("Cursor")).toBeVisible();
  expect(screen.getByLabelText("1 more clients")).toBeVisible();
});
