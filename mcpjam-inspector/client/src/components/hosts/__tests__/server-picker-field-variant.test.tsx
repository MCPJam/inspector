/**
 * The trigger's SHAPE, ported from BB-163.
 *
 * The promote-to-test-case modal puts Client and Server side by side in a
 * labelled form column. A pill next to a `<Select>` reads as a different kind
 * of control, so BB-163 gave the old picker a `field` variant: full width,
 * `h-9`, square, the same box an `<Input>` draws. That caller survives
 * BB-142's merge, so the variant has to survive with it.
 *
 * What did NOT come across is the variant-keyed empty LABEL. The old picker
 * needed one because its chip copy — "No server group · pick one" — reads as a
 * broken placeholder under a `Label`. BB-142 deleted that copy; "Select server"
 * is a prompt in both places, and a second vocabulary is the thing this ticket
 * removed. The last test pins that, so the old copy cannot come back.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useMutation: () => vi.fn(),
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({
    servers: [],
    isLoading: false,
    isBootstrapping: false,
  }),
  useProjectServerAttachments: () => ({
    serverAttachments: [],
    isLoading: false,
    isBootstrapping: false,
  }),
}));

vi.mock("@/state/app-state-context", () => ({
  useOptionalSharedAppState: () => null,
}));

vi.mock("@/state/server-actions-context", () => ({
  useServerActionsOptional: () => null,
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() },
}));

vi.mock("@/lib/app-navigation", () => ({
  navigateApp: vi.fn(),
  routePaths: { servers: "/servers" },
}));

import { ServerPicker } from "../server-picker";

function trigger(props: Record<string, unknown> = {}) {
  render(
    <ServerPicker
      projectId="p_1"
      value={null}
      onChange={vi.fn()}
      triggerTestId="picker"
      {...props}
    />,
  );
  return screen.getByTestId("picker");
}

describe("ServerPicker — the field variant", () => {
  it("draws a full-width form control, not a chip", () => {
    // The box an `<Input>` draws beside it: `h-9`, full width, square.
    const el = trigger({ variant: "field" });
    expect(el.className).toContain("h-9");
    expect(el.className).toContain("w-full");
    expect(el.className).not.toContain("rounded-full");
  });

  it("keeps the pill by default, so every existing caller is untouched", () => {
    const el = trigger();
    expect(el.className).toContain("rounded-full");
    expect(el.className).not.toContain("w-full");
  });

  it("takes an id, so a sibling Label names the control", () => {
    // Without it the accessible name is only the selected group — "Stripe",
    // never "Server", which is what the column is actually asking for.
    render(
      <>
        <label htmlFor="server-field">Server</label>
        <ServerPicker
          projectId="p_1"
          value={null}
          onChange={vi.fn()}
          triggerId="server-field"
          variant="field"
        />
      </>,
    );
    expect(screen.getByLabelText("Server")).toHaveAttribute(
      "id",
      "server-field",
    );
  });

  // BB-142's point, split so each render stands alone. A variant-keyed empty
  // label would be the second copy this ticket existed to delete.
  it("prompts, rather than reporting a status, in the field variant", () => {
    expect(trigger({ variant: "field" }).textContent).toMatch(/select server/i);
  });

  it("says the same thing in the pill", () => {
    expect(trigger().textContent).toMatch(/select server/i);
  });
});
