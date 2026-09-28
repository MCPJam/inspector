import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Label } from "@mcpjam/design-system/label";

/**
 * `triggerId` against the REAL trigger.
 *
 * The promote dialog's suite asserts the same thing, but against a module mock
 * that renders `<button id={triggerId}>` — which proves the caller passes the
 * prop, not that `SelectTrigger` receives it. Move the id to a wrapper here
 * and that test still passes; this one does not.
 */
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [
      {
        hostId: "host-claude",
        name: "Claude",
        hostConfigId: "cfg-1",
        modelId: "m",
        serverCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    isLoading: false,
  }),
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

import { HostPicker } from "../HostPicker";

describe("HostPicker — label association", () => {
  it("lets a sibling <Label htmlFor> name the trigger", () => {
    render(
      <>
        <Label htmlFor="client-field">Client</Label>
        <HostPicker
          projectId="proj-1"
          value="host-claude"
          onChange={vi.fn()}
          location="eval_runner"
          includeNone={false}
          triggerId="client-field"
        />
      </>
    );

    // Without the id on `SelectTrigger` the accessible name is only the
    // selected value — "Claude", never "Client" — and this query throws.
    const trigger = screen.getByLabelText("Client");
    expect(trigger.getAttribute("role")).toBe("combobox");
  });

  it("forwards triggerClassName, so a grid caller can make it fill its cell", () => {
    // `SelectTrigger` is `w-fit` by default, which left Client narrower than
    // Server in the promote dialog's two-column row. No snapshot catches that.
    render(
      <HostPicker
        projectId="proj-1"
        value="host-claude"
        onChange={vi.fn()}
        location="eval_runner"
        includeNone={false}
        triggerId="client-field"
        triggerClassName="w-full"
      />
    );

    expect(screen.getByRole("combobox").className).toContain("w-full");
  });
});
