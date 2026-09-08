/**
 * The empty trigger's copy, which is variant-keyed.
 *
 * The chip variant reads "No server group · pick one" — a status line that
 * makes sense on its own. The field variant sits under a "Server" `Label`
 * inside a form, where that phrasing reads as a value rather than a prompt,
 * so it says "Select a server group" instead. The promote dialog is the only
 * `variant="field"` caller, and both of its existing tests pass a `value`, so
 * this branch had no coverage: reverting the default to the chip copy left
 * every suite green while the dialog's Server column read "No server group ·
 * pick one".
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useMutation: () => vi.fn(),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({ servers: [], isLoading: false }),
  useProjectServerAttachments: () => ({
    serverAttachments: [],
    isLoading: false,
  }),
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}));

import { ServerGroupPicker } from "../ServerGroupPicker";

function renderPicker(props: {
  variant?: "field";
  emptyTriggerLabel?: string;
}) {
  render(
    <ServerGroupPicker
      projectId="p-1"
      value={null}
      onChange={vi.fn()}
      triggerTestId="picker"
      {...props}
    />,
  );
  return screen.getByTestId("picker");
}

describe("ServerGroupPicker — empty trigger label", () => {
  it("prompts rather than reporting a status in the field variant", () => {
    expect(renderPicker({ variant: "field" }).textContent).toMatch(
      /select a server group/i,
    );
  });

  it("keeps the chip variant's status copy", () => {
    expect(renderPicker({}).textContent).toMatch(/no server group/i);
  });

  it("still lets a caller override either default", () => {
    // `environment-composer` passes a possibly-`undefined` label through, so
    // an explicit label has to win and `undefined` has to fall through to the
    // variant default above.
    expect(
      renderPicker({ variant: "field", emptyTriggerLabel: "Pick servers" })
        .textContent,
    ).toMatch(/pick servers/i);
  });
});
