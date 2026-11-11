import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import { createConnectedServer } from "@/test/factories";
import { ConformanceSetup } from "../ConformanceSetup";

vi.mock("@/lib/apis/mcp-tools-api", () => ({
  listTools: vi.fn(async () => ({ tools: [] })),
}));

describe("conformance setup timeout", () => {
  it("leaves the run timeout to Settings", () => {
    const server = createConnectedServer({ name: "alpha" });
    render(
      <TooltipProvider>
        <ConformanceSetup
          servers={[server]}
          initialServerName="alpha"
          initialVersionPin="auto"
          onCancel={vi.fn()}
          onRun={vi.fn()}
        />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(
      screen.getByRole("heading", { name: "Set what you'd like to test" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run timeout" })).toBeNull();
    expect(screen.queryByLabelText("Total run timeout (seconds)")).toBeNull();
  });
});
