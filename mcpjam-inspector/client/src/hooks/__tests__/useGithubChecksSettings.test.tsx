import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  /**
   * One stable handle per bound backend function, keyed `kind:name`.
   *
   * The map is the point. `useAction`/`useMutation` are where this hook DECLARES
   * which backend functions the settings surface may call, and that declaration
   * is a contract in its own right — the unverified `connectRepo` mutation is
   * still deployed, still callable, and the only thing keeping it out of the
   * product is that nothing here binds it. A test that only watched call
   * arguments could not see it come back.
   *
   * Stable identity also matters mechanically: the hook memoizes its callbacks
   * on these handles, so a fresh `vi.fn()` per render would churn every
   * `useCallback` and quietly defeat the memoization the component depends on.
   */
  const handles = new Map<string, ReturnType<typeof vi.fn>>();
  const requests: Array<{ kind: string; name: string; args: unknown }> = [];
  return {
    user: { value: null as { id: string } | null },
    isAuthenticated: { value: true },
    isUserReady: { value: true },
    useQuery: vi.fn(),
    reportBoundaryError: vi.fn(),
    handles,
    requests,
    handleFor(kind: "action" | "mutation", name: string) {
      const key = `${kind}:${name}`;
      const existing = handles.get(key);
      if (existing) return existing;
      const handle = vi.fn(async (args: unknown) => {
        requests.push({ kind, name, args });
        return { ok: true };
      });
      handles.set(key, handle);
      return handle;
    },
    resetConvexBindings() {
      handles.clear();
      requests.length = 0;
    },
  };
});

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ user: mocks.user.value, isLoading: false }),
}));

vi.mock("convex/react", () => ({
  useAction: (name: string) => mocks.handleFor("action", name),
  useMutation: (name: string) => mocks.handleFor("mutation", name),
  useConvexAuth: () => ({
    isAuthenticated: mocks.isAuthenticated.value,
    isLoading: false,
  }),
  useQuery: (name: unknown, args: unknown) => mocks.useQuery(name, args),
}));

vi.mock("@/contexts/db-user-ready-context", () => ({
  useDbUserReady: () => mocks.isUserReady.value,
}));

vi.mock("@/lib/error-reporting", () => ({
  reportBoundaryError: (...args: unknown[]) =>
    mocks.reportBoundaryError(...args),
}));

import { ErrorBoundary } from "@/components/ui/error-boundary";
import { ConvexError } from "convex/values";
import {
  useGithubChecksAvailability,
  useGithubChecksSettings,
} from "../useGithubChecksSettings";

function AvailabilityProbe({
  organizationId,
}: {
  organizationId: string | null | undefined;
}) {
  const availability = useGithubChecksAvailability(organizationId);
  return <div>{availability?.state ?? "unavailable"}</div>;
}

function renderProbe(organizationId: string | null | undefined = "org-1") {
  return render(
    <ErrorBoundary name="integrations_github_checks" fallback={null}>
      <AvailabilityProbe organizationId={organizationId} />
    </ErrorBoundary>
  );
}

