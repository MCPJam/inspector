import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ClientsPill } from "../clients-pill";

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [
      {
        hostId: "host-a",
        name: "Claude",
        hostConfigId: "cfg-a",
        modelId: "gpt-4",
        serverCount: 0,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    isLoading: false,
  }),
}));

vi.mock("@/components/hosts/CreateHostDialog", () => ({
  CreateHostDialog: ({
    isOpen,
    onCreated,
  }: {
    isOpen: boolean;
    onCreated?: (hostId: string) => void;
  }) =>
    isOpen ? (
      <button
        type="button"
        data-testid="create-host-dialog"
        onClick={() => onCreated?.("host-new")}
      />
    ) : null,
}));

describe("ClientsPill create", () => {
  it("does not select a created client when the budget is full", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ClientsPill
        projectId="proj-1"
        value={["host-a"]}
        onChange={onChange}
        max={4}
        budget={{ choiceCount: 3, maxTargets: 3 }}
        testId="clients"
      />,
    );

    await user.click(screen.getByTestId("clients"));
    await user.click(screen.getByTestId("clients-pill-add"));
    await user.click(screen.getByTestId("create-host-dialog"));
    expect(onChange).not.toHaveBeenCalled();
  });
});
