import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DirectoryDetailDialog } from "../DirectoryDetailDialog";
import type { DirectoryServer } from "@/hooks/useServerDirectory";
import type { DirectoryServerDetail } from "@/lib/claude-directory-detail";

function server(overrides: Partial<DirectoryServer> = {}): DirectoryServer {
  return {
    _id: "cat_1",
    source: "anthropic-directory",
    sourceId: "srv-0001",
    serverName: "com.mcpjam/anthropic-asana-1a2b3c4d",
    displayName: "Asana",
    description: "Coordinate tasks, projects, and goals.",
    verifiedTier: "partner",
    rowType: "remote",
    endpointKind: "fixed",
    remoteUrl: "https://mcp.asana.com/v2/mcp",
    isAuthless: false,
    curatedOverlap: false,
    ...overrides,
  };
}

function detail(
  overrides: Partial<DirectoryServerDetail> = {}
): DirectoryServerDetail {
  return {
    description: "The long-form listing description.",
    authorName: "Asana",
    authorUrl: "https://asana.com",
    categories: ["productivity"],
    toolNames: ["get_task", "update_task"],
    promptNames: [],
    permissions: "Read and write",
    sensitiveDataTypes: [],
    links: [
      { label: "Documentation", url: "https://developers.asana.com/docs" },
    ],
    authPosture: "auth_required",
    requiredFields: [],
    ...overrides,
  };
}

describe("DirectoryDetailDialog", () => {
  it("renders the parsed body: description, author, tools, access, links", () => {
    render(
      <DirectoryDetailDialog
        open
        onOpenChange={vi.fn()}
        server={server()}
        detail={detail()}
      />
    );
    expect(
      screen.getByText("The long-form listing description.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("By Asana · From Claude directory")
    ).toBeInTheDocument();
    expect(screen.getByText("Tools (2)")).toBeInTheDocument();
    expect(screen.getByText("get_task")).toBeInTheDocument();
    expect(screen.getByText("Permissions: Read and write")).toBeInTheDocument();
    expect(screen.getByText("Listed as requiring sign-in")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Documentation/ })).toHaveAttribute(
      "href",
      "https://developers.asana.com/docs"
    );
    expect(
      screen.getByText("https://mcp.asana.com/v2/mcp")
    ).toBeInTheDocument();
  });

  it("collapses a long tool list behind Show all", () => {
    const toolNames = Array.from({ length: 30 }, (_, i) => `tool_${i}`);
    render(
      <DirectoryDetailDialog
        open
        onOpenChange={vi.fn()}
        server={server()}
        detail={detail({ toolNames })}
      />
    );
    expect(screen.getByText("tool_0")).toBeInTheDocument();
    expect(screen.queryByText("tool_29")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all 30" }));
    expect(screen.getByText("tool_29")).toBeInTheDocument();
  });

  it("shows skeletons while the body loads", () => {
    render(
      <DirectoryDetailDialog
        open
        onOpenChange={vi.fn()}
        server={server()}
        detail={undefined}
      />
    );
    expect(screen.getByTestId("directory-detail-loading")).toBeInTheDocument();
    expect(
      screen.queryByText("Coordinate tasks, projects, and goals.")
    ).not.toBeInTheDocument();
  });

  it("falls back to the card summary when the body is unavailable", () => {
    render(
      <DirectoryDetailDialog
        open
        onOpenChange={vi.fn()}
        server={server()}
        detail={null}
      />
    );
    // The summary description still shows; body-only sections do not.
    expect(
      screen.getByText("Coordinate tasks, projects, and goals.")
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Tools \(/)).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("directory-detail-loading")
    ).not.toBeInTheDocument();
  });

  it("describes a tenant row's endpoint without inventing a URL", () => {
    render(
      <DirectoryDetailDialog
        open
        onOpenChange={vi.fn()}
        server={server({
          endpointKind: "tenant",
          remoteUrl: undefined,
          remoteUrlRegex: "https://mcp\\.[a-z0-9-]+\\.example/mcp",
        })}
        detail={null}
      />
    );
    expect(screen.getByText("Your own instance URL")).toBeInTheDocument();
  });

  it("renders the action the caller passes and closes on Close", () => {
    const onOpenChange = vi.fn();
    render(
      <DirectoryDetailDialog
        open
        onOpenChange={onOpenChange}
        server={server()}
        detail={null}
        action={<button>Connect</button>}
      />
    );
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    // Two "Close" buttons exist: Radix's corner X and the footer's. The
    // footer one renders last; either would close, this is the one we own.
    const closeButtons = screen.getAllByRole("button", { name: "Close" });
    fireEvent.click(closeButtons[closeButtons.length - 1]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
