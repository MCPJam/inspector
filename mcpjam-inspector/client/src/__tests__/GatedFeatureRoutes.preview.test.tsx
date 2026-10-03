import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The REEV-6 gate on `/swarms` and `/user-testing`: who gets the real tab, who
 * gets the preview, and which way out the preview offers them.
 *
 * HOSTED throughout. A local install has no WorkOS to sign up through, so
 * there is nothing to gate there — that case is covered by
 * `SwarmsRoute.guest-gate.test.tsx`, which runs unhosted and asserts the real
 * tab still mounts.
 */

const {
  mockFlags,
  mockSwarmsTab,
  mockUserTestingTab,
  mockRouteContext,
  mockUseAuth,
  mockUseIsMemberActor,
  mockUseViewerProjectRole,
} = vi.hoisted(() => ({
    // `sandboxes-enabled`, tri-state like PostHog. ON by default: the preview
    // only exists for visitors the flag lets in.
    mockFlags: { sandboxesEnabled: true as boolean | undefined },
    mockSwarmsTab: vi.fn(() => <div>Swarms Tab</div>),
    mockUserTestingTab: vi.fn(() => <div>User Testing Tab</div>),
    mockUseAuth: vi.fn(() => ({
      user: { email: "member@example.com" } as { email: string } | null,
      isLoading: false,
      signIn: vi.fn(),
      signUp: vi.fn(),
    })),
    // The gate's identity source. WorkOS is still mocked below because the
    // route reads it for the invitee-guest notice, but it is no longer what
    // decides preview vs tab.
    mockUseIsMemberActor: vi.fn(() => true as boolean | undefined),
    mockUseViewerProjectRole: vi.fn(),
    mockRouteContext: {
      billingUiEnabled: true,
      activeTabBillingLocked: false,
      activeTabBillingFeature: "scenarios" as string | null,
      convexProjectId: "project-1" as string | null,
      isAuthenticated: true,
      shellBillingStatus: {
        plan: "free",
        effectivePlan: "free",
        canManageBilling: true,
      },
      upgradePlanForActiveTab: "team" as string | null,
      billingOrganizationId: "org-1",
      navigateToTarget: vi.fn(),
    },
  }));

vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return { ...actual, HOSTED_MODE: true };
});

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return { ...actual, useOutletContext: () => mockRouteContext };
});

vi.mock("@workos-inc/authkit-react", () => ({ useAuth: () => mockUseAuth() }));
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => mockUseIsMemberActor(),
}));

vi.mock("@/hooks/useSandboxesEnabled", () => ({
  useSandboxesEnabled: () => mockFlags.sandboxesEnabled === true,
  useSandboxesEnabledState: () => mockFlags.sandboxesEnabled,
}));

vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));

// SwarmsRoute resolves the viewer's project role for its *invitee guest*
// notice — a Convex query, and a different population from the account-less
// guest this suite is about. Report "member" so that gate never fires and each
// assertion below is about the REEV-6 gate alone.
vi.mock("../hooks/useProjects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useProjects")>();
  return {
    ...actual,
    useViewerProjectRole: (args: unknown) => {
      mockUseViewerProjectRole(args);
      return { role: "member", isLoading: false };
    },
  };
});

vi.mock("../components/swarms/SwarmsTab", () => ({
  SwarmsTab: (props: unknown) => mockSwarmsTab(props),
}));
vi.mock("../components/UserTestingTab", () => ({
  UserTestingTab: (props: unknown) => mockUserTestingTab(props),
}));

// App's module graph drags the codemirror editor in; stub it so importing a
// route stays cheap.
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

import { ScenariosRoute, SwarmsRoute } from "../App";
import { GATED_FEATURE_COPY } from "@/components/guest-preview/feature-highlights";

const SURFACES = [
  {
    name: "Swarms",
    Route: SwarmsRoute,
    feature: "swarms" as const,
    tabText: "Swarms Tab",
    tabMock: mockSwarmsTab,
  },
  {
    name: "User Testing",
    Route: ScenariosRoute,
    feature: "user-testing" as const,
    tabText: "User Testing Tab",
    tabMock: mockUserTestingTab,
  },
];

