import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Project } from "@/state/app-types";
import { ProjectManagementDialog } from "../ProjectManagementDialog";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "Demo project",
    servers: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("ProjectManagementDialog", () => {
  it("lists names and descriptions containing markup as literal text (MJ-013)", () => {
    const description = '<img src="x" data-marker="desc"><b>bold</b> -> next';
    const name = '<i data-marker="name">Demo</i>';
    render(
      <ProjectManagementDialog
        isOpen
        onClose={vi.fn()}
        projects={{ "proj-1": makeProject({ name, description }) }}
        activeProjectId="proj-1"
        onCreateProject={vi.fn()}
        onUpdateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onDuplicateProject={vi.fn()}
        onSetDefaultProject={vi.fn()}
        onExportProject={vi.fn()}
        onImportProject={vi.fn()}
      />,
    );

    expect(screen.getByText(description)).toBeInTheDocument();
    expect(screen.getByText(name)).toBeInTheDocument();
    // The dialog renders into a portal, so look at the whole document.
    expect(document.body.querySelector("[data-marker]")).toBeNull();
    expect(document.body.querySelector("b")).toBeNull();
  });
});