describe("useGithubChecksAvailability", () => {
  beforeEach(() => {
    mocks.user.value = null;
    mocks.isAuthenticated.value = true;
    mocks.isUserReady.value = true;
    vi.clearAllMocks();
    mocks.useQuery.mockImplementation((_name: unknown, args: unknown) => {
      if (args !== "skip") {
        throw new Error(
          "[CONVEX Q(github/checkRepoConfigs:getGithubChecksSettingsAvailability)] Server Error"
        );
      }
      return undefined;
    });
  });

  it("does not query or report when the Convex-authenticated actor is a guest", () => {
    renderProbe();

    expect(screen.getByText("unavailable")).toBeInTheDocument();
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "github/checkRepoConfigs:getGithubChecksSettingsAvailability",
      "skip"
    );
    expect(mocks.reportBoundaryError).not.toHaveBeenCalled();
  });

  it.each([
    ["an unauthenticated session", false, true, "org-1"],
    ["an unready user", true, false, "org-1"],
    ["a null organization id", true, true, null],
    ["an empty organization id", true, true, ""],
  ] as const)(
    "skips the query and reporting for %s",
    (_state, isAuthenticated, isUserReady, organizationId) => {
      mocks.user.value = { id: "user-1" };
      mocks.isAuthenticated.value = isAuthenticated;
      mocks.isUserReady.value = isUserReady;

      renderProbe(organizationId);

      expect(screen.getByText("unavailable")).toBeInTheDocument();
      expect(mocks.useQuery).toHaveBeenCalledWith(
        "github/checkRepoConfigs:getGithubChecksSettingsAvailability",
        "skip"
      );
      expect(mocks.reportBoundaryError).not.toHaveBeenCalled();
    }
  );

  it("still asks the backend for a signed-in WorkOS user", () => {
    mocks.user.value = { id: "user-1" };
    mocks.useQuery.mockReturnValue({ state: "enabled" });

    renderProbe();

    expect(screen.getByText("enabled")).toBeInTheDocument();
    expect(mocks.useQuery).toHaveBeenCalledWith(
      "github/checkRepoConfigs:getGithubChecksSettingsAvailability",
      { organizationId: "org-1" }
    );
  });

  it("contains a signed-in membership refusal in the error boundary", () => {
    mocks.user.value = { id: "user-1" };
    const refusal = new ConvexError({
      kind: "forbidden",
      message: "Not a member of this organization",
    });
    mocks.useQuery.mockImplementation(() => {
      throw refusal;
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      const { container } = renderProbe();

      expect(container).toBeEmptyDOMElement();
      expect(mocks.useQuery).toHaveBeenCalledWith(
        "github/checkRepoConfigs:getGithubChecksSettingsAvailability",
        { organizationId: "org-1" }
      );
      expect(mocks.reportBoundaryError).toHaveBeenCalledTimes(1);
      expect(mocks.reportBoundaryError.mock.calls[0]?.[0]).toBe(refusal);
      expect(mocks.reportBoundaryError.mock.calls[0]?.[2]).toBe(
        "integrations_github_checks"
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});

/**
 * The write surface: WHICH backend functions this hook binds, and exactly what
 * it sends them.
 *
 * Both halves are load-bearing. Connecting a repository moved to a Node action
 * that proves the pinned installation can actually reach the repository before
 * it writes anything; the unverified `checkRepoConfigs:connectRepo` mutation is
 * still deployed for the two-deploy window and would work if it were bound
 * again, silently giving back a config row nobody verified. And the arguments
 * are the contract — `organizationId` is added here so no call site can forget
 * it, and `installationId` is a server-side fact the client never names.
 */
describe("useGithubChecksSettings writes", () => {
  function SettingsProbe() {
    const settings = useGithubChecksSettings("org-1");
    return (
      <div>
        <button
          type="button"
          onClick={() =>
            void settings.connectVerifiedRepo({
              repoFullName: "mcpjam/mcp-check-fixture",
              projectId: "proj-1",
              suiteId: "suite-1",
              outagePolicy: "fail_closed",
            })
          }
        >
          connect
        </button>
        <button
          type="button"
          onClick={() =>
            void settings.setRepoOutagePolicy({
              configId: "cfg-1",
              outagePolicy: "fail_open",
            })
          }
        >
          set policy
        </button>
        <div data-testid="exposed">
          {Object.keys(settings).sort().join(",")}
        </div>
      </div>
    );
  }

  beforeEach(() => {
    mocks.user.value = { id: "user-1" };
    mocks.isAuthenticated.value = true;
    mocks.isUserReady.value = true;
    mocks.resetConvexBindings();
    vi.clearAllMocks();
    mocks.useQuery.mockImplementation((name: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      if (String(name).endsWith("getGithubChecksSettingsAvailability")) {
        return { state: "enabled" };
      }
      return [];
    });
  });

  it("binds exactly the backend functions this surface is allowed to call", () => {
    render(<SettingsProbe />);

    // An exact set, not a subset: adding a binding is a deliberate act, and
    // RE-adding `github/checkRepoConfigs:connectRepo` — the unverified connect
    // this UI exists to stop using — has to fail here rather than ship.
    expect([...mocks.handles.keys()].sort()).toEqual(
      [
        "action:github/checkRepoConfigsNode:connectVerifiedRepo",
        "action:github/checkRepoConfigsNode:listInstallationRepos",
        "mutation:github/checkRepoConfigs:disconnectRepo",
        "mutation:github/checkRepoConfigs:setRepoEnabled",
        "mutation:github/checkRepoConfigs:setRepoOutagePolicy",
        "mutation:github/checkRepoConfigs:setRepoSuite",
      ].sort()
    );
    expect(
      mocks.handles.has("mutation:github/checkRepoConfigs:connectRepo")
    ).toBe(false);
  });

  it("does not expose a legacy connect callback to call sites", () => {
    render(<SettingsProbe />);

    const exposed = screen.getByTestId("exposed").textContent?.split(",") ?? [];
    expect(exposed).toContain("connectVerifiedRepo");
    expect(exposed).toContain("setRepoOutagePolicy");
    expect(exposed).not.toContain("connectRepo");
  });

  it("connects through the verified Node action with the org and the explicit policy", () => {
    render(<SettingsProbe />);

    screen.getByText("connect").click();

    expect(mocks.requests).toEqual([
      {
        kind: "action",
        name: "github/checkRepoConfigsNode:connectVerifiedRepo",
        // Exactly these five. No `installationId`: which installation can reach
        // the repository is resolved and proved server-side, and a client that
        // could name one would be a client that could pick the wrong one.
        args: {
          organizationId: "org-1",
          repoFullName: "mcpjam/mcp-check-fixture",
          projectId: "proj-1",
          suiteId: "suite-1",
          outagePolicy: "fail_closed",
        },
      },
    ]);
  });

  it("sets a repository's outage policy through the org-scoped mutation", () => {
    render(<SettingsProbe />);

    screen.getByText("set policy").click();

    expect(mocks.requests).toEqual([
      {
        kind: "mutation",
        name: "github/checkRepoConfigs:setRepoOutagePolicy",
        args: {
          organizationId: "org-1",
          configId: "cfg-1",
          outagePolicy: "fail_open",
        },
      },
    ]);
  });
});
