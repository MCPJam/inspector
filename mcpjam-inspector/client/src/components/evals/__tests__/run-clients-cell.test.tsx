import { describe, expect, it, vi } from "vitest";
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
  it("keeps client clicks and keys connected to the run row", async () => {
    const onClick = vi.fn();
    const onKeyDown = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <div role="button" tabIndex={0} onClick={onClick} onKeyDown={onKeyDown}>
        <RunClientsCell
          column="client"
          rows={[{ ...row("Client", []), clientVersionNumber: 2 }]}
        />
      </div>,
    );
    const trigger = screen.getByText("Client").parentElement!;
    await user.click(trigger);
    expect(onClick).toHaveBeenCalledTimes(1);
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(onKeyDown).toHaveBeenCalled();
  });
  it("does not add tab stops for unversioned visible names", () => {
    const { container } = renderWithProviders(
      <RunClientsCell column="client" rows={[row("Client", [])]} />,
    );
    expect(container.querySelector('[tabindex="0"]')).toBeNull();
  });
  it("keeps distinct ids as overflow keys even with matching names", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const user = userEvent.setup();
      renderWithProviders(
        <RunClientsCell
          column="model"
          rows={[
            row("Client", [
              "one",
              "two",
              "claude-haiku-4-5-20251001",
              "anthropic/claude-haiku-4.5",
            ]),
          ]}
        />,
      );
      await user.hover(screen.getByLabelText("2 more models"));
      await screen.findByRole("tooltip");
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
  it.each(["client", "model"] as const)(
    "shows a dash for the SDK placeholder %s",
    (column) => {
      renderWithProviders(
        <RunClientsCell column={column} rows={[row("SDK harness", ["n/a"])]} />,
      );
      expect(screen.getByText("-")).toBeVisible();
      expect(screen.queryByText("SDK harness")).toBeNull();
      expect(screen.queryByText("a")).toBeNull();
      expect(document.querySelector("img")).toBeNull();
    },
  );

  it("keeps real models for SDK runs", () => {
    renderWithProviders(
      <RunClientsCell
        column="model"
        rows={[row("SDK harness", ["n/a", "openai/gpt-5"])]}
      />,
    );
    expect(
      within(screen.getByTestId("expanded-run-models")).getByText("GPT-5"),
    ).toBeVisible();
    expect(screen.queryByText("a")).toBeNull();
  });

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
    expect(screen.getByText("GPT-5")).toBeVisible();
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
    expect(tooltip).toHaveTextContent("GPT-5");
  });

  it("lists pairings inline without an expand control", () => {
    renderWithProviders(
      <RunClientsCell
        rows={[row("Claude", ["gpt-5-nano"]), row("Cursor", ["haiku"])]}
      />,
    );
    expect(
      screen.getByLabelText("Claude · GPT-5 Nano, Cursor · haiku"),
    ).toBeVisible();
    expect(screen.getByText(/Claude/)).toBeVisible();
    expect(screen.getByText(/GPT-5 Nano/)).toBeVisible();
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
    expect(tooltip).toHaveTextContent("ChatGPT · GPT-5.1");
    expect(tooltip).toHaveTextContent("Claude · GPT-5 Nano");
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

it("shows client versions only on hover and keyboard focus, preserving distinct versions", async () => {
  const user = userEvent.setup();
  renderWithProviders(
    <RunClientsCell
      column="client"
      rows={[
        {
          ...row("My client", []),
          clientId: "client1",
          clientVersionId: "v1",
          clientVersionNumber: 1,
        },
        {
          ...row("My client", []),
          clientId: "client1",
          clientVersionId: "v2",
          clientVersionNumber: 2,
        },
      ]}
    />,
  );
  expect(screen.getAllByText("My client")).toHaveLength(2);
  expect(screen.queryByText(/v1/)).toBeNull();
  await user.hover(screen.getAllByText("My client")[0]);
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "My client · v1",
  );
  await user.unhover(screen.getAllByText("My client")[0]);
  await user.tab();
  await user.tab();
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "My client · v2",
  );
});

it("shows the friendly model name in both layouts", () => {
  renderWithProviders(
    <RunClientsCell
      column="model"
      rows={[row("My client", ["claude-haiku-4-5-20251001"])]}
    />,
  );
  expect(
    within(screen.getByTestId("expanded-run-models")).getByText(
      "Claude Haiku 4.5",
    ),
  ).toBeVisible();
  expect(
    within(screen.getByTestId("compact-run-models")).getByText(
      "Claude Haiku 4.5",
    ),
  ).toBeVisible();
  expect(screen.queryByText("claude-haiku-4-5-20251001")).toBeNull();
});

it("includes versions in the combined pairing overflow tooltip", async () => {
  const user = userEvent.setup();
  renderWithProviders(
    <RunClientsCell
      rows={[1, 2, 3].map((version) => ({
        ...row("My client", ["gpt-5"]),
        clientId: "client1",
        clientVersionId: `v${version}`,
        clientVersionNumber: version,
      }))}
    />,
  );
  await user.hover(screen.getByLabelText("1 more client and model pairings"));
  expect(await screen.findByRole("tooltip")).toHaveTextContent(
    "My client · v3 · GPT-5",
  );
});
