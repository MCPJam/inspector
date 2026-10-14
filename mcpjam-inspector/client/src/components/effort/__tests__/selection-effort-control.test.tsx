import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import { pickEffort } from "@/test/effort";
import type { ModelDefinition } from "@/shared/types";
import { SelectionEffortControl } from "../selection-effort-control";

// An own-key row whose id is already canonical, with the stored legacy form a
// host outside the hosted catalog carries. Such a row is the one a no-op clear
// would otherwise mint a full `local` selection for.
const localGpt5 = {
  id: "openai/gpt-5",
  name: "GPT-5",
  provider: "openai",
  hosted: false,
} as ModelDefinition;
const legacy = { source: "legacy" as const, modelId: "openai/gpt-5" };

function renderControl() {
  const onChange = vi.fn();
  render(
    <TooltipProvider>
      <SelectionEffortControl
        variant="buttons"
        row={localGpt5}
        selection={legacy}
        purpose="chat"
        bareIds="canonicalize"
        onChange={onChange}
      />
    </TooltipProvider>,
  );
  return onChange;
}

describe("SelectionEffortControl with a stored legacy selection", () => {
  it("reads no saved effort and mints a selection from the row on a pick", async () => {
    const onChange = renderControl();
    expect(screen.getByRole("radio", { name: "Default" })).toBeChecked();
    await pickEffort("High");
    expect(onChange).toHaveBeenCalledTimes(1);
    const write = onChange.mock.calls[0][0];
    expect(write.modelId).toBe("openai/gpt-5");
    expect(write.selection).toMatchObject({
      source: "local",
      settings: { reasoningEffort: "high" },
    });
  });
});
