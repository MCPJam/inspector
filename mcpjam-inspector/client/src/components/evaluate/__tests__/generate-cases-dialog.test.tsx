import { beforeEach, expect, it, vi } from "vitest";
import { renderWithProviders, screen, userEvent } from "@/test";
import { GenerateCasesDialog } from "../generate-cases-dialog";
import {
  loadGenerateConfig,
  totalCases,
} from "@/lib/evals/eval-generation-config";

beforeEach(() => localStorage.clear());

it("defaults to quick and read-only without generating on open or cancel", async () => {
  const onGenerate = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      onGenerate={onGenerate}
      onClose={onClose}
    />,
  );
  expect(screen.getByRole("radio", { name: /Quick set/ })).toBeChecked();
  expect(screen.getByRole("radio", { name: /Read-only/ })).toBeChecked();
  expect(screen.queryByText(/Suite default assertions/)).toBeNull();
  expect(screen.getByText("5–10 cases")).toBeVisible();
  expect(screen.getByText("20 cases")).toBeVisible();
  expect(screen.queryByText(/depends/i)).toBeNull();
  expect(onGenerate).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }));
  expect(onGenerate).not.toHaveBeenCalled();
  expect(onClose).toHaveBeenCalledOnce();
});

it("submits and remembers comprehensive read/write settings only on confirmation", async () => {
  const onGenerate = vi.fn();
  const user = userEvent.setup();
  const view = renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      onGenerate={onGenerate}
      onClose={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("radio", { name: /Comprehensive/ }));
  await user.click(screen.getByRole("radio", { name: /Read and write/ }));
  expect(onGenerate).not.toHaveBeenCalled();
  expect(loadGenerateConfig("s").testSet).toBeUndefined();
  await user.click(screen.getByRole("button", { name: "Generate cases" }));
  expect(onGenerate).toHaveBeenCalledOnce();
  const config = onGenerate.mock.calls[0][0];
  expect(config).toMatchObject({
    testSet: "comprehensive",
    toolCoverage: "read-write",
  });
  expect(totalCases(config)).toBe(20);
  view.unmount();
  renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      onGenerate={onGenerate}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole("radio", { name: /Comprehensive/ })).toBeChecked();
  expect(screen.getByRole("radio", { name: /Read and write/ })).toBeChecked();
});

it("requires a mixed suite to pick the environment it generates for", async () => {
  const onGenerate = vi.fn();
  const user = userEvent.setup();
  const choices = [
    {
      environmentId: "env-a",
      hostName: "Claude",
      modelId: "opus",
      serverNames: ["billing"],
      pluginVersionCount: 0,
    },
    {
      environmentId: "env-b",
      name: "Search box",
      hostName: "Cursor",
      serverNames: ["search"],
      pluginVersionCount: 1,
    },
  ];
  const view = renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      environmentChoices={choices}
      onGenerate={onGenerate}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByText("search + 1 plugin")).toBeVisible();
  const generate = screen.getByRole("button", { name: "Generate cases" });
  expect(generate).toBeDisabled();
  await user.click(screen.getByRole("radio", { name: /Search box/ }));
  await user.click(generate);
  expect(onGenerate).toHaveBeenCalledWith(
    expect.objectContaining({ environmentId: "env-b" }),
  );
  expect(loadGenerateConfig("s").environmentId).toBe("env-b");

  // The pick is remembered for the next batch.
  view.unmount();
  renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      environmentChoices={choices}
      onGenerate={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole("radio", { name: /Search box/ })).toBeChecked();
  expect(
    screen.getByRole("button", { name: "Generate cases" }),
  ).not.toBeDisabled();
});

it("sends no environment for a suite with nothing to pick", async () => {
  const onGenerate = vi.fn();
  renderWithProviders(
    <GenerateCasesDialog
      suiteId="s"
      onGenerate={onGenerate}
      onClose={vi.fn()}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Generate cases" }));
  expect(onGenerate.mock.calls[0][0]).not.toHaveProperty("environmentId");
});
