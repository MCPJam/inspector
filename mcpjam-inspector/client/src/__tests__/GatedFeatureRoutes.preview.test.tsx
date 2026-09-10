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

const { mockSwarmsTab, mockUserTestingTab, mockRouteContext, mockUseAuth } =
  vi.hoisted(() => ({
    mockSwarmsTab: vi.fn(() => <div>Swarms Tab</div>),
    mockUserTestingTab: vi.fn(() => <div>User Testing Tab</div>),
    mockUseAuth: vi.fn(() => ({
      user: { email: "member@example.com" } as { email: string } | null,
      isLoading: false,
      signIn: vi.fn(),
      signUp: vi.fn(),
    })),
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

// Flag ON throughout: this suite is about the identity gate that sits behind
// it. The flag's own redirect is covered in the two existing route suites.
vi.mock("@/hooks/useSandboxesEnabled", () => ({
  useSandboxesEnabled: () => true,
  useSandboxesEnabledState: () => true,
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
    useViewerProjectRole: () => ({ role: "member", isLoading: false }),
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

function renderRoute(element: React.ReactElement) {
  return render(<MemoryRouter>{element}</MemoryRouter>);
}

function signedIn() {
  mockUseAuth.mockReturnValue({
    user: { email: "member@example.com" },
    isLoading: false,
    signIn: vi.fn(),
    signUp: vi.fn(),
  });
}

function guest() {
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
    signedIn();
  });

  describe.each(SURFACES)("$name", ({ Route, feature, tabText, tabMock }) => {
    const copy = GATED_FEATURE_COPY[feature];

    it("shows a guest the preview instead of the real tab", () => {
      guest();

      renderRoute(<Route />);

      expect(screen.getByText(copy.heroTitle)).toBeInTheDocument();
      expect(screen.queryByText(tabText)).not.toBeInTheDocument();
      // The tab must not merely be hidden — mounting it would fire the
      // member-only queries this gate exists to prevent.
      expect(tabMock).not.toHaveBeenCalled();
    });

    it("offers a guest sign-up, not an upgrade", () => {
      guest();

      renderRoute(<Route />);

      expect(
        screen.getByRole("button", { name: "Create free account" }),
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

      expect(screen.getByText(copy.heroTitle)).toBeInTheDocument();
      expect(tabMock).not.toHaveBeenCalled();
    });

    it("holds — showing neither preview nor tab — while WorkOS is resolving", () => {
      mockUseAuth.mockReturnValue({
        user: null,
        isLoading: true,
        signIn: vi.fn(),
        signUp: vi.fn(),
      });

      renderRoute(<Route />);

      // Deciding early would flash a sign-up wall at a paying customer on
      // every cold load.
      expect(screen.queryByText(copy.heroTitle)).not.toBeInTheDocument();
      expect(screen.queryByText(tabText)).not.toBeInTheDocument();
      expect(tabMock).not.toHaveBeenCalled();
    });

    it("gives a signed-in member the real tab, with no example cards", () => {
      renderRoute(<Route />);

      expect(screen.getByText(tabText)).toBeInTheDocument();
      expect(screen.queryByText(copy.heroTitle)).not.toBeInTheDocument();
      expect(screen.queryByText(copy.cardsLabel)).not.toBeInTheDocument();
    });

    it("gives a plan-locked member the preview with the upsell, not sign-up", () => {
      mockRouteContext.activeTabBillingLocked = true;

      renderRoute(<Route />);

      // Same pitch as the guest sees...
      expect(screen.getByText(copy.heroTitle)).toBeInTheDocument();
      expect(screen.getByText(copy.cardsLabel)).toBeInTheDocument();
      // ...but they already have an account, so the way out is a plan.
      expect(screen.getByTestId("billing-upsell-gate")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Create free account" }),
      ).not.toBeInTheDocument();
      expect(tabMock).not.toHaveBeenCalled();
    });

    // A guest has no organization and no plan, so an upgrade prompt would be
    // answering a question they have not reached.
    it("prefers sign-up over the upsell when a guest is somehow also billing-locked", () => {
      guest();
      mockRouteContext.activeTabBillingLocked = true;

      renderRoute(<Route />);

      expect(
        screen.getByRole("button", { name: "Create free account" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("billing-upsell-gate"),
      ).not.toBeInTheDocument();
    });
  });

  // A pasted URL has to hit the same gate as a sidebar click; the deep-link
  // params are read after the gate, so reaching them at all would be the bug.
  it("gates a deep-linked study for a guest", () => {
    guest();

    renderRoute(<ScenariosRoute />);

    expect(
      screen.getByText(GATED_FEATURE_COPY["user-testing"].heroTitle),
    ).toBeInTheDocument();
    expect(mockUserTestingTab).not.toHaveBeenCalled();
  });
});
