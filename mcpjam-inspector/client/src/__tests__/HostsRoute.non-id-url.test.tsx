import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routePaths } from "../lib/app-navigation";

/**
 * `/hosts/:hostId` carries a Convex document id, but nothing stops a typed or
 * shared link from putting a clients-catalog slug there (`/hosts/chatgpt`,
 * whose supported deep link is `/hosts?template=chatgpt`). The route used to
 * sync that segment straight into shared state AND into the project's
 * persisted "previewed host" — so the bad id kept reaching `hosts:getHost`,
 * where it failed the `v.id("hosts")` argument validator and reached the
 * browser as an opaque `[CONVEX Q(hosts:getHost)] Server Error`.
 *
 * The backend now reads a malformed id as not-found, so this is about the other
 * half: a value that cannot resolve to a host must not be persisted as the
 * project's previewed host, where it outlives the URL that carried it.
 */
const CONVEX_HOST_ID = "m17b6q9xw2tv4kz8p3r5s0dc";

const {
  mockRouteContext,
  mockNavigate,
  mockParams,
  mockHostList,
  mockCreateHost,
  mockFeatureFlags,
  mockPreviewed,
  mockSetPreviewedHostId,
  mockSetHostsTabSelectedHostId,
} = vi.hoisted(() => ({
  mockRouteContext: {
    convexProjectId: "project-1" as string | null,
    hostsTabSelectedHostId: null as string | null,
    isAuthenticated: true,
    setHostsTabSelectedHostId: vi.fn(),
  },
  mockNavigate: vi.fn(),
  mockParams: { hostId: undefined as string | undefined },
  // The route only PERSISTS an id the project's client list confirms, so a
  // shape-valid id has to be IN the list for these cases to reach persistence
  // — an empty loaded list means "deleted", which is the other route guard's
  // subject (see `HostsRoute.deleted-host-permalink.test.tsx`).
  mockHostList: {
    hosts: [] as Array<{ hostId: string; name?: string }>,
    isLoading: false,
  },
  mockCreateHost: vi.fn(),
  // Tri-state, like PostHog: `undefined` is what every first render sees, and
  // the deep-link guard must WAIT there rather than read it as off.
  mockFeatureFlags: {
    claudeCode: undefined as boolean | undefined,
    codex: undefined as boolean | undefined,
  },
  mockPreviewed: { value: null as string | null },
  mockSetPreviewedHostId: vi.fn(),
  mockSetHostsTabSelectedHostId: vi.fn(),
}));

vi.mock("react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router")>();
  return {
    ...actual,
    useOutletContext: () => mockRouteContext,
    useParams: () => mockParams,
    Navigate: ({ to }: { to: string }) => (
      <div data-testid="navigate" data-to={to} />
    ),
  };
});

// Renders the selected id so the test can assert what the canvas is handed.
vi.mock("../components/HostsTab", () => ({
  HostsTab: ({ selectedHostId }: { selectedHostId: string | null }) => (
    <div data-testid="hosts-tab" data-selected-host-id={selectedHostId ?? ""} />
  ),
}));

vi.mock("../hooks/use-previewed-client-id", () => ({
  usePreviewedHostId: () => [mockPreviewed.value, mockSetPreviewedHostId],
}));

// `importOriginal` on purpose: the route's shape gate IS `shouldQueryHostId`
// from this module, so stubbing the module wholesale would test a stub.
vi.mock("../hooks/useClients", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useClients")>();
  return {
    ...actual,
    useHostList: () => mockHostList,
    useHostMutations: () => ({
      createHost: mockCreateHost,
      updateHostServers: vi.fn(),
      deleteHost: vi.fn(),
      duplicateHost: vi.fn(),
    }),
  };
});

vi.mock("posthog-js/react", () => ({
  useFeatureFlagEnabled: (flag: string) =>
    flag === "claude-code-host-enabled"
      ? mockFeatureFlags.claudeCode
      : flag === "codex-host-enabled"
      ? mockFeatureFlags.codex
      : false,
}));

vi.mock("../lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

vi.mock("../lib/app-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/app-navigation")>();
  return { ...actual, useAppNavigate: () => mockNavigate };
});

// The template deep-link hook inside the route reads Convex + preferences.
vi.mock("convex/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("convex/react")>();
  return { ...actual, useQuery: () => undefined, useMutation: () => vi.fn() };
});

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

import { HOST_TEMPLATE_FLAG_WAIT_MS, HostsRoute } from "../App";
import { buildHostsPath } from "../lib/app-navigation";
import { toast } from "../lib/toast";

