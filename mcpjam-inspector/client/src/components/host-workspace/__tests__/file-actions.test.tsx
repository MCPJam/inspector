import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import {
  FileLink,
  FileOpenWith,
  ToolResourceAttachments,
  WorkspaceFileActionsProvider,
} from "../file-actions";
import { MemoizedMarkdown } from "@/components/chat-v2/thread/memomized-markdown";
import { rewriteChatLinks } from "@/components/chat-v2/thread/chat-links";
const viewer = {
  kind: "file" as const,
  toolName: "cad.view",
  title: "CAD Viewer",
  resourceUri: "file:///part.stl",
};
const other = { ...viewer, toolName: "mesh.view", title: "Mesh Viewer" };
function fixture(viewers: (typeof viewer)[] = [viewer]) {
  const discoverFile = vi.fn(async () => viewers);
  const open = vi.fn(async () => {});
  return {
    discoverFile,
    open,
    value: { api: { discoverFile } as any, serverIds: ["saved-id"], open },
  };
}
const reference = { serverId: "saved-id", resourceUri: "file:///part.stl" };

describe("file viewers open from the file itself", () => {
  it("does nothing without a qualified workspace or for an ordinary server name", () => {
    const f = fixture();
    const view = render(<FileOpenWith reference={reference} />);
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(
      <WorkspaceFileActionsProvider value={f.value}>
        <FileOpenWith
          reference={{ ...reference, serverId: "server-name" }}
        />
        <FileLink
          reference={{ ...reference, serverId: "server-name" }}
          label="part.stl"
        />
      </WorkspaceFileActionsProvider>,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("part.stl")).toBeInTheDocument();
    expect(f.discoverFile).not.toHaveBeenCalled();
  });

  it("opens the only matching viewer directly, with no chooser", async () => {
    const f = fixture();
    const user = userEvent.setup();
    render(
      <WorkspaceFileActionsProvider value={f.value}>
        <FileLink reference={reference} label="part.stl" />
      </WorkspaceFileActionsProvider>,
    );
    expect(f.discoverFile).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "part.stl" }));
    await waitFor(() =>
      expect(f.open).toHaveBeenCalledWith("saved-id", viewer),
    );
    expect(f.discoverFile.mock.calls[0].slice(0, 2)).toEqual([
      "saved-id",
      "file:///part.stl",
    ]);
    expect(screen.queryByText("Open with…")).toBeNull();
  });

  it("shows Open with… only when several viewers match", async () => {
    const f = fixture([viewer, other]);
    const user = userEvent.setup();
    render(
      <WorkspaceFileActionsProvider value={f.value}>
        <FileOpenWith reference={reference} />
      </WorkspaceFileActionsProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(await screen.findByText("Open with…")).toBeInTheDocument();
    expect(f.open).not.toHaveBeenCalled();
    await user.click(screen.getByRole("menuitem", { name: "Mesh Viewer" }));
    await waitFor(() => expect(f.open).toHaveBeenCalledWith("saved-id", other));
  });

  it("says so when no viewer matches, and respects file viewers being off", async () => {
    const f = fixture([]);
    const user = userEvent.setup();
    const view = render(
      <WorkspaceFileActionsProvider value={f.value}>
        <FileLink reference={reference} label="part.stl" />
      </WorkspaceFileActionsProvider>,
    );
    await user.click(screen.getByRole("button", { name: "part.stl" }));
    expect(
      await screen.findByRole("menuitem", {
        name: "No viewer can open this file",
      }),
    ).toBeInTheDocument();
    view.rerender(
      <WorkspaceFileActionsProvider value={{ ...f.value, enabled: false }}>
        <FileLink reference={reference} label="part.stl" />
      </WorkspaceFileActionsProvider>,
    );
    expect(screen.queryByRole("button", { name: "part.stl" })).toBeNull();
  });

  it("renders result links by name without reading anything on render", async () => {
    const f = fixture();
    const user = userEvent.setup();
    render(
      <WorkspaceFileActionsProvider value={f.value}>
        <ToolResourceAttachments
          serverId="saved-id"
          result={{
            content: [
              {
                type: "resource_link",
                name: "Triangle",
                uri: "fixture-file://parts/triangle.stl",
              },
            ],
          }}
        />
      </WorkspaceFileActionsProvider>,
    );
    expect(screen.getByText("Triangle")).toBeInTheDocument();
    expect(screen.queryByText(/fixture-file/)).toBeNull();
    expect(f.discoverFile).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Triangle" }));
    await waitFor(() => expect(f.open).toHaveBeenCalledTimes(1));
  });

  it("turns a resource the chat produced into a file link in the reply, never showing its URI", async () => {
    const f = fixture();
    const user = userEvent.setup();
    const uri = "fixture-file://parts/joystick-cap.stl";
    render(
      <WorkspaceFileActionsProvider value={f.value}>
        <ToolResourceAttachments
          serverId="saved-id"
          result={{
            content: [{ type: "resource_link", name: "joystick-cap.stl", uri }],
          }}
        />
        <MemoizedMarkdown
          content={`Here's the copy: [Download joystick-cap.stl](${uri}). Raw: ${uri}`}
        />
      </WorkspaceFileActionsProvider>,
    );
    const link = await screen.findByRole("button", {
      name: "Download joystick-cap.stl",
    });
    expect(screen.queryByText(new RegExp(uri))).toBeNull();
    // The bare URI became a link labelled with the file name.
    expect(
      screen.getAllByRole("button", { name: "joystick-cap.stl" }).length,
    ).toBeGreaterThan(0);
    await user.click(link);
    await waitFor(() =>
      expect(f.open).toHaveBeenCalledWith("saved-id", viewer),
    );
  });
});

describe("links the chat handles itself", () => {
  const links = {
    "x-file://a.stl": { serverId: "s", name: "a.stl" },
    "x-file://a.stl.bak": { serverId: "s", name: "a [backup]" },
  };
  it("links plain occurrences and resource links, leaving code and other links alone", () => {
    const { content, targets } = rewriteChatLinks(
      "see x-file://a.stl.bak and x-file://a.stl, `x-file://a.stl`, [a](x-file://a.stl) [site](https://example.com) <x-file://a.stl>",
      links,
      false,
    );
    expect(content).toBe(
      "see [a \\[backup\\]](#mcpjam-link-0) and [a.stl](#mcpjam-link-1), `x-file://a.stl`, [a](#mcpjam-link-2) [site](https://example.com) [a.stl](#mcpjam-link-3)",
    );
    expect(targets).toEqual([
      "x-file://a.stl.bak",
      "x-file://a.stl",
      "x-file://a.stl",
      "x-file://a.stl",
    ]);
    expect(rewriteChatLinks("nothing here", links, false).targets).toEqual([]);
  });
  it("handles plugin deep links only when the chat can open them", () => {
    const link = "codex://plugins/bits/app/library?path=%2Fparts";
    expect(rewriteChatLinks(`[Open](${link})`, {}, false).targets).toEqual([]);
    expect(rewriteChatLinks(`[Open](${link})`, {}, true)).toEqual({
      content: "[Open](#mcpjam-link-0)",
      targets: [link],
    });
    expect(rewriteChatLinks("[Bad](codex://nope)", {}, true).targets).toEqual(
      [],
    );
  });
});
