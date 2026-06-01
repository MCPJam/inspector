import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockChatboxesTab, mockRouteContext } = vi.hoisted(() => ({
  mockChatboxesTab: vi.fn(() => <div>Chatboxes Tab</div>),
  mockRouteContext: {
    billingUiEnabled: true,
    activeTabBillingLocked: false,
    activeTabBillingFeature: "chatboxes" as string | null,
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

vi.mock("../components/ChatboxesTab", () => ({
  ChatboxesTab: (props: unknown) => mockChatboxesTab(props),
}));

vi.mock("../components/billing/BillingUpsellGate", () => ({
  BillingUpsellGate: ({ feature }: { feature: string }) => (
    <div data-testid="billing-upsell-gate">{feature}</div>
  ),
}));

import { ChatboxesRoute } from "../App";

describe("ChatboxesRoute billing gate", () => {
  beforeEach(() => {
    mockChatboxesTab.mockClear();
    mockRouteContext.billingUiEnabled = true;
    mockRouteContext.activeTabBillingLocked = false;
    mockRouteContext.activeTabBillingFeature = "chatboxes";
    mockRouteContext.convexProjectId = "project-1";
    mockRouteContext.isAuthenticated = true;
    mockRouteContext.shellBillingStatus = {
      plan: "team",
      effectivePlan: "team",
      canManageBilling: true,
    };
    mockRouteContext.upgradePlanForActiveTab = null;
  });

  it("shows the billing upsell gate for free organizations", () => {
    mockRouteContext.activeTabBillingLocked = true;
    mockRouteContext.shellBillingStatus = {
      plan: "free",
      effectivePlan: "free",
      canManageBilling: true,
    };
    mockRouteContext.upgradePlanForActiveTab = "team";

    render(<ChatboxesRoute />);

    expect(screen.getByTestId("billing-upsell-gate")).toHaveTextContent(
      "chatboxes",
    );
    expect(screen.queryByText("Chatboxes Tab")).not.toBeInTheDocument();
    expect(mockChatboxesTab).not.toHaveBeenCalled();
  });

  it("renders ChatboxesTab for team organizations", () => {
    render(<ChatboxesRoute />);

    expect(screen.getByText("Chatboxes Tab")).toBeInTheDocument();
    expect(screen.queryByTestId("billing-upsell-gate")).not.toBeInTheDocument();
    expect(mockChatboxesTab).toHaveBeenCalledWith({
      projectId: "project-1",
      isAuthenticated: true,
    });
  });

  it("renders ChatboxesTab for enterprise organizations", () => {
    mockRouteContext.shellBillingStatus = {
      plan: "enterprise",
      effectivePlan: "enterprise",
      canManageBilling: true,
    };

    render(<ChatboxesRoute />);

    expect(screen.getByText("Chatboxes Tab")).toBeInTheDocument();
    expect(screen.queryByTestId("billing-upsell-gate")).not.toBeInTheDocument();
    expect(mockChatboxesTab).toHaveBeenCalledWith({
      projectId: "project-1",
      isAuthenticated: true,
    });
  });

  it("renders ChatboxesTab when billing UI is disabled", () => {
    mockRouteContext.billingUiEnabled = false;
    mockRouteContext.activeTabBillingLocked = true;

    render(<ChatboxesRoute />);

    expect(screen.getByText("Chatboxes Tab")).toBeInTheDocument();
    expect(screen.queryByTestId("billing-upsell-gate")).not.toBeInTheDocument();
  });
});
