import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectMembershipRole } from "../hooks/useProjects";

const {
  mockSwarmsTab,
  mockRouteContext,
  mockViewerRole,
  mockUseAuth,
  mockUseViewerProjectRole,
} = vi.hoisted(() => {
  const mockViewerRole = {
    role: undefined as ProjectMembershipRole | undefined,
    isLoading: false,
  };
  return {
    mockSwarmsTab: vi.fn(() => <div>Swarms Tab</div>),
    mockViewerRole,
    mockUseAuth: vi.fn(() => ({
      user: { email: "guest@example.com" },
      isLoading: false,
    })),
    mockUseViewerProjectRole: vi.fn(() => mockViewerRole),
    mockRouteContext: {
      billingUiEnabled: true,
      activeTabBillingLocked: false,
      activeTabBillingFeature: "chatboxes" as string | null,
      convexProjectId: "project-1" as string | null,
      isAuthenticated: true,
    },
  };
});

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useOutletContext: () => mockRouteContext,
  };
});

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => mockUseAuth(),
}));

// Keep the real `canViewSwarms` decision + `EmptyState`; only the viewer-role
// signal is controlled per test.
vi.mock("../hooks/useProjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useProjects")>();
  return {
    ...actual,
    useViewerProjectRole: (args: unknown) => mockUseViewerProjectRole(args),
  };
});

// App.tsx pulls the chatbox surface (and its codemirror deps) through its
// module graph; stub them so importing the route is cheap.
vi.mock("../components/swarms/SwarmsTab", () => ({
  SwarmsTab: (props: unknown) => mockSwarmsTab(props),
}));
vi.mock("../components/ChatboxesTab", () => ({
  ChatboxesTab: () => null,
}));
vi.mock("../components/ui/json-editor/codemirror-json-editor", () => ({
  CodemirrorJsonEditor: () => null,
}));
vi.mock("@codemirror/lang-json", () => ({ json: () => ({}) }));
vi.mock("@codemirror/view", () => ({
  EditorView: class {},
  lineNumbers: () => ({}),
  highlightActiveLine: () => ({}),
  highlightSpecialChars: () => ({}),
  keymap: () => ({}),
}));
vi.mock("@codemirror/state", () => ({ EditorState: { create: vi.fn() } }));
vi.mock("@codemirror/commands", () => ({
  defaultKeymap: [],
  history: () => ({}),
  historyKeymap: [],
}));
vi.mock("@codemirror/language", () => ({
  bracketMatching: () => ({}),
  foldGutter: () => ({}),
  indentOnInput: () => ({}),
  syntaxHighlighting: () => ({}),
  defaultHighlightStyle: {},
}));
vi.mock("@codemirror/lint", () => ({
  linter: () => ({}),
  lintGutter: () => ({}),
}));

import { SwarmsRoute } from "../App";

describe("SwarmsRoute member-only gate", () => {
  beforeEach(() => {
    mockSwarmsTab.mockClear();
    mockUseAuth.mockClear();
    mockUseViewerProjectRole.mockClear();
    mockUseViewerProjectRole.mockImplementation(() => mockViewerRole);
    mockRouteContext.billingUiEnabled = true;
    mockRouteContext.activeTabBillingLocked = false;
    mockRouteContext.activeTabBillingFeature = "chatboxes";
    mockRouteContext.convexProjectId = "project-1";
    mockRouteContext.isAuthenticated = true;
    mockViewerRole.role = undefined;
    mockViewerRole.isLoading = false;
    mockUseAuth.mockReturnValue({
      user: { email: "guest@example.com" },
      isLoading: false,
    });
  });

  it("bounds role loading to WorkOS identity hydrate, not Convex auth alone", () => {
    mockUseAuth.mockReturnValue({ user: null, isLoading: true });
    mockViewerRole.isLoading = true;

    render(<SwarmsRoute />);

    expect(mockUseViewerProjectRole).toHaveBeenCalledWith({
      isAuthenticated: true,
      projectId: "project-1",
      viewerEmail: undefined,
      identityLoading: true,
    });
    expect(screen.queryByText("Swarms Tab")).not.toBeInTheDocument();
  });

  it("shows the access notice and does NOT mount SwarmsTab for a guest", () => {
    mockViewerRole.role = "guest";

    render(<SwarmsRoute />);

    expect(
      screen.getByText("Swarms is available to project members"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Swarms Tab")).not.toBeInTheDocument();
    expect(mockSwarmsTab).not.toHaveBeenCalled();
  });

  it("renders SwarmsTab for an anonymous Convex guest (personal-org owner)", () => {
    // Anonymous guests own a personal-org project and pass backend
    // requireProjectRole('member') via userId. The email-based members list
    // can't resolve them — skip the invitee-guest notice, don't spin/deny.
    mockUseAuth.mockReturnValue({ user: null, isLoading: false });
    mockViewerRole.role = undefined;
    mockViewerRole.isLoading = false;

    render(<SwarmsRoute />);

    expect(screen.getByText("Swarms Tab")).toBeInTheDocument();
    expect(
      screen.queryByText("Swarms is available to project members"),
    ).not.toBeInTheDocument();
    expect(mockSwarmsTab).toHaveBeenCalledWith({
      projectId: "project-1",
      isAuthenticated: true,
    });
  });

  it("renders SwarmsTab for a project member", () => {
    mockViewerRole.role = "member";

    render(<SwarmsRoute />);

    expect(screen.getByText("Swarms Tab")).toBeInTheDocument();
    expect(
      screen.queryByText("Swarms is available to project members"),
    ).not.toBeInTheDocument();
    expect(mockSwarmsTab).toHaveBeenCalledWith({
      projectId: "project-1",
      isAuthenticated: true,
    });
  });

  it("renders SwarmsTab for an owner/admin", () => {
    mockViewerRole.role = "admin";

    render(<SwarmsRoute />);

    expect(screen.getByText("Swarms Tab")).toBeInTheDocument();
    expect(mockSwarmsTab).toHaveBeenCalledTimes(1);
  });

  it("does NOT mount SwarmsTab while the viewer's role is still loading", () => {
    mockViewerRole.role = undefined;
    mockViewerRole.isLoading = true;

    render(<SwarmsRoute />);

    expect(screen.queryByText("Swarms Tab")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Swarms is available to project members"),
    ).not.toBeInTheDocument();
    expect(mockSwarmsTab).not.toHaveBeenCalled();
  });

  it("keeps existing behavior (renders SwarmsTab) for an unauthenticated local user", () => {
    mockRouteContext.isAuthenticated = false;
    mockRouteContext.convexProjectId = null;
    mockUseAuth.mockReturnValue({ user: null, isLoading: false });

    render(<SwarmsRoute />);

    expect(screen.getByText("Swarms Tab")).toBeInTheDocument();
    expect(mockSwarmsTab).toHaveBeenCalledWith({
      projectId: null,
      isAuthenticated: false,
    });
  });
});
