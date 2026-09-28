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
  it.each([
    '<img/src=x data-marker="payload" onerror=alert(1)>Hello',
    '<script data-marker="payload">alert(1)</script>',
    '<svg data-marker="payload" onload=alert(1)>',
    "&lt;img src=x onerror=alert(1)&gt;",
    "Promise<Object> and Array<Record<string, number>>",
  ])("renders stored text literally: %s", (description) => {
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
