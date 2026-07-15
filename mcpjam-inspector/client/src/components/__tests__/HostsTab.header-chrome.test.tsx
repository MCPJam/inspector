import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { HostsTab } from "@/components/HostsTab";

// HostsTab only consumes `useNavigate`; stubbing it dodges the workspace
// React-version mismatch that pulls in a duplicate React when MemoryRouter
// initializes its hooks under jsdom.
vi.mock("react-router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("@/hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: vi.fn(() => [null as string | null, vi.fn()]),
}));

vi.mock("@/hooks/useClients", () => ({
  useHost: vi.fn(() => ({ host: null, isLoading: false })),
  useHostList: vi.fn(() => ({ hosts: [], isLoading: false })),
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: vi.fn((selector: (state: any) => unknown) =>
    selector({ themeMode: "dark" }),
  ),
}));

vi.mock("@/components/hosts/HostBuilderView", () => ({
  HostBuilderView: () => <div data-testid="mock-host-builder" />,
}));

// framer-motion's `motion.div` + `AnimatePresence` rely on browser primitives
// jsdom doesn't fully expose; stub both to the bare DOM so the chrome assertion
// can run without spinning up the animation runtime.
vi.mock("framer-motion", () => {
  const makeMotion = (Tag: "div" | "span") =>
    React.forwardRef<HTMLElement, Record<string, unknown>>(function Motion(
      props,
      ref,
    ) {
      const {
        initial: _initial,
        animate: _animate,
        exit: _exit,
        transition: _transition,
        layoutId: _layoutId,
        whileHover: _whileHover,
        whileTap: _whileTap,
        ...rest
      } = props;
      return React.createElement(Tag, { ref, ...rest });
    });
  return {
    motion: { div: makeMotion("div"), span: makeMotion("span") },
    useReducedMotion: () => false,
    AnimatePresence: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    LayoutGroup: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
  };
});

describe("HostsTab", () => {
  it("matches the redesigned host builder top chrome spacing and divider", () => {
    render(
      <HostsTab
        projectId="proj-1"
        isAuthenticated
        selectedHostId={null}
        onSelectHost={vi.fn()}
        serversTabElement={<div data-testid="servers-stub" />}
      />,
    );

    const chrome = screen.getByTestId("hosts-tab-header-chrome");
    expect(chrome).toHaveClass(
      "relative",
      "shrink-0",
      "border-b",
      "border-border/40",
      "px-4",
      "py-2.5",
      "md:px-8",
    );
  });
});
