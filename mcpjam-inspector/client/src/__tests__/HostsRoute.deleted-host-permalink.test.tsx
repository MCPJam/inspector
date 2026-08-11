import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routePaths } from "../lib/app-navigation";

/**
 * Client URLs are permalinks, so a bookmark or history entry for
 * `/hosts/:hostId` outlives the client itself. Opening one after the client is
 * deleted (or from a project this session isn't in) used to put the route and
 * `HostsTab` in a fight over the same id: the route synced it out of the URL
 * into the previewed-host store, `HostsTab` reconciled it against the loaded
 * host list and cleared it, and the route synced it straight back. The
 * corrective `navigate('/hosts')` is a React Router transition, so the stream
 * of higher-priority state updates starved it — a pegged CPU core, or
 * "Maximum update depth exceeded" when the updates chained synchronously
 * (Sentry INSPECTOR-CLIENT-224).
 *
 * The route now resolves a dead id to null BEFORE syncing or persisting it,
 * and bounces once to the client list.
 */
const LIVE_HOST_ID = "kd7n2m5xq9b3tv6yz1r4s0hc";
const DEAD_HOST_ID = "w972jy2ak59yymb7s8f12kmgvs8c6xnr";

const {
  mockRouteContext,
  mockNavigate,
  mockParams,
  mockHostList,
  mockPreviewed,
  mockSetPreviewedHostId,
  mockToastError,
} = vi.hoisted(() => ({
  mockRouteContext: {
    convexProjectId: "project-1" as string | null,
    hostsTabSelectedHostId: null as string | null,
    isAuthenticated: true,
    setHostsTabSelectedHostId: vi.fn(),
  },
  mockNavigate: vi.fn(),
  mockParams: { hostId: undefined as string | undefined },
  mockHostList: {
    hosts: [] as Array<{ hostId: string }>,
    isLoading: false,
  },
  mockPreviewed: { value: null as string | null },
  mockSetPreviewedHostId: vi.fn(),
  mockToastError: vi.fn(),
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useOutletContext: () => mockRouteContext,
    useParams: () => mockParams,
  };
});

// Renders what the canvas is actually handed, so a dead id can't reach it
// unnoticed.
vi.mock("../components/HostsTab", () => ({
  HostsTab: ({ selectedHostId }: { selectedHostId: string | null }) => (
    <div data-testid="hosts-tab" data-selected-host-id={selectedHostId ?? ""} />
  ),
}));

vi.mock("../hooks/useClients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useClients")>();
  return {
    ...actual,
    useHostList: () => mockHostList,
    useHostMutations: () => ({
      createHost: vi.fn(),
      updateHostServers: vi.fn(),
      deleteHost: vi.fn(),
      duplicateHost: vi.fn(),
    }),
  };
});

vi.mock("../hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => [mockPreviewed.value, mockSetPreviewedHostId],
}));

vi.mock("../lib/app-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/app-navigation")>();
  return { ...actual, useAppNavigate: () => mockNavigate };
});

vi.mock("../lib/toast", () => ({
  toast: { error: mockToastError, success: vi.fn(), message: vi.fn() },
}));

// The template deep-link hook inside the route reads the theme.
vi.mock("../stores/preferences/preferences-provider", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../stores/preferences/preferences-provider")
  >();
  return { ...actual, usePreferencesStore: () => "dark" };
});

// App.tsx's import graph pulls in the CodeMirror JSON editor; stub it (and the
// CodeMirror packages it imports) so the route module loads under jsdom. Mirror
// of SkillsRoute.flag-hydration.test.tsx.
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

import { HostsRoute } from "../App";

beforeEach(() => {
  mockRouteContext.convexProjectId = "project-1";
  mockRouteContext.hostsTabSelectedHostId = null;
  mockRouteContext.isAuthenticated = true;
  mockParams.hostId = undefined;
  mockHostList.hosts = [{ hostId: LIVE_HOST_ID }];
  mockHostList.isLoading = false;
  mockPreviewed.value = null;
  window.history.replaceState({}, "", routePaths.hosts);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("HostsRoute — deleted-client permalink", () => {
  it("bounces a deleted client's permalink to the client list, once", async () => {
    mockParams.hostId = DEAD_HOST_ID;
    window.history.replaceState({}, "", `${routePaths.hosts}/${DEAD_HOST_ID}`);

    const { rerender } = render(<HostsRoute />);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(routePaths.hosts, {
        replace: true,
      });
    });
    // `replace`, so Back doesn't point at the dead URL and re-trigger this.
    expect(mockToastError).toHaveBeenCalledTimes(1);

    // Re-renders while the URL still carries the dead id must not re-fire it.
    rerender(<HostsRoute />);
    rerender(<HostsRoute />);
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  it("never syncs or persists a deleted client's id", () => {
    mockParams.hostId = DEAD_HOST_ID;
    window.history.replaceState({}, "", `${routePaths.hosts}/${DEAD_HOST_ID}`);

    // Effects flush inside render's `act`, so the sync effect has already had
    // its chance by the time these assert — no waiting, and a failure lands on
    // the write itself rather than on a timed-out precondition.
    render(<HostsRoute />);

    // The loop's fuel: writing the dead id back into the previewed-host store
    // (which outlives the URL) after HostsTab has cleared it.
    expect(mockSetPreviewedHostId).not.toHaveBeenCalledWith(DEAD_HOST_ID);
    expect(mockRouteContext.setHostsTabSelectedHostId).not.toHaveBeenCalledWith(
      DEAD_HOST_ID
    );
    expect(
      screen.getByTestId("hosts-tab").getAttribute("data-selected-host-id")
    ).toBe("");
  });

  it("waits for the host list before calling an id dead", () => {
    // The regression this guards: bouncing during the load window would break
    // every deep link, since the list is always empty for a beat.
    mockParams.hostId = LIVE_HOST_ID;
    mockHostList.hosts = [];
    mockHostList.isLoading = true;
    window.history.replaceState({}, "", `${routePaths.hosts}/${LIVE_HOST_ID}`);

    render(<HostsRoute />);

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it("opens a live client's permalink normally", async () => {
    mockParams.hostId = LIVE_HOST_ID;
    window.history.replaceState({}, "", `${routePaths.hosts}/${LIVE_HOST_ID}`);

    render(<HostsRoute />);

    await waitFor(() => {
      expect(mockSetPreviewedHostId).toHaveBeenCalledWith(LIVE_HOST_ID);
    });
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("hosts-tab").getAttribute("data-selected-host-id")
    ).toBe(LIVE_HOST_ID);
  });
});
