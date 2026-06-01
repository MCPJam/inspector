import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { ClientsTab } from "@/components/ClientsTab";

// ClientsTab only consumes `useNavigate`; stubbing it dodges the workspace
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

vi.mock("@/components/clients/ClientBuilderView", () => ({
  ClientBuilderView: () => <div data-testid="mock-host-builder" />,
}));

// framer-motion's `motion.div` + `AnimatePresence` rely on browser primitives
// jsdom doesn't fully expose; stub both to the bare DOM so the chrome assertion
// can run without spinning up the animation runtime.
vi.mock("framer-motion", () => {
  const MotionDiv = React.forwardRef<
    HTMLDivElement,
    React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>
  >(function MotionDiv(props, ref) {
    const {
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...rest
    } = props;
    return <div ref={ref} {...rest} />;
  });
  return {
    motion: { div: MotionDiv },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
    LayoutGroup: ({ children }: { children: React.ReactNode }) => (
      <>{children}</>
    ),
  };
});

describe("ClientsTab", () => {
  it("matches the redesigned host builder top chrome spacing and divider", () => {
    render(
      <ClientsTab
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