beforeEach(() => {
  mockRouteContext.convexProjectId = "project-1";
  mockRouteContext.hostsTabSelectedHostId = null;
  mockRouteContext.isAuthenticated = true;
  mockRouteContext.setHostsTabSelectedHostId = mockSetHostsTabSelectedHostId;
  mockPreviewed.value = null;
  mockParams.hostId = undefined;
  window.history.replaceState({}, "", routePaths.hosts);
  // Loaded, and the id this suite opens is a live client of the project.
  mockHostList.hosts = [{ hostId: CONVEX_HOST_ID }];
  mockHostList.isLoading = false;
  mockCreateHost.mockReset();
  mockFeatureFlags.claudeCode = undefined;
  mockFeatureFlags.codex = undefined;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("HostsRoute — a URL segment that is not a Convex host id", () => {
  it("does not create a gated host from a direct verify URL", async () => {
    mockHostList.hosts = [];
    mockFeatureFlags.codex = false;
    window.history.replaceState({}, "", `${routePaths.hosts}?template=codex`);

    render(<HostsRoute />);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(routePaths.hosts, {
        replace: true,
      });
    });
    expect(mockCreateHost).not.toHaveBeenCalled();
    // The bounce lands on a list that looks unchanged, so the toast is the only
    // thing telling the user why their link did nothing.
    expect(toast.error).toHaveBeenCalledWith("Codex is not available yet.");
  });

  it("opens a gated host the account already has", async () => {
    mockHostList.hosts = [{ hostId: CONVEX_HOST_ID, name: "Codex" }];
    window.history.replaceState({}, "", `${routePaths.hosts}?template=codex`);

    render(<HostsRoute />);

    // Reuse is matched by name and runs ahead of the rollout gate — an account
    // that already has the host keeps reaching it, flag or no flag.
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(buildHostsPath(CONVEX_HOST_ID), {
        replace: true,
      });
    });
    expect(mockCreateHost).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not create again after a failed create", async () => {
    mockHostList.hosts = [];
    mockFeatureFlags.codex = true;
    mockCreateHost.mockRejectedValue(new Error("host limit reached"));
    window.history.replaceState({}, "", `${routePaths.hosts}?template=codex`);

    const { rerender } = render(<HostsRoute />);

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("host limit reached")
    );
    // A later render (the other flag settling, a host-list update) must not
    // retry a create that may have committed before it failed.
    mockFeatureFlags.claudeCode = false;
    rerender(<HostsRoute />);
    await waitFor(() => expect(mockCreateHost).toHaveBeenCalledTimes(1));
  });

  it("waits for an unresolved flag instead of bouncing the verify URL", async () => {
    mockHostList.hosts = [];
    window.history.replaceState({}, "", `${routePaths.hosts}?template=codex`);

    render(<HostsRoute />);

    // The whole point of the tri-state: a user who IS in the rollout must not
    // be bounced during the cold load, before their flag arrives.
    await Promise.resolve();
    expect(mockNavigate).not.toHaveBeenCalledWith(routePaths.hosts, {
      replace: true,
    });
    expect(mockCreateHost).not.toHaveBeenCalled();
  });

  it("stops waiting for a flag that never resolves", async () => {
    vi.useFakeTimers();
    try {
      mockHostList.hosts = [];
      window.history.replaceState({}, "", `${routePaths.hosts}?template=codex`);

      render(<HostsRoute />);
      expect(mockNavigate).not.toHaveBeenCalledWith(routePaths.hosts, {
        replace: true,
      });

      // A blocked PostHog relay leaves the flag `undefined` forever. Up to the
      // deadline the link must keep waiting — a shorter wait would bounce the
      // rollout cohort mid-load, which is what the tri-state exists to prevent.
      await act(async () => {
        vi.advanceTimersByTime(HOST_TEMPLATE_FLAG_WAIT_MS - 1);
      });
      expect(mockNavigate).not.toHaveBeenCalledWith(routePaths.hosts, {
        replace: true,
      });

      // Past it, the link must fail visibly rather than sit there doing nothing.
      await act(async () => {
        vi.advanceTimersByTime(1);
      });

      expect(mockNavigate).toHaveBeenCalledWith(routePaths.hosts, {
        replace: true,
      });
      expect(mockCreateHost).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("abandons the link when the URL switches templates mid-wait", async () => {
    mockHostList.hosts = [];
    window.history.replaceState({}, "", `${routePaths.hosts}?template=codex`);

    const { rerender } = render(<HostsRoute />);

    // The captured id is read once at mount, so a URL that now asks for a
    // different template (or none at all) must abandon the link rather than
    // resolve it to the host the user is no longer asking for.
    window.history.replaceState({}, "", `${routePaths.hosts}?template=claude`);
    mockFeatureFlags.codex = true;
    rerender(<HostsRoute />);

    await act(async () => {});
    expect(mockCreateHost).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalledWith(routePaths.hosts, {
      replace: true,
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("abandons the link when the template param is emptied mid-wait", async () => {
    mockHostList.hosts = [];
    window.history.replaceState({}, "", `${routePaths.hosts}?template=codex`);

    const { rerender } = render(<HostsRoute />);

    window.history.replaceState({}, "", `${routePaths.hosts}?template=`);
    mockFeatureFlags.codex = false;
    rerender(<HostsRoute />);

    await act(async () => {});
    expect(mockCreateHost).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalledWith(routePaths.hosts, {
      replace: true,
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("creates the host exactly once when the flag resolves to on", async () => {
    mockHostList.hosts = [];
    mockCreateHost.mockResolvedValue({ hostId: CONVEX_HOST_ID });
    window.history.replaceState({}, "", `${routePaths.hosts}?template=codex`);

    const { rerender } = render(<HostsRoute />);
    expect(mockCreateHost).not.toHaveBeenCalled();

    mockFeatureFlags.codex = true;
    rerender(<HostsRoute />);

    await waitFor(() => expect(mockCreateHost).toHaveBeenCalledTimes(1));
    // The flag settling re-runs the effect; the latch must hold across it.
    rerender(<HostsRoute />);
    await waitFor(() => expect(mockCreateHost).toHaveBeenCalledTimes(1));
  });

  it("sends a catalog slug to the clients list instead of opening it", () => {
    mockParams.hostId = "chatgpt";

    render(<HostsRoute />);

    expect(mockNavigate).toHaveBeenCalledWith(routePaths.hosts, {
      replace: true,
    });
  });

  it("never persists the slug as the project's previewed host", () => {
    mockParams.hostId = "chatgpt";

    render(<HostsRoute />);

    // The persisted value is per-project and read on later visits, so writing
    // it here would keep firing the doomed query long after this URL is gone.
    expect(mockSetPreviewedHostId).not.toHaveBeenCalled();
    expect(mockSetHostsTabSelectedHostId).not.toHaveBeenCalledWith("chatgpt");
  });

  it("does not hand the slug to the host canvas", () => {
    mockParams.hostId = "chatgpt";

    render(<HostsRoute />);

    expect(screen.getByTestId("hosts-tab")).toHaveAttribute(
      "data-selected-host-id",
      "",
    );
  });

  it("still opens a real Convex host id, and persists it", () => {
    mockParams.hostId = CONVEX_HOST_ID;

    render(<HostsRoute />);

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockSetPreviewedHostId).toHaveBeenCalledWith(CONVEX_HOST_ID);
    expect(mockSetHostsTabSelectedHostId).toHaveBeenCalledWith(CONVEX_HOST_ID);
    expect(screen.getByTestId("hosts-tab")).toHaveAttribute(
      "data-selected-host-id",
      CONVEX_HOST_ID,
    );
  });

  it("hands one trimmed id to every consumer for a padded deep link", () => {
    // `%20`-padded id: real enough to resolve once trimmed, which is what makes
    // a split between consumers dangerous. `useHost` trims before querying, so
    // an untrimmed value here would sync and persist a form that `HostsTab`
    // cannot find in the host list — it would then reset the selection and
    // clear the project's previewed host.
    mockParams.hostId = `%20${CONVEX_HOST_ID}%20`;

    render(<HostsRoute />);

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockSetHostsTabSelectedHostId).toHaveBeenCalledWith(CONVEX_HOST_ID);
    expect(mockSetPreviewedHostId).toHaveBeenCalledWith(CONVEX_HOST_ID);
    expect(screen.getByTestId("hosts-tab")).toHaveAttribute(
      "data-selected-host-id",
      CONVEX_HOST_ID,
    );
  });

  it("cleans up a segment with nothing left after trimming", () => {
    mockParams.hostId = "%20";

    render(<HostsRoute />);

    expect(mockNavigate).toHaveBeenCalledWith(routePaths.hosts, {
      replace: true,
    });
    expect(mockSetPreviewedHostId).not.toHaveBeenCalled();
  });

  it("leaves the bare `/hosts` list alone", () => {
    mockParams.hostId = undefined;
    mockPreviewed.value = CONVEX_HOST_ID;

    render(<HostsRoute />);

    expect(mockNavigate).not.toHaveBeenCalled();
    // No URL segment: the previewed host still drives the canvas.
    expect(screen.getByTestId("hosts-tab")).toHaveAttribute(
      "data-selected-host-id",
      CONVEX_HOST_ID,
    );
  });
});
