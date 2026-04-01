import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SandboxIndexPage } from "../SandboxIndexPage";
import { SANDBOX_STARTERS } from "../drafts";

const openLauncher = vi.fn();
const selectStarter = vi.fn();
const openSandbox = vi.fn();
const deleteSandbox = vi.fn();
const duplicateSandbox = vi.fn();

describe("SandboxIndexPage", () => {
  const alphaItem = {
    sandboxId: "a",
    workspaceId: "w",
    name: "Alpha",
    description: "d",
    hostStyle: "claude" as const,
    mode: "invited_only" as const,
    allowGuestAccess: false,
    serverCount: 1,
    serverNames: ["s1"],
    createdAt: 1,
    updatedAt: 1,
  };

  it("shows first-run guided starters when there are no sandboxes and no query", () => {
    render(
      <SandboxIndexPage
        sandboxes={[]}
        isLoading={false}
        onOpenSandbox={openSandbox}
        onDuplicateSandbox={duplicateSandbox}
        onDeleteSandbox={deleteSandbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Create your first sandbox" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/Search sandboxes/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Internal QA sandbox")).toBeInTheDocument();
    expect(
      screen.getByText("ICP demo / share-link sandbox"),
    ).toBeInTheDocument();
    expect(screen.getByText("Blank sandbox")).toBeInTheDocument();
  });

  it("invokes starter selection when a first-run tile is clicked", () => {
    render(
      <SandboxIndexPage
        sandboxes={[]}
        isLoading={false}
        onOpenSandbox={openSandbox}
        onDuplicateSandbox={duplicateSandbox}
        onDeleteSandbox={deleteSandbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    fireEvent.click(screen.getByText("Internal QA sandbox"));
    expect(selectStarter).toHaveBeenCalledTimes(1);
    expect(selectStarter).toHaveBeenCalledWith(
      SANDBOX_STARTERS.find((s) => s.id === "internal-qa"),
    );
  });

  it("shows search-empty state when filters match nothing but sandboxes exist", async () => {
    render(
      <SandboxIndexPage
        sandboxes={[
          {
            sandboxId: "a",
            workspaceId: "w",
            name: "Alpha",
            description: "",
            hostStyle: "claude",
            mode: "invited_only",
            allowGuestAccess: false,
            serverCount: 0,
            serverNames: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
        isLoading={false}
        onOpenSandbox={openSandbox}
        onDuplicateSandbox={duplicateSandbox}
        onDeleteSandbox={deleteSandbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Search sandboxes/), {
      target: { value: "zzz-no-match" },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "No matching sandboxes" }),
      ).toBeInTheDocument();
    });
  });

  it("shows populated cards and search when sandboxes exist", async () => {
    render(
      <SandboxIndexPage
        sandboxes={[
          {
            sandboxId: "a",
            workspaceId: "w",
            name: "Alpha",
            description: "d",
            hostStyle: "claude",
            mode: "invited_only",
            allowGuestAccess: false,
            serverCount: 1,
            serverNames: ["s1"],
            createdAt: 1,
            updatedAt: 1,
          },
        ]}
        isLoading={false}
        onOpenSandbox={openSandbox}
        onDuplicateSandbox={duplicateSandbox}
        onDeleteSandbox={deleteSandbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search sandboxes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cards" })).toBeInTheDocument();
  });

  it("opens a delete modal and only calls onDeleteSandbox after typing delete", async () => {
    deleteSandbox.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <SandboxIndexPage
        sandboxes={[alphaItem]}
        isLoading={false}
        onOpenSandbox={openSandbox}
        onDuplicateSandbox={duplicateSandbox}
        onDeleteSandbox={deleteSandbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Sandbox actions for Alpha" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete sandbox" }));
    expect(deleteSandbox).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    const confirmButton = screen.getByRole("button", {
      name: "Delete permanently",
    });
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("delete"), {
      target: { value: "delete" },
    });
    expect(confirmButton).not.toBeDisabled();

    fireEvent.click(confirmButton);
    await waitFor(() => {
      expect(deleteSandbox).toHaveBeenCalledTimes(1);
      expect(deleteSandbox).toHaveBeenCalledWith(alphaItem);
    });
    expect(openSandbox).not.toHaveBeenCalled();
  });

  it("calls onOpenSandbox when Edit in builder is chosen from the menu", async () => {
    const user = userEvent.setup();
    render(
      <SandboxIndexPage
        sandboxes={[alphaItem]}
        isLoading={false}
        onOpenSandbox={openSandbox}
        onDuplicateSandbox={duplicateSandbox}
        onDeleteSandbox={deleteSandbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Sandbox actions for Alpha" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit in builder" }));
    expect(openSandbox).toHaveBeenCalledTimes(1);
    expect(openSandbox).toHaveBeenCalledWith("a");
  });

  it("calls onOpenSandbox with usage when Usage & insights is chosen", async () => {
    const user = userEvent.setup();
    render(
      <SandboxIndexPage
        sandboxes={[alphaItem]}
        isLoading={false}
        onOpenSandbox={openSandbox}
        onDuplicateSandbox={duplicateSandbox}
        onDeleteSandbox={deleteSandbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Sandbox actions for Alpha" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Usage & insights" }),
    );
    expect(openSandbox).toHaveBeenCalledWith("a", {
      initialViewMode: "usage",
    });
  });

  it("calls onDuplicateSandbox when Duplicate is chosen from the menu", async () => {
    const user = userEvent.setup();
    duplicateSandbox.mockResolvedValue(undefined);
    render(
      <SandboxIndexPage
        sandboxes={[alphaItem]}
        isLoading={false}
        onOpenSandbox={openSandbox}
        onDuplicateSandbox={duplicateSandbox}
        onDeleteSandbox={deleteSandbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Sandbox actions for Alpha" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(duplicateSandbox).toHaveBeenCalledTimes(1);
    expect(duplicateSandbox).toHaveBeenCalledWith(alphaItem);
  });
});
