import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUserTestingTab, mockRouteContext, flagState } = vi.hoisted(() => ({
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
  // Tri-state, like the real PostHog hook: undefined while flags hydrate.
  flagState: { sandboxesEnabled: true as boolean | undefined },
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useOutletContext: () => mockRouteContext,
  };
});

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

vi.mock("@/hooks/useSandboxesEnabled", () => ({
  useSandboxesEnabled: () => flagState.sandboxesEnabled === true,
  useSandboxesEnabledState: () => flagState.sandboxesEnabled,
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
    flagState.sandboxesEnabled = true;
  });

  it("shows the billing upsell gate when the active tab is locked", () => {
    mockRouteContext.activeTabBillingLocked = true;
    mockRouteContext.shellBillingStatus = {
      plan: "team",
      effectivePlan: "team",
      canManageBilling: true,
    };
    mockRouteContext.upgradePlanForActiveTab = "enterprise";

    render(<ScenariosRoute />);

    expect(screen.getByTestId("billing-upsell-gate")).toHaveTextContent(
      "scenarios",
    );
    expect(screen.queryByText("User Testing Tab")).not.toBeInTheDocument();
    expect(mockUserTestingTab).not.toHaveBeenCalled();
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

  // The sidebar filters this item on the flag, but a filtered nav item is not
  // a gate: without the route check a flagged-out user could reach the whole
  // surface by typing the URL.
  it("redirects a flagged-out user away from the surface", () => {
    flagState.sandboxesEnabled = false;

    render(
      <MemoryRouter initialEntries={["/user-testing"]}>
        <ScenariosRoute />
      </MemoryRouter>,
    );

    expect(mockUserTestingTab).not.toHaveBeenCalled();
    expect(screen.queryByText("User Testing Tab")).not.toBeInTheDocument();
  });

  // Bouncing on `undefined` would strand a flagged-IN user who cold-loads the
  // URL before PostHog resolves, so the route renders nothing and waits.
  it("waits, rather than redirecting, while the flag is still hydrating", () => {
    flagState.sandboxesEnabled = undefined;

    const { container } = render(<ScenariosRoute />);

    expect(container).toBeEmptyDOMElement();
    expect(mockUserTestingTab).not.toHaveBeenCalled();
  });
});
