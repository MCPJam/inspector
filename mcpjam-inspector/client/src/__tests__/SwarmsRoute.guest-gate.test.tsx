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
import { GATED_FEATURE_COPY } from "@/components/guest-preview/feature-highlights";

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
    mockUseAuth.mockReturnValue({
      user: { email: "guest@example.com" },
      isLoading: false,
    });
  });

  it("bounds role loading to WorkOS identity hydrate, not Convex auth alone", () => {
    mockUseAuth.mockReturnValue({ user: null, isLoading: true });
    mockViewerRole.isLoading = true;

    renderRoute(<SwarmsRoute />);

    expect(mockUseViewerProjectRole).toHaveBeenCalledWith({
      // `false` until WorkOS produces a user, NOT Convex's `isAuthenticated`,
      // which is true for anonymous sessions (REEV-6). The members query is
      // member-only, so it must not run for a visitor who has no account and
      // could not read the answer. It enables the moment identity resolves.
      isAuthenticated: false,
      projectId: "project-1",
      viewerEmail: undefined,
      // The point of this test, unchanged: the wait is bounded by WorkOS
      // hydrate rather than Convex auth, so an anonymous session never spins
      // forever.
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

  it("gives an anonymous Convex guest the preview, not the tab", () => {
    // REVERSED by REEV-6, and this is the case the whole gate exists for.
    // Anonymous guests own a personal-org project and pass backend
    // requireProjectRole('member') via userId, so every authorization check
    // waves them through and Convex `isAuthenticated` is true for them. WorkOS
    // identity is the only signal that tells them apart, and without it they
    // reached the real tab and fired its member-only queries.
    //
    // They still skip the INVITEE-guest notice below: that is a different
    // population, a signed-in person holding project role `guest`, who needs
    // to be told to ask an admin rather than to make an account.
    mockUseAuth.mockReturnValue({ user: null, isLoading: false });
    mockViewerRole.role = undefined;
    mockViewerRole.isLoading = false;

    renderRoute(<SwarmsRoute />);

    expect(
      screen.getByText(GATED_FEATURE_COPY.swarms.heroTitle),
    ).toBeInTheDocument();
    expect(screen.queryByText("Swarms Tab")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Swarms is available to project members"),
    ).not.toBeInTheDocument();
    expect(mockSwarmsTab).not.toHaveBeenCalled();
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

  it("gates a signed-out local user too", () => {
    // Also reversed. Local was exempt on the reasoning that it has no WorkOS
    // to sign up through, which was simply wrong: local signs in through the
    // same WorkOS and resolves the same plan. The exemption sent a signed-out
    // local user into the real tab to fail at the backend instead, which is a
    // worse answer than the preview. (Sophie, in review: "can we really not
    // gate features on the local app?")
    mockRouteContext.isAuthenticated = false;
    mockRouteContext.convexProjectId = null;
    mockUseAuth.mockReturnValue({ user: null, isLoading: false });

    renderRoute(<SwarmsRoute />);

    expect(
      screen.getByText(GATED_FEATURE_COPY.swarms.heroTitle),
    ).toBeInTheDocument();
    expect(mockSwarmsTab).not.toHaveBeenCalled();
  });

  it("still gives a signed-in local user the real tab", () => {
    mockRouteContext.isAuthenticated = false;
    mockRouteContext.convexProjectId = null;
    mockUseAuth.mockReturnValue({
      user: { email: "local@example.com" },
      isLoading: false,
    });

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
