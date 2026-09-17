import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUserTestingTab, mockRouteContext } = vi.hoisted(() => ({
  mockUserTestingTab: vi.fn(() => <div>User Testing Tab</div>),
  mockRouteContext: {
    billingUiEnabled: true,
    activeTabBillingLocked: false,
    activeTabBillingFeature: "scenarios" as string | null,
    convexProjectId: "project-1" as string | null,
    isAuthenticated: true,
    shellBillingStatus: {
      plan: "team",
      effectivePlan: "team",
      canManageBilling: true,
    },
    upgradePlanForActiveTab: null as string | null,
    billingOrganizationId: "org-1",
    navigateToTarget: vi.fn(),
  },
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useOutletContext: () => mockRouteContext,
  };
});

// The route reads WorkOS identity now (REEV-6's gated preview asks "does this
// person have an account?"). A resolved, signed-in user keeps every assertion
// below about the FLAG and BILLING gates — the guest path has its own suite in
// `GatedFeatureRoutes.preview.test.tsx`.
// The preview gate reads the identity Convex holds, not WorkOS. Signed-in by
// default here: this suite is about the billing path, not the sign-in one.
vi.mock("@/hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => true,
}));
// Flag on: this suite is about billing. The flag gate is covered in
// `GatedFeatureRoutes.preview.test.tsx` and `SwarmsRoute.guest-gate.test.tsx`.
vi.mock("@/hooks/useSandboxesEnabled", () => ({
  useSandboxesEnabled: () => true,
  useSandboxesEnabledState: () => true,
}));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: { email: "member@example.com" }, isLoading: false }),
}));

vi.mock("../components/ui/json-editor/codemirror-json-editor", () => ({
  CodemirrorJsonEditor: () => null,
}));

vi.mock("@codemirror/lang-json", () => ({
  json: () => ({}),
}));

vi.mock("@codemirror/view", () => ({
  EditorView: class {},
  lineNumbers: () => ({}),
  highlightActiveLine: () => ({}),
  highlightSpecialChars: () => ({}),
  keymap: () => ({}),
}));

vi.mock("@codemirror/state", () => ({
  EditorState: { create: vi.fn() },
}));

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

vi.mock("../components/UserTestingTab", () => ({
  UserTestingTab: (props: unknown) => mockUserTestingTab(props),
}));

vi.mock("../components/billing/BillingUpsellGate", () => ({
  BillingUpsellGate: ({ feature }: { feature: string }) => (
    <div data-testid="billing-upsell-gate">{feature}</div>
  ),
}));

import { MemoryRouter } from "react-router";
import { ScenariosRoute } from "../App";

describe("ScenariosRoute gates", () => {
  beforeEach(() => {
    mockUserTestingTab.mockClear();
    mockRouteContext.billingUiEnabled = true;
    mockRouteContext.activeTabBillingLocked = false;
    mockRouteContext.activeTabBillingFeature = "scenarios";
    mockRouteContext.convexProjectId = "project-1";
    mockRouteContext.isAuthenticated = true;
    mockRouteContext.shellBillingStatus = {
      plan: "team",
      effectivePlan: "team",
      canManageBilling: true,
    };
    mockRouteContext.upgradePlanForActiveTab = null;
  });

  /**
   * REVERSED by REEV-6, and deliberately.
   *
   * User Testing no longer has a billing gate. Both it and Swarms are on every
   * plan and bounded by CREDITS rather than entitlement, so there is no
   * plan-locked reader for an upsell to address. The proof that this gate was
   * already dead: `LEGACY_FREE_FEATURES` in the backend catalog carries
   * `scenarios: true`, so even free orgs were entitled and this branch could
   * not fire in production.
   *
   * The test is kept, inverted, rather than deleted: a shell that reports the
   * tab locked must NOT resurrect an upsell here, and that is worth pinning.
   */
  it("ignores a locked billing gate and shows the tab anyway", () => {
    mockRouteContext.activeTabBillingLocked = true;
    mockRouteContext.shellBillingStatus = {
      plan: "team",
      effectivePlan: "team",
      canManageBilling: true,
    };
    mockRouteContext.upgradePlanForActiveTab = "enterprise";

    render(<ScenariosRoute />);

    expect(screen.queryByTestId("billing-upsell-gate")).not.toBeInTheDocument();
    expect(screen.getByText("User Testing Tab")).toBeInTheDocument();
    expect(mockUserTestingTab).toHaveBeenCalled();
  });

  it("renders the surface for team organizations", () => {
    render(<ScenariosRoute />);

    expect(screen.getByText("User Testing Tab")).toBeInTheDocument();
    expect(screen.queryByTestId("billing-upsell-gate")).not.toBeInTheDocument();
    expect(mockUserTestingTab).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        isAuthenticated: true,
        scenarioId: null,
      }),
    );
  });

  it("renders the surface for enterprise organizations", () => {
    mockRouteContext.shellBillingStatus = {
      plan: "enterprise",
      effectivePlan: "enterprise",
      canManageBilling: true,
    };

    render(<ScenariosRoute />);

    expect(screen.getByText("User Testing Tab")).toBeInTheDocument();
    expect(screen.queryByTestId("billing-upsell-gate")).not.toBeInTheDocument();
  });

  it("renders the surface when billing UI is disabled", () => {
    mockRouteContext.billingUiEnabled = false;
    mockRouteContext.activeTabBillingLocked = true;

    render(<ScenariosRoute />);

    expect(screen.getByText("User Testing Tab")).toBeInTheDocument();
    expect(screen.queryByTestId("billing-upsell-gate")).not.toBeInTheDocument();
  });

});
