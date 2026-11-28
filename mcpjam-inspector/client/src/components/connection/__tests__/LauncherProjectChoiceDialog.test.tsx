import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useLauncherProjectChoiceStore } from "@/lib/launcher-attach/project-choice";
import { LauncherProjectChoiceDialog } from "../LauncherProjectChoiceDialog";

const PROJECTS = [
  { id: "proj-acme", name: "Acme Tools" },
  { id: "proj-billing", name: "Billing" },
];

function ask() {
  let answer: Promise<string | null> | undefined;
  act(() => {
    answer = useLauncherProjectChoiceStore.getState().ask({
      attachId: "a1",
      serverName: "billing-mcp",
      projects: PROJECTS,
      defaultProjectId: "proj-acme",
    });
  });
  return answer!;
}

describe("LauncherProjectChoiceDialog", () => {
  afterEach(() => useLauncherProjectChoiceStore.setState({ queue: [] }));

  it("preselects this tab's project and saves where the developer picks", async () => {
    render(<LauncherProjectChoiceDialog />);
    const answer = ask();

    expect(screen.getByText("Add billing-mcp to which project?")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add to Acme Tools" })).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Billing"));
    fireEvent.click(screen.getByRole("button", { name: "Add to Billing" }));

    await expect(answer).resolves.toBe("proj-billing");
    expect(screen.queryByTestId("launcher-project-choice-dialog")).toBeNull();
  });

  it("Cancel saves nothing", async () => {
    render(<LauncherProjectChoiceDialog />);
    const answer = ask();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(answer).resolves.toBeNull();
  });

  it("closes when the dev command quits before an answer", async () => {
    render(<LauncherProjectChoiceDialog />);
    const answer = ask();
    act(() => useLauncherProjectChoiceStore.getState().withdraw("a1"));
    await expect(answer).resolves.toBeNull();
    expect(screen.queryByTestId("launcher-project-choice-dialog")).toBeNull();
  });
});
