import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  EvalInspectBody,
  EvalInspectHeader,
  EvalInspectSheet,
  evalInspectSheetContentClass,
} from "../eval-inspect-sheet";

describe("EvalInspectSheet", () => {
  it("is the 960px Evaluate dismissable layer", () => {
    render(
      <EvalInspectSheet open onOpenChange={vi.fn()}>
        <EvalInspectHeader title="Case title" description="Hidden" descriptionSrOnly />
        <EvalInspectBody>Body</EvalInspectBody>
      </EvalInspectSheet>,
    );
    expect(screen.getByRole("dialog")).toHaveClass(
      ...evalInspectSheetContentClass.split(" "),
    );
    expect(screen.getByRole("heading", { name: "Case title" })).toHaveClass(
      "text-xl",
    );
  });

  it("uses the iteration crumb to go back", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(
      <EvalInspectSheet open onOpenChange={vi.fn()}>
        <EvalInspectHeader
          crumb={
            <>
              Case <span aria-hidden="true">›</span> Run #27
            </>
          }
          onBack={onBack}
          backAriaLabel="Back to test case iterations"
          title="#1 MCPJam"
          description="MCPJam · gemini-2.5-flash-lite"
        />
      </EvalInspectSheet>,
    );
    await user.click(
      screen.getByRole("button", { name: "Back to test case iterations" }),
    );
    expect(onBack).toHaveBeenCalled();
  });

  it("can fill the remaining sheet height for a flex child", () => {
    render(
      <EvalInspectSheet open onOpenChange={vi.fn()}>
        <EvalInspectHeader title="Case title" description="Hidden" descriptionSrOnly />
        <EvalInspectBody fill>
          <div data-testid="fill-child">Body</div>
        </EvalInspectBody>
      </EvalInspectSheet>,
    );
    expect(screen.getByTestId("fill-child").parentElement).toHaveClass(
      "flex",
      "min-h-0",
      "flex-1",
      "flex-col",
      "overflow-hidden",
    );
  });

  it("puts actions in the header, not the body", () => {
    render(
      <EvalInspectSheet open onOpenChange={vi.fn()}>
        <EvalInspectHeader
          title="Case title"
          actions={<button type="button">Open in Sessions tab →</button>}
        />
        <EvalInspectBody>Body</EvalInspectBody>
      </EvalInspectSheet>,
    );
    const header = screen.getByRole("dialog").querySelector(
      "[data-slot=sheet-header]",
    );
    expect(header).toHaveTextContent("Open in Sessions tab →");
    expect(screen.getByText("Body").closest("[data-slot=sheet-header]")).toBeNull();
  });
});
