/**
 * The section is the only place a person opts their chat into a page's tools,
 * so its branches decide whether a model gets them at all.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WebmcpPageToolsSection } from "../WebmcpPageToolsSection";
import { useWebmcpInspectorStore } from "@/stores/webmcp-inspector-store";
import type {
  WebMcpSessionPublic,
  WebMcpToolDescriptor,
} from "@/shared/webmcp-inspector-protocol";

const navigate = vi.fn();
let flagOn = true;

vi.mock("@/hooks/useWebmcpInspectorEnabled", () => ({
  useWebmcpInspectorEnabled: () => flagOn,
}));

vi.mock("@/lib/app-navigation", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAppNavigate: () => navigate,
  useCurrentPathname: () => "/playground",
}));

const SESSION: WebMcpSessionPublic = {
  sessionId: "session-1",
  status: "ready",
  url: "https://shop.test/",
  createdAt: 1,
  expiresAt: 2,
  hardExpiresAt: 3,
  viewportTransport: { kind: "native-window" },
  protocolVersion: 1,
};

const TOOL: WebMcpToolDescriptor = {
  toolKey: "https://shop.test::add_to_cart",
  name: "add_to_cart",
  origin: "https://shop.test",
  fromSubframe: false,
  registrationKind: "imperative",
};

function setStore(
  partial: Partial<ReturnType<typeof useWebmcpInspectorStore.getState>>,
) {
  useWebmcpInspectorStore.setState({
    session: undefined,
    tools: [],
    chatEnabled: false,
    ...partial,
  });
}

describe("WebmcpPageToolsSection", () => {
  beforeEach(() => {
    flagOn = true;
    navigate.mockClear();
    setStore({});
  });

  it("renders nothing while the feature is off", () => {
    flagOn = false;
    const { container } = render(<WebmcpPageToolsSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("offers a way to open a page when none is running", () => {
    render(<WebmcpPageToolsSection />);
    fireEvent.click(
      screen.getByRole("button", { name: /open one in webmcp/i }),
    );
    expect(navigate).toHaveBeenCalled();
  });

  it("says so when a live page has registered nothing yet", () => {
    setStore({ session: SESSION });
    render(<WebmcpPageToolsSection />);
    expect(screen.getByText(/no tools registered yet/i)).toBeInTheDocument();
  });

  it("counts the tools and states that every call asks first", () => {
    setStore({ session: SESSION, tools: [TOOL] });
    render(<WebmcpPageToolsSection />);
    // The approval promise is part of the offer: opting in must not read as
    // handing a third-party page unattended access.
    expect(
      screen.getByText(/1 tool — every call asks first/i),
    ).toBeInTheDocument();
  });

  it("opts the chat in and out through the store", () => {
    setStore({ session: SESSION, tools: [TOOL] });
    render(<WebmcpPageToolsSection />);
    const checkbox = screen.getByRole("checkbox");

    fireEvent.click(checkbox);
    expect(useWebmcpInspectorStore.getState().chatEnabled).toBe(true);
    fireEvent.click(checkbox);
    expect(useWebmcpInspectorStore.getState().chatEnabled).toBe(false);
  });

  it("treats a closed session as no page, even with tools still listed", () => {
    // A "closed" status arrives as an ordinary event and leaves the last tool
    // snapshot and the opt-in untouched; neither may keep advertising a browser
    // that is gone.
    setStore({
      session: { ...SESSION, status: "closed" },
      tools: [TOOL],
      chatEnabled: true,
    });
    render(<WebmcpPageToolsSection />);

    expect(screen.getByText(/no page open/i)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(useWebmcpInspectorStore.getState().pageToolsLive()).toBe(false);
  });
});