/**
 * Both halves of the location matter.
 *
 * `MemoryRouter` supplies the router context, but these routes are also
 * mounted outside a router on the legacy hash path, so they fall back to
 * `window.location.pathname` through `getRouteFallbackPathname()`. A test that
 * only set `initialEntries` would leave the component reading "/" and would
 * pass for a reason that has nothing to do with the path under test.
 */
function renderRoute(element: React.ReactElement, at = "/") {
  window.history.replaceState({}, "", at);
  return render(<MemoryRouter initialEntries={[at]}>{element}</MemoryRouter>);
}

function signedIn() {
  mockUseIsMemberActor.mockReturnValue(true);
  mockUseAuth.mockReturnValue({
    user: { email: "member@example.com" },
    isLoading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
  });
}

function guest() {
  // `false` means the JWT Convex is holding belongs to an anonymous actor.
  // Note this is NOT "no WorkOS user": in hosted mode a signed-in person's
  // first render carries a guest bearer, which is the whole reason the gate
  // reads this rather than `useAuth().user`.
  mockUseIsMemberActor.mockReturnValue(false);
  mockUseAuth.mockReturnValue({
    user: null,
    isLoading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
  });
}

describe("gated feature routes — hosted", () => {
  beforeEach(() => {
    mockSwarmsTab.mockClear();
    mockUserTestingTab.mockClear();
    mockRouteContext.activeTabBillingLocked = false;
    mockRouteContext.billingUiEnabled = true;
    mockRouteContext.convexProjectId = "project-1";
    mockRouteContext.isAuthenticated = true;
    mockUseViewerProjectRole.mockClear();
    mockFlags.sandboxesEnabled = true;
    signedIn();
  });

  describe.each(SURFACES)("$name", ({ Route, feature, tabText, tabMock }) => {
    const copy = GATED_FEATURE_COPY[feature];

    // `sandboxes-enabled` is the rollout control and runs BEFORE the preview.
    // A visitor the flag excludes gets no surface — neither the tab nor a
    // sign-up pitch for a feature they cannot have yet.
    it.each([
      ["guest", guest],
      ["member", signedIn],
    ])("shows a flagged-out %s neither preview nor tab", (_who, as) => {
      mockFlags.sandboxesEnabled = false;
      as();

      renderRoute(<Route />);

      expect(
        screen.queryByTestId(`gated-feature-${feature}`),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(tabText)).not.toBeInTheDocument();
      expect(tabMock).not.toHaveBeenCalled();
    });

    it("holds while the flag is hydrating, even for a guest", () => {
      mockFlags.sandboxesEnabled = undefined;
      guest();

      renderRoute(<Route />);

      expect(
        screen.queryByTestId(`gated-feature-${feature}`),
      ).not.toBeInTheDocument();
      expect(tabMock).not.toHaveBeenCalled();
    });

    it("shows a guest the preview instead of the real tab", () => {
      guest();

      renderRoute(<Route />);

      expect(screen.getByTestId(`gated-feature-${feature}`)).toBeInTheDocument();
      expect(screen.queryByText(tabText)).not.toBeInTheDocument();
      // The tab must not merely be hidden — mounting it would fire the
      // member-only queries this gate exists to prevent.
      expect(tabMock).not.toHaveBeenCalled();
    });

    it("offers a guest the feature creation CTA", () => {
      guest();

      renderRoute(<Route />);

      expect(
        screen.getByRole("button", { name: GATED_FEATURE_COPY[feature].ctaLabel }),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("billing-upsell-gate"),
      ).not.toBeInTheDocument();
    });

    // Convex `isAuthenticated` is TRUE for anonymous guest sessions. Gating on
    // it instead of WorkOS identity is the bug this asserts against.
    it("treats an anonymous Convex session as a guest, despite isAuthenticated", () => {
      guest();
      mockRouteContext.isAuthenticated = true;

      renderRoute(<Route />);

      expect(screen.getByTestId(`gated-feature-${feature}`)).toBeInTheDocument();
      expect(tabMock).not.toHaveBeenCalled();
    });

    it("holds — showing neither preview nor tab — while identity is resolving", () => {
      mockUseIsMemberActor.mockReturnValue(undefined);
      mockUseAuth.mockReturnValue({
        user: null,
        isLoading: true,
        signIn: vi.fn(),
        signUp: vi.fn(),
      });

      renderRoute(<Route />);

      // Deciding early would flash a sign-up wall at a paying customer on
      // every cold load.
      expect(screen.queryByTestId(`gated-feature-${feature}`)).not.toBeInTheDocument();
      expect(screen.queryByText(tabText)).not.toBeInTheDocument();
      expect(tabMock).not.toHaveBeenCalled();
    });

    it("gives a signed-in member the real tab, with no sample", () => {
      renderRoute(<Route />);

      expect(screen.getByText(tabText)).toBeInTheDocument();
      expect(screen.queryByTestId(`gated-feature-${feature}`)).not.toBeInTheDocument();
      expect(
        screen.queryByTestId("gated-feature-sample"),
      ).not.toBeInTheDocument();
    });

    // Swarms and User Testing are on every plan and bounded by credits, so
    // entitlement never decides what this route shows. A locked flag on the
    // shell context must not resurrect an upsell here.
    it("ignores billing entirely, even when the shell reports the tab locked", () => {
      guest();
      mockRouteContext.activeTabBillingLocked = true;

      renderRoute(<Route />);

      expect(
        screen.getByRole("button", { name: GATED_FEATURE_COPY[feature].ctaLabel }),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("billing-upsell-gate"),
      ).not.toBeInTheDocument();
    });

    it("gives a signed-in member the real tab even when billing says locked", () => {
      mockRouteContext.activeTabBillingLocked = true;

      renderRoute(<Route />);

      expect(screen.getByText(tabText)).toBeInTheDocument();
      expect(
        screen.queryByTestId("billing-upsell-gate"),
      ).not.toBeInTheDocument();
    });
  });

  /**
   * A pasted URL has to hit the same gate as a sidebar click.
   *
   * The earlier version of this rendered at the default `/` location and
   * called itself a deep-link test, which only re-proved the ordinary gate.
   * These mount at the real paths, including the `new` create routes, which
   * are the ones most likely to be shared around.
   */
  describe.each([
    ["/user-testing/study_8k2", ScenariosRoute, "user-testing" as const],
    ["/user-testing/new", ScenariosRoute, "user-testing" as const],
    ["/swarms/swarm_42", SwarmsRoute, "swarms" as const],
    ["/swarms/new", SwarmsRoute, "swarms" as const],
  ])("deep link %s", (path, Route, feature) => {
    it("shows a guest the preview and never mounts the tab", () => {
      guest();

      renderRoute(<Route />, path);

      expect(
        screen.getByTestId(`gated-feature-${feature}`),
      ).toBeInTheDocument();
      expect(mockSwarmsTab).not.toHaveBeenCalled();
      expect(mockUserTestingTab).not.toHaveBeenCalled();
    });
  });

  /**
   * The preview must not issue member-only queries. Convex `isAuthenticated`
   * is true for an anonymous guest, so passing it straight through fired
   * `projects:getProjectMembers` for a visitor who cannot read the answer and
   * never mounts the tab.
   */
  describe("member-only queries on the preview", () => {
    it("does not ask for the members list for a guest", () => {
      guest();

      renderRoute(<SwarmsRoute />);

      expect(mockUseViewerProjectRole).toHaveBeenCalledWith(
        expect.objectContaining({ isAuthenticated: false }),
      );
    });

    it("still asks for it for a signed-in member", () => {
      renderRoute(<SwarmsRoute />);

      expect(mockUseViewerProjectRole).toHaveBeenCalledWith(
        expect.objectContaining({ isAuthenticated: true }),
      );
    });
  });
});
