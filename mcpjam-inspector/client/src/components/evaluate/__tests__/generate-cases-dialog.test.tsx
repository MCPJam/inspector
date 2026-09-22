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
