import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateProjectDialog } from "../CreateProjectDialog";
import type { Organization } from "@/hooks/useOrganizations";

function makeOrg(id: string, name: string): Organization {
  return {
    _id: id,
    name,
    createdBy: "user-1",
    createdAt: 0,
    updatedAt: 0,
    myRole: "admin",
  };
}

const organizations = [makeOrg("org_a", "Acme"), makeOrg("org_b", "Nimbus")];

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof CreateProjectDialog>> = {},
) {
  const onCreate = vi.fn(async () => "project-created");
  const onOpenChange = vi.fn();
  const result = render(
    <CreateProjectDialog
      open
      onOpenChange={onOpenChange}
      organizations={organizations}
      defaultOrganizationId="org_a"
      defaultName="Project 3"
      onCreate={onCreate}
      {...overrides}
    />,
  );
  return { ...result, onCreate, onOpenChange };
}

describe("CreateProjectDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("prefills the suggested name and the active organization", () => {
    renderDialog();

    expect(screen.getByLabelText("Name")).toHaveValue("Project 3");
    // The select's trigger shows the default org's name, not its id.
    expect(screen.getByLabelText("Organization")).toHaveTextContent("Acme");
  });

  it("creates in the active organization without touching the select", async () => {
    const { onCreate } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith("Project 3", "org_a");
    });
  });

  it("creates in another organization once one is picked", async () => {
    const user = userEvent.setup();
    const { onCreate } = renderDialog();

    await user.click(screen.getByLabelText("Organization"));
    await user.click(await screen.findByRole("option", { name: "Nimbus" }));

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith("Project 3", "org_b");
    });
  });

  it("uses the name the user typed, trimmed", async () => {
    const { onCreate } = renderDialog();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "  Payments  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith("Payments", "org_a");
    });
  });

  it("submits on Enter from the name field", async () => {
    const { onCreate } = renderDialog();

    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Enter" });

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith("Project 3", "org_a");
    });
  });

  it("refuses an empty name", () => {
    const { onCreate } = renderDialog();

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "   " },
    });

    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("closes on Cancel without creating anything", () => {
    const { onCreate, onOpenChange } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onCreate).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("hides the organization field when there is nothing to choose between", async () => {
    // Guests and local installs: no organizations at all, so the control
    // would be an empty box asking a question with no answers.
    const { onCreate } = renderDialog({
      organizations: [],
      defaultOrganizationId: undefined,
    });

    expect(screen.queryByLabelText("Organization")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledWith("Project 3", undefined);
    });
  });

  it("re-prefills each time it opens", () => {
    // The dialog stays mounted for the life of the switcher, so the prefill
    // has to reflect the project list at the moment it is opened, not at mount.
    const { rerender } = render(
      <CreateProjectDialog
        open={false}
        onOpenChange={vi.fn()}
        organizations={organizations}
        defaultOrganizationId="org_a"
        defaultName="Project 3"
        onCreate={vi.fn(async () => "")}
      />,
    );

    rerender(
      <CreateProjectDialog
        open
        onOpenChange={vi.fn()}
        organizations={organizations}
        defaultOrganizationId="org_b"
        defaultName="Project 9"
        onCreate={vi.fn(async () => "")}
      />,
    );

    expect(screen.getByLabelText("Name")).toHaveValue("Project 9");
    expect(screen.getByLabelText("Organization")).toHaveTextContent("Nimbus");
  });
});
