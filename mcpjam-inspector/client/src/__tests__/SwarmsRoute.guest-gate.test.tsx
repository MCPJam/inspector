import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectMembershipRole } from "../hooks/useProjects";

const {
  mockSwarmsTab,
  mockRouteContext,
  mockViewerRole,
  mockUseAuth,
  mockUseViewerProjectRole,
  mockFlags,
} = vi.hoisted(() => {
  const mockViewerRole = {
    role: undefined as ProjectMembershipRole | undefined,
    isLoading: false,
  };
  return {
    // Tri-state, like PostHog: `undefined` while flags hydrate. These tests
    // are about the member-only gate, so the feature flag is ON by default and
    // the flag gate itself is covered separately below.
    mockFlags: { sandboxesEnabled: true as boolean | undefined },
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
      activeTabBillingFeature: "scenarios" as string | null,
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
    // Rendered outside a <Router> here, so stand it up as a marker — which
    // also lets the flag test assert WHERE a blocked user is sent.
    Navigate: ({ to }: { to: string }) => <div>{`redirected:${to}`}</div>,
  };
});

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => mockUseAuth(),
}));

vi.mock("../hooks/useSandboxesEnabled", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../hooks/useSandboxesEnabled")>();
  return {
    ...actual,
    useSandboxesEnabledState: () => mockFlags.sandboxesEnabled,
    useSandboxesEnabled: () => mockFlags.sandboxesEnabled === true,
  };
});

// Keep the real `canViewSwarms` decision + `EmptyState`; only the viewer-role
// signal is controlled per test.
vi.mock("../hooks/useProjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useProjects")>();
  return {
    ...actual,
    useViewerProjectRole: (args: unknown) => mockUseViewerProjectRole(args),
  };
});

// App.tsx pulls the scenario surface (and its codemirror deps) through its
// module graph; stub them so importing the route is cheap.
vi.mock("../components/swarms/SwarmsTab", () => ({
  SwarmsTab: (props: unknown) => mockSwarmsTab(props),
}));
vi.mock("../components/UserTestingTab", () => ({
  UserTestingTab: () => null,
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

/**
 * The route's redirect goes through `ScopedNavigate`, which carries the active
 * project into a project-owned target — so it needs a router context to read
 * the current location from. Mounting inside a `MemoryRouter` gives it one;
 * the `Navigate` marker mocked above still renders, and with no project in the
 * URL the target is the plain logical path these assertions expect.
 */
function renderRoute(element: React.ReactElement) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

describe("SwarmsRoute member-only gate", () => {
  beforeEach(() => {
    mockSwarmsTab.mockClear();
    mockUseAuth.mockClear();
    mockUseViewerProjectRole.mockClear();
    mockUseViewerProjectRole.mockImplementation(() => mockViewerRole);
    mockRouteContext.billingUiEnabled = true;
    mockRouteContext.activeTabBillingLocked = false;
    mockRouteContext.activeTabBillingFeature = "scenarios";
    mockRouteContext.convexProjectId = "project-1";
    mockRouteContext.isAuthenticated = true;
    mockViewerRole.role = undefined;
    mockViewerRole.isLoading = false;
    mockFlags.sandboxesEnabled = true;
    mockUseAuth.mockReturnValue({
      user: { email: "guest@example.com" },
      isLoading: false,
    });
  });

  // The sidebar filters the Swarms nav item on `sandboxes-enabled`, but the
  // route itself was unguarded — a direct URL or stale bookmark mounted the
  // whole surface (and fired its member-only queries) for flagged-out users.
  it("redirects to servers when the sandboxes flag is off", () => {
    mockFlags.sandboxesEnabled = false;

    renderRoute(<SwarmsRoute />);

    expect(screen.getByText("redirected:/servers")).toBeInTheDocument();
    expect(screen.queryByText("Swarms Tab")).not.toBeInTheDocument();
    expect(mockSwarmsTab).not.toHaveBeenCalled();
  });

  it("renders nothing — and does not bounce — while the flag is still hydrating", () => {
    // Redirecting on `undefined` would strand a flagged-in user who cold-loads
    // /swarms directly, before PostHog has answered.
    mockFlags.sandboxesEnabled = undefined;

    renderRoute(<SwarmsRoute />);

    expect(screen.queryByText("Swarms Tab")).not.toBeInTheDocument();
    expect(mockSwarmsTab).not.toHaveBeenCalled();
  });

  it("bounds role loading to WorkOS identity hydrate, not Convex auth alone", () => {
    mockUseAuth.mockReturnValue({ user: null, isLoading: true });
    mockViewerRole.isLoading = true;

    renderRoute(<SwarmsRoute />);

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

    renderRoute(<SwarmsRoute />);

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

    renderRoute(<SwarmsRoute />);

    expect(screen.getByText("Swarms Tab")).toBeInTheDocument();
    expect(
      screen.queryByText("Swarms is available to project members"),
    ).not.toBeInTheDocument();
    expect(mockSwarmsTab).toHaveBeenCalledWith({
      projectId: "project-1",
      isAuthenticated: true,
      swarmId: null,
      createFlow: false,
    });
  });

  it("renders SwarmsTab for a project member", () => {
    mockViewerRole.role = "member";

    renderRoute(<SwarmsRoute />);

    expect(screen.getByText("Swarms Tab")).toBeInTheDocument();
    expect(
      screen.queryByText("Swarms is available to project members"),
    ).not.toBeInTheDocument();
    expect(mockSwarmsTab).toHaveBeenCalledWith({
      projectId: "project-1",
      isAuthenticated: true,
      swarmId: null,
      createFlow: false,
    });
  });

  it("renders SwarmsTab for an owner/admin", () => {
    mockViewerRole.role = "admin";

    renderRoute(<SwarmsRoute />);

    expect(screen.getByText("Swarms Tab")).toBeInTheDocument();
    expect(mockSwarmsTab).toHaveBeenCalledTimes(1);
  });

  it("does NOT mount SwarmsTab while the viewer's role is still loading", () => {
    mockViewerRole.role = undefined;
    mockViewerRole.isLoading = true;

    renderRoute(<SwarmsRoute />);

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

    renderRoute(<SwarmsRoute />);

    expect(screen.getByText("Swarms Tab")).toBeInTheDocument();
    expect(mockSwarmsTab).toHaveBeenCalledWith({
      projectId: null,
      isAuthenticated: false,
      swarmId: null,
      createFlow: false,
    });
  });
});
