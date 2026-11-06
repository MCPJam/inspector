import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import { createConnectedServer } from "@/test/factories";
import { ConformanceSetup } from "../ConformanceSetup";

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: vi.fn(async () => ({ tools: [] })),
}));

describe("conformance setup timeout", () => {
  it("keeps the saved timeout when returning through breadcrumbs", async () => {
    const server = createConnectedServer({ name: "alpha" });
    const onSaveTimeout = vi.fn(
      async (_name: string, _seconds: number | null) => {},
    );
    render(
      <TooltipProvider>
        <ConformanceSetup
          servers={[server]}
          initialServerName="alpha"
          initialVersionPin="auto"
          timeoutFor={() => 300}
          onSaveTimeout={onSaveTimeout}
          onCancel={vi.fn()}
          onRun={vi.fn()}
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByText("300s")).toBeInTheDocument();
    const crumbs = screen.getByRole("navigation", { name: "breadcrumb" });
    fireEvent.click(
      within(crumbs).getByRole("button", {
        name: "Choose server and protocol",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Run timeout" }));
    expect(screen.getByLabelText("Total run timeout (seconds)")).toHaveValue(
      300,
    );
    fireEvent.change(screen.getByLabelText("Total run timeout (seconds)"), {
      target: { value: "90" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(onSaveTimeout).toHaveBeenCalledWith("alpha", 90),
    );
  });
});
