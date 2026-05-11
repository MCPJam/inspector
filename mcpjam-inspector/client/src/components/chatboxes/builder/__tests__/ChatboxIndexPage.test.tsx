import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatboxIndexPage } from "../ChatboxIndexPage";
import { CHATBOX_BLANK_STARTER, CHATBOX_TEMPLATE_STARTERS } from "../drafts";

const openLauncher = vi.fn();
const selectStarter = vi.fn();
const openChatbox = vi.fn();
const deleteChatbox = vi.fn();
const duplicateChatbox = vi.fn();

describe("ChatboxIndexPage", () => {
  const alphaItem = {
    chatboxId: "a",
    projectId: "w",
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

  it("shows first-run guided starters when there are no chatboxes and no query", () => {
    render(
      <ChatboxIndexPage
        chatboxes={[]}
        isLoading={false}
        onOpenChatbox={openChatbox}
        onDuplicateChatbox={duplicateChatbox}
        onDeleteChatbox={deleteChatbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    expect(
      screen.queryByPlaceholderText(/Search chatboxes/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Get started" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Start from scratch/i }),
    ).toBeInTheDocument();
    for (const starter of CHATBOX_TEMPLATE_STARTERS) {
      expect(
        screen.getByRole("button", { name: new RegExp(starter.title, "i") }),
      ).toBeInTheDocument();
    }
  });

  it("invokes the template starter when its tile is clicked", () => {
    const template = CHATBOX_TEMPLATE_STARTERS[0];
    render(
      <ChatboxIndexPage
        chatboxes={[]}
        isLoading={false}
        onOpenChatbox={openChatbox}
        onDuplicateChatbox={duplicateChatbox}
        onDeleteChatbox={deleteChatbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(template.title, "i") }),
    );
    expect(selectStarter).toHaveBeenCalledWith(template);
  });

  it("invokes blank starter when Start from scratch is clicked", () => {
    render(
      <ChatboxIndexPage
        chatboxes={[]}
        isLoading={false}
        onOpenChatbox={openChatbox}
        onDuplicateChatbox={duplicateChatbox}
        onDeleteChatbox={deleteChatbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Start from scratch/i }),
    );
    expect(selectStarter).toHaveBeenCalledWith(CHATBOX_BLANK_STARTER);
  });

  it("shows search-empty state when filters match nothing but chatboxes exist", async () => {
    render(
      <ChatboxIndexPage
        chatboxes={[
          {
            chatboxId: "a",
            projectId: "w",
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
        onOpenChatbox={openChatbox}
        onDuplicateChatbox={duplicateChatbox}
        onDeleteChatbox={deleteChatbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Search chatboxes/), {
      target: { value: "zzz-no-match" },
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "No matching chatboxes" }),
      ).toBeInTheDocument();
    });
  });

  it("shows populated cards and search when chatboxes exist", async () => {
    render(
      <ChatboxIndexPage
        chatboxes={[
          {
            chatboxId: "a",
            projectId: "w",
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
        onOpenChatbox={openChatbox}
        onDuplicateChatbox={duplicateChatbox}
        onDeleteChatbox={deleteChatbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    expect(await screen.findByText("Alpha")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Search chatboxes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cards" })).toBeInTheDocument();
  });

  it("opens a delete modal and only calls onDeleteChatbox after typing delete", async () => {
    deleteChatbox.mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <ChatboxIndexPage
        chatboxes={[alphaItem]}
        isLoading={false}
        onOpenChatbox={openChatbox}
        onDuplicateChatbox={duplicateChatbox}
        onDeleteChatbox={deleteChatbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Chatbox actions for Alpha" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Delete chatbox" }));
    expect(deleteChatbox).not.toHaveBeenCalled();
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
      expect(deleteChatbox).toHaveBeenCalledTimes(1);
      expect(deleteChatbox).toHaveBeenCalledWith(alphaItem);
    });
    expect(openChatbox).not.toHaveBeenCalled();
  });

  it("calls onOpenChatbox when Edit in builder is chosen from the menu", async () => {
    const user = userEvent.setup();
    render(
      <ChatboxIndexPage
        chatboxes={[alphaItem]}
        isLoading={false}
        onOpenChatbox={openChatbox}
        onDuplicateChatbox={duplicateChatbox}
        onDeleteChatbox={deleteChatbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Chatbox actions for Alpha" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Edit in builder" }));
    expect(openChatbox).toHaveBeenCalledTimes(1);
    expect(openChatbox).toHaveBeenCalledWith("a");
  });

  it("calls onOpenChatbox with usage when Usage & insights is chosen", async () => {
    const user = userEvent.setup();
    render(
      <ChatboxIndexPage
        chatboxes={[alphaItem]}
        isLoading={false}
        onOpenChatbox={openChatbox}
        onDuplicateChatbox={duplicateChatbox}
        onDeleteChatbox={deleteChatbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Chatbox actions for Alpha" }),
    );
    await user.click(
      screen.getByRole("menuitem", { name: "Usage & insights" }),
    );
    expect(openChatbox).toHaveBeenCalledWith("a", {
      initialViewMode: "usage",
    });
  });

  it("calls onDuplicateChatbox when Duplicate is chosen from the menu", async () => {
    const user = userEvent.setup();
    duplicateChatbox.mockResolvedValue(undefined);
    render(
      <ChatboxIndexPage
        chatboxes={[alphaItem]}
        isLoading={false}
        onOpenChatbox={openChatbox}
        onDuplicateChatbox={duplicateChatbox}
        onDeleteChatbox={deleteChatbox}
        onOpenStarterLauncher={openLauncher}
        onSelectStarter={selectStarter}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Chatbox actions for Alpha" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Duplicate" }));
    expect(duplicateChatbox).toHaveBeenCalledTimes(1);
    expect(duplicateChatbox).toHaveBeenCalledWith(alphaItem);
  });
});
