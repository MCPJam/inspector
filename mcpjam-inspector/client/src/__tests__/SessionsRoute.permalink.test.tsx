import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRouteReactContext } from "../lib/app-route-context";
import { routePaths, useCurrentSearchParam } from "../lib/app-navigation";

/**
 * The rollout flag must not eat a session permalink.
 *
 * Every `/v1/sessions` item carries `/sessions?session=<id>&project=<id>` as
 * its link, and this feed is the ONLY screen that can open one. A viewer
 * outside the `unified-sessions-enabled` cohort followed such a link and
 * landed on `/p/<projectId>/servers`: the normalizer had done its job
 * (`?project=` → path, `?session=` preserved) and then the route guard bounced
 * the whole thing, dropping the id with no message. The flag gates DISCOVERY —
 * the sidebar item, a bare `/sessions` visit — not a link somebody was handed.
 *
 * Shape mirrors `EvaluateRoute.flag-hydration.test.tsx`.
 */

// Controls the tri-state PostHog flag the route guard reads.
let flagState: boolean | undefined = undefined;

// Convex-shaped ([a-z0-9]{16,64}): `parseProjectPath` rejects anything else,
// so a placeholder like "project-1" would make the scoped-redirect assertion
// pass for the wrong reason.
const PROJECT_ID = "v977phvmg9dtt6exdykq890rjs8awe54";
const SESSION_ID = "qh75b50ftsbdat1mmsgjvtep8n8d9ysj";

vi.mock("../hooks/useUnifiedSessionsEnabled", () => ({
  UNIFIED_SESSIONS_FEATURE_FLAG: "unified-sessions-enabled",
  useUnifiedSessionsEnabledState: () => flagState,
  useUnifiedSessionsEnabled: () => flagState === true,
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    // Sentinel so a redirect is observable without a real router.
    Navigate: ({ to }: { to: string }) => (
      <div data-testid="navigate" data-to={to} />
    ),
  };
});

// The panel itself subscribes to Convex. Stub it, but read the selection out
// of the URL exactly as the real one does (`useCurrentSearchParam("session")`,
// see `SessionsPanel`), so these assertions cover the id actually arriving.
vi.mock("../components/sessions/SessionsPanel", () => ({
  SessionsPanel: ({ projectId }: { projectId: string }) => (
    <div
      data-testid="sessions-panel"
      data-project-id={projectId}
      data-selected-session={useCurrentSearchParam("session") ?? ""}
    />
  ),
}));

// App.tsx's import graph pulls in the CodeMirror JSON editor; stub it (and the
// CodeMirror packages it imports) so the route module loads under jsdom.
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

import { SessionsRoute } from "../App";

afterEach(() => {
  flagState = undefined;
  vi.clearAllMocks();
});

/**
 * The redirect goes through `ScopedNavigate`, which reads the current location
 * to carry the project into a project-owned target — so it needs a router
 * context. The route also reads `?session=` from that same location.
 */
function renderRoute(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <AppRouteReactContext.Provider value={{ convexProjectId: PROJECT_ID }}>
        <SessionsRoute />
      </AppRouteReactContext.Provider>
    </MemoryRouter>
  );
}

describe("SessionsRoute — a session permalink outruns the rollout flag", () => {
  it("opens the permalinked session even when the flag is off", () => {
    flagState = false;
    renderRoute(`/p/${PROJECT_ID}/sessions?session=${SESSION_ID}`);

    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    const panel = screen.getByTestId("sessions-panel");
    expect(panel).toHaveAttribute("data-project-id", PROJECT_ID);
    expect(panel).toHaveAttribute("data-selected-session", SESSION_ID);
  });

  it("still bounces a bare /sessions visit when the flag is off", () => {
    // The gate itself is unchanged: without an id there is nothing the link
    // was pointing at, so a flagged-out viewer has no business on the feed.
    flagState = false;
    renderRoute(`/p/${PROJECT_ID}/sessions`);

    expect(screen.getByTestId("navigate")).toHaveAttribute(
      "data-to",
      `/p/${PROJECT_ID}${routePaths.servers}`
    );
    expect(screen.queryByTestId("sessions-panel")).not.toBeInTheDocument();
  });

  it("opens the permalinked session for a flagged-in viewer", () => {
    flagState = true;
    renderRoute(`/p/${PROJECT_ID}/sessions?session=${SESSION_ID}`);

    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    expect(screen.getByTestId("sessions-panel")).toHaveAttribute(
      "data-selected-session",
      SESSION_ID
    );
  });

  it("does not redirect while the flag is still loading (undefined)", () => {
    flagState = undefined;
    renderRoute(`/p/${PROJECT_ID}/sessions`);

    expect(screen.queryByTestId("navigate")).not.toBeInTheDocument();
    expect(screen.queryByTestId("sessions-panel")).not.toBeInTheDocument();
  });
});
