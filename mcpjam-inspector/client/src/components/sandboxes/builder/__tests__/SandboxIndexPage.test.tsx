import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SandboxIndexPage } from "../SandboxIndexPage";
import { SANDBOX_STARTERS } from "../drafts";

const openLauncher = vi.fn();
const selectStarter = vi.fn();
const openSandbox = vi.fn();

describe("SandboxIndexPage", () => {
  it("shows first-run guided starters when there are no sandboxes and no query", () => {
    render(
      <SandboxIndexPage
        sandboxes={[]}
        isLoading={false}
        onOpenSandbox={openSandbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Create your first sandbox" }),
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/Search sandboxes/)).not.toBeInTheDocument();
    expect(screen.getByText("Internal QA sandbox")).toBeInTheDocument();
    expect(screen.getByText("ICP demo / share-link sandbox")).toBeInTheDocument();
    expect(screen.getByText("Blank sandbox")).toBeInTheDocument();
  });

  it("invokes starter selection when a first-run tile is clicked", () => {
    render(
      <SandboxIndexPage
        sandboxes={[]}
        isLoading={false}
        onOpenSandbox={openSandbox}
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
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search sandboxes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cards" })).toBeInTheDocument();
  });
});
