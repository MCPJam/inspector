import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routePaths } from "../lib/app-navigation";

// Controls the tri-state PostHog flag the route guard reads. `undefined`
// models the pre-hydration window; the regression is that the guard must NOT
// redirect during it (only on an explicit `false`).
let flagState: boolean | undefined = undefined;

const { memberActor, mockRouteContext, mockNavigate } = vi.hoisted(() => ({
  // The Convex actor the personal computer is gated on. Tri-state: `undefined`
  // is the window before `users:getCurrentUser` answers.
  memberActor: { value: true as boolean | undefined },
  mockRouteContext: {
    convexProjectId: "project-1" as string | null,
    isAuthenticated: true,
    isGuestProjectActor: false,
  },
  mockNavigate: vi.fn(),
}));

vi.mock("../hooks/use-is-member-actor", () => ({
  useIsMemberActor: () => memberActor.value,
}));

vi.mock("../hooks/useComputersEnabled", () => ({
  COMPUTERS_FEATURE_FLAG: "computers-enabled",
  useComputersEnabledState: () => flagState,
  useComputersEnabled: () => flagState === true,
  // The local-engine dark-launch flag lives in the same module and is read by
  // `useComputerEngine`, which this route renders through `ComputerTabView`.
  // This mock replaces the module wholesale, so omitting the export throws
  // rather than falling through to the real hook.
  LOCAL_COMPUTER_FEATURE_FLAG: "local-computer-enabled",
  useLocalComputerEnabled: () => false,
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useOutletContext: () => mockRouteContext,
    // Sentinel so a redirect is observable without a real router.
    Navigate: ({ to }: { to: string }) => (
      <div data-testid="navigate" data-to={to} />
    ),
  };
});

vi.mock("../components/computer/ComputerView", () => ({
  // `data-member` is the whole point of the actor assertions below: it is what
  // becomes `effectiveProjectId`, the skip argument for the member-only status
  // query.
  ComputerView: (props: { isSignedInMember: boolean | undefined }) => (
    <div
      data-testid="computer-view"
      data-member={String(props.isSignedInMember)}
    />
  ),
}));

vi.mock("../components/hosts/ConnectViewHeader", () => ({
  ConnectViewHeader: () => <div data-testid="connect-header" />,
}));

vi.mock("../hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => [null],
}));

vi.mock("../lib/app-navigation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/app-navigation")>();
  return { ...actual, useAppNavigate: () => mockNavigate };
});

// App.tsx's import graph pulls in the CodeMirror JSON editor; stub it (and the
// CodeMirror packages it imports) so the route module loads under jsdom. Mirror
// of ScenariosRoute.billing.test.tsx.
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

import { ComputerRoute } from "../App";

afterEach(() => {
  flagState = undefined;
  memberActor.value = true;
  vi.clearAllMocks();
});

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

describe("ComputerRoute — flag hydration", () => {
  it("does not redirect while the flag is still loading (undefined)", () => {
    flagState = undefined;
    renderRoute(<ComputerRoute />);
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    // Nothing renders yet either — it waits for the flag to settle.
    expect(screen.queryByTestId("computer-view")).not.toBeInTheDocument();
  });

  it("does not redirect across an undefined -> true transition", () => {
    flagState = undefined;
    const { rerender } = renderRoute(<ComputerRoute />);
    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();

    // PostHog resolves the flag to enabled.
    flagState = true;
    // Re-rendered inside the same router: dropping the wrapper here would
    // remount the route without a location, which is not what a flag
    // resolving mid-session does.
    rerender(
      <MemoryRouter>
        <ComputerRoute />
      </MemoryRouter>
    );

    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    expect(screen.getByTestId("computer-view")).toBeInTheDocument();
  });

  it("redirects to servers only on an explicit false", () => {
    flagState = false;
    renderRoute(<ComputerRoute />);
    const nav = screen.getByTestId("navigate");
    expect(nav).toBeInTheDocument();
    expect(nav).toHaveAttribute("data-to", routePaths.servers);
    expect(screen.queryByTestId("computer-view")).not.toBeInTheDocument();
  });
});

/**
 * The personal computer is gated on the identity CONVEX HOLDS, not on the
 * route context's eager boolean.
 *
 * `isGuestProjectActor` is `currentUser?.isAnonymous === true`, so for the
 * whole time that query is in flight a GUEST reads as "not a guest" and the
 * eager `isAuthenticated && !isGuestProjectActor` is `true`. That value used to
 * be handed to `ComputerTabView`, and two components down it becomes
 * `effectiveProjectId` — the skip argument for
 * `projectComputers:getComputerStatus`. So a guest asked a member-only query
 * and got the member pane while the backend refused it (CONVEX-19R).
 *
 * The route context is pinned to its worst case throughout: `isAuthenticated`
 * true and `isGuestProjectActor` false, which is exactly what a guest looks
 * like mid-flight. Only the actor tells them apart.
 */
describe("ComputerRoute — the actor behind the computer", () => {
  beforeEach(() => {
    flagState = true;
    memberActor.value = true;
    mockRouteContext.isAuthenticated = true;
    mockRouteContext.isGuestProjectActor = false;
  });

  it("passes the unresolved actor through instead of the eager boolean", () => {
    memberActor.value = undefined;
    renderRoute(<ComputerRoute />);
    expect(screen.getByTestId("computer-view").dataset.member).toBe(
      "undefined"
    );
  });

  it("passes a resolved guest through as a guest", () => {
    memberActor.value = false;
    renderRoute(<ComputerRoute />);
    expect(screen.getByTestId("computer-view").dataset.member).toBe("false");
  });

  it("passes a resolved member through as a member", () => {
    memberActor.value = true;
    renderRoute(<ComputerRoute />);
    expect(screen.getByTestId("computer-view").dataset.member).toBe("true");
  });
});
