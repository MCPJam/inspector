import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAvailability,
  mockRepos,
  mockSuites,
  mockSetRepoEnabled,
  mockSetRepoSuite,
  mockSetRepoOutagePolicy,
  mockSetRepoConformance,
  mockSetRepoFeedbackComments,
  mockDisconnectRepo,
  mockConnectRepo,
  mockConnectVerifiedRepo,
  mockListInstallationRepos,
  mockBindings,
  mockStartInstallation,
  mockStartDirectClaim,
  mockUnbindInstallation,
  mockRedirectToGithub,
  mockOrgsLoading,
  mockAuthLoading,
} = vi.hoisted(() => ({
  mockAvailability: {
    value: undefined as { state: "enabled" | "disabled" } | undefined,
  },
  mockRepos: { value: undefined as unknown[] | undefined },
  mockSuites: { value: [] as unknown[] },
  mockSetRepoEnabled: vi.fn(async () => ({ changed: true })),
  mockSetRepoSuite: vi.fn(async () => ({ changed: true })),
  mockSetRepoOutagePolicy: vi.fn(async () => ({ changed: true })),
  mockSetRepoConformance: vi.fn(async () => ({ changed: true })),
  mockSetRepoFeedbackComments: vi.fn(async () => ({ changed: true })),
  mockDisconnectRepo: vi.fn(async () => ({ removed: true })),
  // The unverified connect the backend still exposes for the two-deploy
  // window. It is handed to the component so that reaching for it is a
  // recorded call rather than a crash — "never called" is the assertion.
  mockConnectRepo: vi.fn(async () => ({ configId: "cfg-legacy" })),
  // Typed loosely on purpose. These stand in for Convex actions whose real
  // arguments are hand-mirrored strings, and pinning a narrow inferred shape
  // here would make every fixture that adds one optional field a type error in
  // a file whose job is to vary those fixtures.
  mockConnectVerifiedRepo: vi.fn(async (_args?: Record<string, unknown>) => ({
    configId: "cfg-new",
  })),
  mockListInstallationRepos: vi.fn(
    async (): Promise<unknown[]> => [
      {
        repositoryId: 2,
        fullName: "mcpjam/other-repo",
        installationRef: "bind-1",
        accountLogin: "mcpjam",
      },
    ]
  ),
  mockBindings: { value: undefined as unknown[] | undefined },
  mockStartInstallation: vi.fn(async () => ({
    installUrl: "https://github.com/apps/mcpjam/installations/new?state=abc",
  })),
  mockStartDirectClaim: vi.fn(async () => ({
    authorizeUrl: "https://github.com/login/oauth/authorize?client_id=x",
  })),
  mockUnbindInstallation: vi.fn(async () => ({ changed: true })),
  // `window.location.assign` is the one thing jsdom will not let a test observe
  // cleanly, so the redirect lives behind a named export and this stands in for
  // it. "Where did we send them" is the assertion.
  mockRedirectToGithub: vi.fn(),
  mockOrgsLoading: { value: false },
  mockAuthLoading: { value: false },
}));

// The availability gate is the unit under test; the data layer is stubbed.
vi.mock("@/hooks/useGithubChecksSettings", () => ({
  useGithubChecksSettings: () => ({
    availability: mockAvailability.value,
    isEnabled: mockAvailability.value?.state === "enabled",
    repos: mockRepos.value,
    suites: mockSuites.value,
    bindings: mockBindings.value,
    connectRepo: mockConnectRepo,
    connectVerifiedRepo: mockConnectVerifiedRepo,
    setRepoEnabled: mockSetRepoEnabled,
    setRepoSuite: mockSetRepoSuite,
    setRepoOutagePolicy: mockSetRepoOutagePolicy,
    setRepoConformance: mockSetRepoConformance,
    setRepoFeedbackComments: mockSetRepoFeedbackComments,
    disconnectRepo: mockDisconnectRepo,
    listInstallationRepos: mockListInstallationRepos,
    startInstallation: mockStartInstallation,
    startDirectClaim: mockStartDirectClaim,
    unbindInstallation: mockUnbindInstallation,
  }),
}));

vi.mock("@/lib/github-external-redirect", () => ({
  redirectToGithub: mockRedirectToGithub,
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({
    isAuthenticated: !mockAuthLoading.value,
    isLoading: mockAuthLoading.value,
  }),
}));

vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationQueries: () => ({ isLoading: mockOrgsLoading.value }),
}));

// The nav resolves availability itself now; it is not what this file tests.
vi.mock("../SettingsNav", () => ({
  SettingsNav: () => <nav data-testid="settings-nav" />,
}));

import { toast } from "@/lib/toast";
import { GithubChecksRoute } from "../GithubChecksRoute";

const ROW = {
  _id: "cfg-1",
  repoFullName: "mcpjam/mcp-check-fixture",
  enabled: true,
  organizationId: "org-1",
  projectId: "proj-1",
  suiteId: "suite-1",
  // Backend-DERIVED. The page never computes this, and in particular never
  // infers it from a missing visibility badge.
  connectionStatus: "verified" as const,
  createdAt: 1,
  updatedAt: 1,
};

/**
 * One entry from the installation listing.
 *
 * `repositoryId` is required and is what the picker is keyed on — two accounts
 * can each have a `widgets`, so a name is not a selector. Ids are derived from
 * the name so a fixture never has to invent one, and stay stable across a test.
 */
let nextRepositoryId = 1000;
const repositoryIds = new Map<string, number>();
function repo(
  fullName: string,
  overrides: {
    private?: boolean;
    installationRef?: string | null;
    accountLogin?: string;
  } = {}
) {
  const key = fullName.trim().toLowerCase();
  if (!repositoryIds.has(key)) repositoryIds.set(key, (nextRepositoryId += 1));
  return {
    repositoryId: repositoryIds.get(key) as number,
    fullName,
    ...(overrides.installationRef === null
      ? {}
      : { installationRef: overrides.installationRef ?? "bind-1" }),
    ...(overrides.accountLogin !== undefined
      ? { accountLogin: overrides.accountLogin }
      : { accountLogin: "mcpjam" }),
    ...(overrides.private !== undefined ? { private: overrides.private } : {}),
  };
}

/** One connected GitHub account. */
function binding(
  accountLogin: string,
  overrides: {
    installationRef?: string;
    status?: "active" | "suspended" | "removed" | "unbound";
    accountType?: "Organization" | "User";
  } = {}
) {
  return {
    installationRef: overrides.installationRef ?? `bind-${accountLogin}`,
    accountLogin,
    accountType: overrides.accountType ?? ("Organization" as const),
    status: overrides.status ?? ("active" as const),
    boundAt: 1,
    statusChangedAt: 1,
  };
}

/** A row connected before the outage policy existed: nothing was stored. */
const UNSET_POLICY_ROW = ROW;
const FAIL_OPEN_ROW = { ...ROW, outagePolicy: "fail_open" as const };

/**
 * A repository whose admin has opted OUT of comments.
 *
 * `ROW` itself is the other case and the important one: it carries no
 * `feedbackComments` at all, which is what every repository connected before
 * this existed looks like — and it means ON.
 */
const COMMENTS_OFF_ROW = { ...ROW, feedbackComments: "off" as const };

function routeTree(activeOrganizationId: string | null) {
  return (
    <MemoryRouter initialEntries={["/settings/integrations/github"]}>
      <Routes>
        <Route
          path="/settings/integrations/github"
          element={
            <GithubChecksRoute activeOrganizationId={activeOrganizationId} />
          }
        />
        <Route path="/settings" element={<div>Settings Screen</div>} />
      </Routes>
    </MemoryRouter>
  );
}

function renderRoute(activeOrganizationId: string | null = "org-1") {
  return render(routeTree(activeOrganizationId));
}

/**
 * Pick a value from one of the page's Radix selects.
 *
 * Radix renders its options in a portal that only exists while the trigger is
 * open, so both halves have to happen through the real controls — which is also
 * the only way a test sees a disabled trigger the way a user would.
 */
async function chooseOption(
  user: ReturnType<typeof userEvent.setup>,
  triggerLabel: string,
  optionName: string | RegExp
) {
  await user.click(screen.getByLabelText(triggerLabel));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

/** Repository + suite + policy, in the order the page presents them. */
async function fillConnectForm(
  user: ReturnType<typeof userEvent.setup>,
  policyLabel: "Fail open" | "Fail closed" = "Fail closed"
) {
  await chooseOption(user, "Repository", "mcpjam/other-repo");
  await chooseOption(user, "Suite", "Fixture suite");
  await chooseOption(user, "Outage policy", policyLabel);
}

const connectButton = () => screen.getByRole("button", { name: /Connect/ });

describe("GithubChecksRoute availability gate", () => {
  beforeEach(() => {
    mockAvailability.value = undefined;
    mockRepos.value = undefined;
    mockSuites.value = [
      { _id: "suite-1", name: "Fixture suite", projectId: "proj-1" },
      { _id: "suite-2", name: "Second suite", projectId: "proj-1" },
    ];
    mockOrgsLoading.value = false;
    mockAuthLoading.value = false;
    mockBindings.value = [binding("mcpjam")];
    vi.clearAllMocks();
  });

  it("renders nothing while availability is still loading", () => {
    const { container } = renderRoute();
    // Crucially NOT a redirect: bouncing on "don't know" would strand a
    // legitimately-enabled user who cold-loads this URL.
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Settings Screen")).not.toBeInTheDocument();
  });

  it("redirects to /settings when the backend says disabled", () => {
    mockAvailability.value = { state: "disabled" };
    renderRoute();
    expect(screen.getByText("Settings Screen")).toBeInTheDocument();
  });

  it("does not fetch installation repos while unavailable", () => {
    mockAvailability.value = { state: "disabled" };
    renderRoute();
    expect(mockListInstallationRepos).not.toHaveBeenCalled();
  });

  it("renders connected repositories when enabled", () => {
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = [ROW];
    renderRoute();
    expect(screen.getByText("mcpjam/mcp-check-fixture")).toBeInTheDocument();
  });

  it("shows the install-App empty state when there are no repos", () => {
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = [];
    renderRoute();
    expect(
      screen.getByText(/No repositories connected yet/)
    ).toBeInTheDocument();
    expect(screen.getByText("mcpjam.yaml")).toBeInTheDocument();
  });

  it("toggling a repository calls the mutation with the flipped value", () => {
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = [ROW];
    renderRoute();

    fireEvent.click(
      screen.getByLabelText("Enable checks for mcpjam/mcp-check-fixture")
    );

    expect(mockSetRepoEnabled).toHaveBeenCalledWith({
      configId: "cfg-1",
      enabled: false,
    });
  });

  it("the conformance switch is off by default and opt-in", () => {
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = [ROW];
    renderRoute();

    fireEvent.click(
      screen.getByLabelText(
        "Enable conformance check for mcpjam/mcp-check-fixture"
      )
    );

    expect(mockSetRepoConformance).toHaveBeenCalledWith({
      configId: "cfg-1",
      conformanceEnabled: true,
    });
  });

  it("disconnecting a repository calls the mutation", () => {
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = [ROW];
    renderRoute();

    fireEvent.click(
      screen.getByLabelText("Disconnect mcpjam/mcp-check-fixture")
    );

    expect(mockDisconnectRepo).toHaveBeenCalledWith({ configId: "cfg-1" });
  });

  it("redirects instead of hanging blank when there is genuinely no organization", () => {
    // The availability query is skipped without an org, so `undefined` here
    // never resolves — treating it as "loading" would blank the page forever.
    mockAvailability.value = undefined;
    mockOrgsLoading.value = false;
    renderRoute(null);
    expect(screen.getByText("Settings Screen")).toBeInTheDocument();
  });

  it("does NOT redirect during the organization bootstrap window", () => {
    // A deep link lands before `activeOrganizationId` resolves. Redirecting on
    // that first render would bounce a user who does have an org.
    mockAvailability.value = undefined;
    mockOrgsLoading.value = true;
    const { container } = renderRoute(null);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Settings Screen")).not.toBeInTheDocument();
  });

  it("does NOT redirect while Convex auth is still resolving", () => {
    // `useOrganizationQueries().isLoading` is `isAuthenticated && …`, so it
    // reads FALSE during auth bootstrap. Gating on it alone would bounce a
    // cold deep link before anyone knows who the user is.
    mockAvailability.value = undefined;
    mockAuthLoading.value = true;
    mockOrgsLoading.value = false;
    const { container } = renderRoute(null);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Settings Screen")).not.toBeInTheDocument();
  });

  it("ignores a second toggle while the first is still in flight", async () => {
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = [ROW];
    let release: (() => void) | undefined;
    mockSetRepoEnabled.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ changed: true });
        })
    );
    renderRoute();

    const toggle = screen.getByLabelText(
      "Enable checks for mcpjam/mcp-check-fixture"
    );
    fireEvent.click(toggle);
    fireEvent.click(toggle);

    // Both clicks read the same pre-write snapshot, so an unguarded handler
    // would send `enabled: false` twice and lose the user's second intent.
    expect(mockSetRepoEnabled).toHaveBeenCalledTimes(1);
    release?.();
  });

  it("does not blame the user when the GitHub repo fetch fails", async () => {
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = [];
    mockListInstallationRepos.mockRejectedValueOnce(new Error("network"));
    renderRoute();

    // "Install the App" would be a lie when the real problem is an outage.
    expect(
      await screen.findByText(/Could not load repositories from GitHub/)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/No repositories available/)
    ).not.toBeInTheDocument();
  });

  it("shows a loading row rather than an empty state before the list arrives", () => {
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = undefined;
    renderRoute();
    // `undefined` is "not loaded", `[]` is "genuinely none" — conflating them
    // would flash an install-the-App CTA at someone who has repos.
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(
      screen.queryByText(/No repositories connected yet/)
    ).not.toBeInTheDocument();
  });
});

/**
 * Connecting a repository is where the outage policy is DECIDED, and the
 * decision is the point: an administrator who is never asked leaves a row the
 * backend treats as fail-open without anyone having chosen that. So the policy
 * is required, unselected until picked, and described before it is picked.
 *
 * The connect itself goes to the server-VERIFIED action, which proves the
 * pinned installation can reach the repository before writing anything. The
 * unverified mutation is still deployed; nothing here may call it.
 */
describe("GithubChecksRoute connect flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = [];
    mockSuites.value = [
      { _id: "suite-1", name: "Fixture suite", projectId: "proj-1" },
      { _id: "suite-2", name: "Second suite", projectId: "proj-1" },
    ];
    mockOrgsLoading.value = false;
    mockAuthLoading.value = false;
    mockBindings.value = [binding("mcpjam")];
    mockListInstallationRepos.mockReset();
    mockListInstallationRepos.mockResolvedValue([
      repo("mcpjam/other-repo", { private: false }),
    ]);
    mockConnectVerifiedRepo.mockReset();
    mockConnectVerifiedRepo.mockResolvedValue({ configId: "cfg-new" });
  });

  it("keeps Connect disabled until repository, suite AND policy are chosen", async () => {
    const user = userEvent.setup();
    renderRoute();
    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());

    expect(connectButton()).toBeDisabled();
    await chooseOption(user, "Repository", "mcpjam/other-repo");
    expect(connectButton()).toBeDisabled();
    await chooseOption(user, "Suite", "Fixture suite");
    // Repository + suite used to BE the whole form. They are not a policy, and
    // treating them as a complete answer is what produced unstamped rows.
    expect(connectButton()).toBeDisabled();

    await chooseOption(user, "Outage policy", "Fail closed");
    expect(connectButton()).toBeEnabled();
  });

  it("does not offer a connected repository whose listing name is padded", async () => {
    mockRepos.value = [ROW];
    // One normalization on both sides, or none: a padded entry that earns a
    // visibility badge from one comparison and slips past the already-connected
    // filter beside it becomes an offer the submit is refused for.
    mockListInstallationRepos.mockResolvedValue([
      repo(" MCPJam/MCP-Check-Fixture ", { private: true }),
      repo("mcpjam/other-repo", { private: false }),
    ]);
    const user = userEvent.setup();
    renderRoute();
    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());

    await user.click(screen.getByLabelText("Repository"));

    expect(
      await screen.findByRole("option", { name: "mcpjam/other-repo" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /MCP-Check-Fixture/i })
    ).not.toBeInTheDocument();
  });

  it("preselects neither policy", () => {
    renderRoute();

    const policy = screen.getByLabelText("Outage policy");
    expect(policy).toHaveTextContent("Select an outage policy");
    // A placeholder is not a choice. Showing either value here would mean the
    // form submits a policy the administrator never read.
    expect(policy).not.toHaveTextContent("Fail open");
    expect(policy).not.toHaveTextContent("Fail closed");
  });

  it("sends the verified action the derived project and the explicit policy", async () => {
    const user = userEvent.setup();
    renderRoute();
    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());

    await fillConnectForm(user, "Fail closed");
    await user.click(connectButton());

    await waitFor(() =>
      expect(mockConnectVerifiedRepo).toHaveBeenCalledTimes(1)
    );
    expect(mockConnectVerifiedRepo).toHaveBeenCalledWith({
      repoFullName: "mcpjam/other-repo",
      // Derived from the suite, never picked separately.
      projectId: "proj-1",
      suiteId: "suite-1",
      outagePolicy: "fail_closed",
      // Taken STRAIGHT OFF the picked listing entry. The reference says which
      // installation the repository was enumerated through and the id says
      // which repository it is; the server re-verifies both, and neither is
      // reassembled here from a name.
      installationRef: "bind-1",
      repositoryId: repositoryIds.get("mcpjam/other-repo"),
    });
    // The unverified mutation is GONE from the backend. Calling it would now
    // fail outright, and before it was removed it wrote config rows for
    // repositories nobody proved the App could reach.
    expect(mockConnectRepo).not.toHaveBeenCalled();
  });

  it("clears all three selections after a successful connect", async () => {
    const user = userEvent.setup();
    renderRoute();
    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());

    await fillConnectForm(user, "Fail open");
    await user.click(connectButton());
    await waitFor(() => expect(toast.success).toHaveBeenCalled());

    expect(screen.getByLabelText("Repository")).toHaveTextContent(
      "Select a repository"
    );
    expect(screen.getByLabelText("Suite")).toHaveTextContent("Select a suite");
    // Especially the policy: leaving it set would carry one repository's
    // decision silently onto the next one connected.
    expect(screen.getByLabelText("Outage policy")).toHaveTextContent(
      "Select an outage policy"
    );
  });

  it("clears the policy choice when the organization changes", async () => {
    const user = userEvent.setup();
    const { rerender } = render(routeTree("org-1"));
    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());
    await fillConnectForm(user, "Fail closed");
    expect(screen.getByLabelText("Outage policy")).toHaveTextContent(
      "Fail closed"
    );

    rerender(routeTree("org-2"));

    await waitFor(() =>
      expect(mockListInstallationRepos).toHaveBeenCalledTimes(2)
    );
    expect(screen.getByLabelText("Outage policy")).toHaveTextContent(
      "Select an outage policy"
    );
    expect(screen.getByLabelText("Repository")).toHaveTextContent(
      "Select a repository"
    );
  });

  it("shows the verified action's flat refusal and keeps the selections", async () => {
    // The action answers refusals with one sentence on purpose — which repo the
    // App can see is not something a caller gets to enumerate. The page repeats
    // it verbatim rather than parsing GitHub detail out of it.
    mockConnectVerifiedRepo.mockRejectedValueOnce(
      new Error("Repository is not accessible to the MCPJam GitHub App.")
    );
    const user = userEvent.setup();
    renderRoute();
    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());

    await fillConnectForm(user, "Fail closed");
    await user.click(connectButton());

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Repository is not accessible to the MCPJam GitHub App."
      )
    );
    // Nothing was connected, so nothing is cleared: the administrator can fix
    // the App installation and press Connect again.
    expect(screen.getByLabelText("Repository")).toHaveTextContent(
      "mcpjam/other-repo"
    );
    expect(screen.getByLabelText("Outage policy")).toHaveTextContent(
      "Fail closed"
    );
  });

  it("states what each policy CONCLUDES and leaves merging to branch protection", () => {
    renderRoute();

    expect(
      screen.getByText(
        /During an MCPJam outage or pause, the check reports neutral\./
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /During an MCPJam outage or pause, the check reports failed\./
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Whether a failed or neutral check blocks merging depends on this repository's branch-protection settings\./
      )
    ).toBeInTheDocument();

    // MCPJam sets a conclusion. Whether a conclusion stops a merge is branch
    // protection's answer, in a repository setting this app cannot read — so
    // any categorical merge promise here is a promise made for someone else.
    const page = document.body.textContent ?? "";
    for (const forbidden of [
      /merges proceed/i,
      /merges are blocked/i,
      /merge will be blocked/i,
      /cannot be merged/i,
      /can still be merged/i,
    ]) {
      expect(page).not.toMatch(forbidden);
    }
  });
});

/**
 * The per-row policy control, and the distinction it has to keep visible:
 * a row with `fail_open` STORED and a row with nothing stored behave the same
 * way at conclusion time, and are not the same thing. One is a decision; the
 * other is a decision nobody has made yet.
 */
describe("GithubChecksRoute row outage policy", () => {
  const POLICY_LABEL = "Outage policy for mcpjam/mcp-check-fixture";

  beforeEach(() => {
    vi.clearAllMocks();
    mockAvailability.value = { state: "enabled" };
    mockSuites.value = [
      { _id: "suite-1", name: "Fixture suite", projectId: "proj-1" },
    ];
    mockOrgsLoading.value = false;
    mockAuthLoading.value = false;
    mockBindings.value = [binding("mcpjam")];
    mockListInstallationRepos.mockReset();
    mockListInstallationRepos.mockResolvedValue([]);
    mockSetRepoOutagePolicy.mockReset();
    mockSetRepoOutagePolicy.mockResolvedValue({ changed: true });
  });

  it("shows a stored policy as the selected value and writes a change", async () => {
    mockRepos.value = [FAIL_OPEN_ROW];
    const user = userEvent.setup();
    renderRoute();

    expect(screen.getByLabelText(POLICY_LABEL)).toHaveTextContent("Fail open");

    await chooseOption(user, POLICY_LABEL, "Fail closed");

    expect(mockSetRepoOutagePolicy).toHaveBeenCalledWith({
      configId: "cfg-1",
      outagePolicy: "fail_closed",
    });
  });

  it("says a legacy row has no policy instead of showing fail open", () => {
    mockRepos.value = [UNSET_POLICY_ROW];
    renderRoute();

    const policy = screen.getByLabelText(POLICY_LABEL);
    expect(policy).toHaveTextContent("Policy not chosen");
    // Binding the control to `fail_open` would render somebody else's default
    // as this administrator's choice.
    expect(policy).not.toHaveTextContent("Fail open");
    expect(screen.getByText(/No outage policy chosen/)).toBeInTheDocument();
    // …and the behaviour it actually has today is still stated.
    expect(screen.getByText(/effectively fails open/)).toBeInTheDocument();
  });

  it("persists an explicit choice made on a row that had none", async () => {
    mockRepos.value = [UNSET_POLICY_ROW];
    const user = userEvent.setup();
    renderRoute();

    await chooseOption(user, POLICY_LABEL, "Fail open");

    // Same value the backend would have assumed, now actually recorded.
    expect(mockSetRepoOutagePolicy).toHaveBeenCalledWith({
      configId: "cfg-1",
      outagePolicy: "fail_open",
    });
  });

  it("treats a silent no-op as success", async () => {
    mockRepos.value = [FAIL_OPEN_ROW];
    mockSetRepoOutagePolicy.mockResolvedValue({ changed: false });
    const user = userEvent.setup();
    renderRoute();

    await chooseOption(user, POLICY_LABEL, "Fail closed");

    await waitFor(() => expect(mockSetRepoOutagePolicy).toHaveBeenCalled());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reports a failed policy write through the existing write-error toast", async () => {
    mockRepos.value = [FAIL_OPEN_ROW];
    mockSetRepoOutagePolicy.mockRejectedValueOnce(new Error("network"));
    const user = userEvent.setup();
    renderRoute();

    await chooseOption(user, POLICY_LABEL, "Fail closed");

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("network"));
  });

  it("disables the policy control while its write is in flight and drops a duplicate", async () => {
    mockRepos.value = [FAIL_OPEN_ROW];
    let release: (() => void) | undefined;
    mockSetRepoOutagePolicy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ changed: true });
        })
    );
    const user = userEvent.setup();
    renderRoute();

    await chooseOption(user, POLICY_LABEL, "Fail closed");

    // The select stays bound to the SERVER snapshot until the list refreshes,
    // so a second change made before the first settles would be decided against
    // a row state that is already moving. Both halves of the guard hang off the
    // same pending set: the control goes disabled, and the handler drops a
    // change for a row it is already writing.
    const policy = screen.getByLabelText(POLICY_LABEL);
    expect(policy).toBeDisabled();
    await user.click(policy);
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    expect(mockSetRepoOutagePolicy).toHaveBeenCalledTimes(1);

    release?.();
    await waitFor(() =>
      expect(screen.getByLabelText(POLICY_LABEL)).toBeEnabled()
    );
  });

  it("leaves the enable toggle usable while a policy write is pending", async () => {
    mockRepos.value = [FAIL_OPEN_ROW];
    mockSetRepoOutagePolicy.mockImplementationOnce(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderRoute();

    await chooseOption(user, POLICY_LABEL, "Fail closed");

    // Two different writes on one row. Sharing a pending set would freeze a
    // control the user has no reason to think is busy.
    expect(
      screen.getByLabelText("Enable checks for mcpjam/mcp-check-fixture")
    ).toBeEnabled();
  });
});

/**
 * The per-repository comment toggle, and the one reading that makes it wrong.
 *
 * `feedbackComments` is ABSENT ⇒ `on`, which inverts every other optional
 * policy on the row. A UI that treats absent the way it treats
 * `conformanceEnabled` renders the control off for every repository that has
 * never been touched — which is every repository — and tells an administrator
 * the opposite of what MCPJam is doing on their pull requests.
 */
describe("GithubChecksRoute pull-request comments", () => {
  const COMMENTS_LABEL =
    "Post feedback comments on pull requests for mcpjam/mcp-check-fixture";

  beforeEach(() => {
    vi.clearAllMocks();
    mockAvailability.value = { state: "enabled" };
    mockSuites.value = [
      { _id: "suite-1", name: "Fixture suite", projectId: "proj-1" },
    ];
    mockOrgsLoading.value = false;
    mockAuthLoading.value = false;
    mockBindings.value = [binding("mcpjam")];
    mockListInstallationRepos.mockReset();
    mockListInstallationRepos.mockResolvedValue([]);
    mockSetRepoFeedbackComments.mockReset();
    mockSetRepoFeedbackComments.mockResolvedValue({ changed: true });
  });

  it("renders a row with NO stored setting as ON, and turns it off", () => {
    // The load-bearing case. Nothing is stored, so MCPJam IS commenting.
    mockRepos.value = [ROW];
    renderRoute();

    const toggle = screen.getByLabelText(COMMENTS_LABEL);
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);

    expect(mockSetRepoFeedbackComments).toHaveBeenCalledWith({
      configId: "cfg-1",
      feedbackComments: "off",
    });
  });

  it("renders a row stored as off, and turns it back on", () => {
    mockRepos.value = [COMMENTS_OFF_ROW];
    renderRoute();

    const toggle = screen.getByLabelText(COMMENTS_LABEL);
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    expect(mockSetRepoFeedbackComments).toHaveBeenCalledWith({
      configId: "cfg-1",
      feedbackComments: "on",
    });
  });

  it("says what the toggle does, and what survives turning it off", () => {
    mockRepos.value = [ROW];
    renderRoute();

    expect(
      screen.getByText(
        /MCPJam posts one comment per pull request and updates it in place\. Turning this off leaves only the check run\./
      )
    ).toBeInTheDocument();
  });

  it("announces what changed, naming the check as unaffected", async () => {
    mockRepos.value = [ROW];
    renderRoute();

    fireEvent.click(screen.getByLabelText(COMMENTS_LABEL));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "MCPJam will stop commenting on pull requests in this repository. The check still runs and still reports."
      )
    );
  });

  it("announces NOTHING when the write was a successful no-op", async () => {
    // `{ changed: false }` means the stored value already said this, which is
    // reachable whenever the row is stale — another tab, or a write that landed
    // before this list refetched. The toast would otherwise tell an admin
    // MCPJam "will stop commenting" on a repository whose setting nobody moved.
    // Same rule the outage-policy select follows.
    mockRepos.value = [ROW];
    mockSetRepoFeedbackComments.mockResolvedValueOnce({ changed: false });
    renderRoute();

    fireEvent.click(screen.getByLabelText(COMMENTS_LABEL));

    await waitFor(() => expect(mockSetRepoFeedbackComments).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("shows the backend's own refusal when the write is rejected", async () => {
    mockRepos.value = [ROW];
    mockSetRepoFeedbackComments.mockRejectedValueOnce(
      new Error("You are not an administrator of this organization.")
    );
    renderRoute();

    fireEvent.click(screen.getByLabelText(COMMENTS_LABEL));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "You are not an administrator of this organization."
      )
    );
  });

  it("says nothing changed when the refusal carried no message", async () => {
    mockRepos.value = [ROW];
    // A `ConvexError`-less throw — a dropped connection, not a refusal the
    // backend worded. The generic "something went wrong" would leave an admin
    // unsure whether MCPJam is still commenting.
    mockSetRepoFeedbackComments.mockRejectedValueOnce(new Error(""));
    renderRoute();

    fireEvent.click(screen.getByLabelText(COMMENTS_LABEL));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "We could not change pull-request comments for that repository. Nothing changed — try again."
      )
    );
  });

  it("stays answerable while checks are paused", () => {
    // Not gated on `enabled` the way conformance is: this decides what MCPJam
    // may WRITE on other people's pull requests, and a paused repository is
    // still a repository an admin may want to settle that for.
    mockRepos.value = [{ ...ROW, enabled: false }];
    renderRoute();

    expect(screen.getByLabelText(COMMENTS_LABEL)).toBeEnabled();
  });

  it("drops a second click while the first write is still in flight", async () => {
    mockRepos.value = [ROW];
    let release: (() => void) | undefined;
    mockSetRepoFeedbackComments.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ changed: true });
        })
    );
    renderRoute();

    const toggle = screen.getByLabelText(COMMENTS_LABEL);
    fireEvent.click(toggle);
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    expect(mockSetRepoFeedbackComments).toHaveBeenCalledTimes(1);

    // The enable toggle is a DIFFERENT write on the same row and must not be
    // frozen by this one.
    expect(
      screen.getByLabelText("Enable checks for mcpjam/mcp-check-fixture")
    ).toBeEnabled();

    await act(async () => {
      release?.();
    });
    await waitFor(() =>
      expect(screen.getByLabelText(COMMENTS_LABEL)).toBeEnabled()
    );
  });

  it("says at CONNECT time that MCPJam will comment, and that it is reversible", async () => {
    // The consent moment: connecting starts MCPJam writing on pull requests in
    // a repository other people open them against.
    mockRepos.value = [];
    renderRoute();

    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());

    expect(
      screen.getByText(
        /MCPJam will also post a comment on each pull request in this repository, updated in place as new commits land\. You can turn that off per repository after connecting\./
      )
    ).toBeInTheDocument();
  });
});

/**
 * Visibility is a LIVE GitHub fact, joined from the installation listing and
 * persisted nowhere. Everything that is not an explicit boolean is unknown, and
 * unknown renders nothing — labelling a private repository "Public" on the
 * owner's own settings page is the one mistake this join must never make.
 */
describe("GithubChecksRoute repository visibility", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAvailability.value = { state: "enabled" };
    mockSuites.value = [
      { _id: "suite-1", name: "Fixture suite", projectId: "proj-1" },
    ];
    mockOrgsLoading.value = false;
    mockAuthLoading.value = false;
    mockBindings.value = [binding("mcpjam")];
    mockRepos.value = [ROW];
    mockListInstallationRepos.mockReset();
  });

  it("badges private and public from the live listing, joined case-insensitively", async () => {
    mockRepos.value = [
      ROW,
      { ...ROW, _id: "cfg-2", repoFullName: "mcpjam/public-fixture" },
    ];
    // GitHub answers with its own casing, and the row stores the canonical
    // lowercase form. Both sides are normalized so the join survives that.
    mockListInstallationRepos.mockResolvedValue([
      repo("MCPJam/MCP-Check-Fixture", { private: true }),
      repo(" mcpjam/Public-Fixture ", { private: false }),
    ]);
    renderRoute();

    expect(await screen.findByText("Private")).toBeInTheDocument();
    expect(screen.getByText("Public")).toBeInTheDocument();
  });

  it.each([
    [
      "GitHub omitted the flag",
      [repo("mcpjam/mcp-check-fixture")] as unknown[],
    ],
    [
      "the row is not in the installation listing",
      [repo("mcpjam/other-repo", { private: false })] as unknown[],
    ],
    ["the listing is empty", [] as unknown[]],
  ])("asserts no visibility when %s", async (_case, listing) => {
    mockListInstallationRepos.mockResolvedValue(listing);
    renderRoute();

    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());
    // A connected repository can legitimately be missing from the current
    // listing; the row stays, only the claim goes.
    expect(screen.getByText("mcpjam/mcp-check-fixture")).toBeInTheDocument();
    expect(screen.queryByText("Public")).not.toBeInTheDocument();
    expect(screen.queryByText("Private")).not.toBeInTheDocument();
  });

  it("asserts no visibility when the listing fails", async () => {
    mockListInstallationRepos.mockRejectedValue(new Error("network"));
    renderRoute();

    expect(
      await screen.findByText(/Could not load repositories from GitHub/)
    ).toBeInTheDocument();
    // An outage is not evidence that anything is public.
    expect(screen.queryByText("Public")).not.toBeInTheDocument();
    expect(screen.queryByText("Private")).not.toBeInTheDocument();
  });

  it("shows no visibility while the listing is still loading", () => {
    mockListInstallationRepos.mockImplementation(() => new Promise(() => {}));
    renderRoute();

    expect(screen.getByText("mcpjam/mcp-check-fixture")).toBeInTheDocument();
    expect(screen.queryByText("Public")).not.toBeInTheDocument();
  });
});

/**
 * Switching organizations while requests are in flight.
 *
 * The component stays mounted across the switch, so every pending promise
 * resolves onto a page that is now showing a DIFFERENT organization. None of
 * them may land there: not the repository listing (it would badge the new org's
 * rows with the old org's visibility), and not a connect (it would clear a
 * fresh selection and announce a repository connected to an org it was not).
 */
describe("GithubChecksRoute organization switching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAvailability.value = { state: "enabled" };
    mockSuites.value = [
      { _id: "suite-1", name: "Fixture suite", projectId: "proj-1" },
    ];
    mockOrgsLoading.value = false;
    mockAuthLoading.value = false;
    mockBindings.value = [binding("mcpjam")];
    mockListInstallationRepos.mockReset();
    mockConnectVerifiedRepo.mockReset();
    mockConnectVerifiedRepo.mockResolvedValue({ configId: "cfg-new" });
  });

  it("drops a listing that arrives after the organization changed", async () => {
    mockRepos.value = [ROW];
    let resolveStale: ((repos: unknown[]) => void) | undefined;
    mockListInstallationRepos
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStale = resolve as (repos: unknown[]) => void;
          })
      )
      .mockResolvedValue([
        repo("mcpjam/mcp-check-fixture", { private: false }),
      ]);

    const { rerender } = render(routeTree("org-1"));
    rerender(routeTree("org-2"));
    await waitFor(() =>
      expect(mockListInstallationRepos).toHaveBeenCalledTimes(2)
    );
    expect(await screen.findByText("Public")).toBeInTheDocument();

    // org-1's answer, arriving late and disagreeing.
    await act(async () => {
      resolveStale?.([repo("mcpjam/mcp-check-fixture", { private: true })]);
    });

    expect(screen.getByText("Public")).toBeInTheDocument();
    expect(screen.queryByText("Private")).not.toBeInTheDocument();
  });

  it("drops a connect that completes after the organization changed", async () => {
    mockRepos.value = [];
    mockListInstallationRepos.mockResolvedValue([
      repo("mcpjam/other-repo", { private: false }),
    ]);
    let resolveStaleConnect: ((result: unknown) => void) | undefined;
    mockConnectVerifiedRepo.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveStaleConnect = resolve as (result: unknown) => void;
        })
    );

    const user = userEvent.setup();
    const { rerender } = render(routeTree("org-1"));
    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());
    await fillConnectForm(user, "Fail closed");
    await user.click(connectButton());
    await waitFor(() =>
      expect(mockConnectVerifiedRepo).toHaveBeenCalledTimes(1)
    );

    rerender(routeTree("org-2"));
    await waitFor(() =>
      expect(mockListInstallationRepos).toHaveBeenCalledTimes(2)
    );
    await fillConnectForm(user, "Fail open");

    await act(async () => {
      resolveStaleConnect?.({ configId: "cfg-new" });
    });

    // No success for an organization the user has left…
    expect(toast.success).not.toHaveBeenCalled();
    // …and the selections just made for THIS organization survive.
    expect(screen.getByLabelText("Repository")).toHaveTextContent(
      "mcpjam/other-repo"
    );
    expect(screen.getByLabelText("Outage policy")).toHaveTextContent(
      "Fail open"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// BINDING CHANGES — the listing has to follow them
// ═══════════════════════════════════════════════════════════════════════════
//
// The offerable repositories come from an ACTION: a one-shot read that nothing
// re-runs on its own. What decides its answer — which installations this
// organization holds — arrives on a LIVE QUERY. So connecting an account has to
// be what re-reads the listing, and the bug that says otherwise is not subtle:
// a claim that succeeded server-side, repositories waiting behind it, and a
// page still saying "Connect a GitHub account above first" until a reload.
//
// The other half is just as load-bearing. A Convex subscription hands back a
// fresh array on every delivery, including one that re-sends identical rows, so
// anything that watched the array itself would ask GitHub again on every poll.
describe("GithubChecksRoute binding changes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = [];
    mockSuites.value = [
      { _id: "suite-1", name: "Fixture suite", projectId: "proj-1" },
    ];
    mockOrgsLoading.value = false;
    mockAuthLoading.value = false;
    mockBindings.value = [];
    mockListInstallationRepos.mockReset();
    mockConnectVerifiedRepo.mockReset();
    mockConnectVerifiedRepo.mockResolvedValue({ configId: "cfg-new" });
  });

  it("re-lists repositories when an account is connected, with no reload", async () => {
    mockListInstallationRepos
      .mockResolvedValueOnce([])
      .mockResolvedValue([repo("acme/widgets", { accountLogin: "acme" })]);

    const user = userEvent.setup();
    const { rerender } = render(routeTree("org-1"));

    // Where the user starts: nothing connected, so nothing to offer.
    expect(
      await screen.findByText(
        /No repositories available\. Connect a GitHub account above first\./
      )
    ).toBeInTheDocument();
    expect(mockListInstallationRepos).toHaveBeenCalledTimes(1);

    // The bind lands. NOTHING else about this page changes — same org, still
    // enabled, same memoized callbacks — which is exactly why the listing used
    // to sit there stale.
    mockBindings.value = [binding("acme")];
    rerender(routeTree("org-1"));

    await waitFor(() =>
      expect(mockListInstallationRepos).toHaveBeenCalledTimes(2)
    );
    await waitFor(() =>
      expect(
        screen.queryByText(/No repositories available/)
      ).not.toBeInTheDocument()
    );
    await user.click(screen.getByLabelText("Repository"));
    expect(
      await screen.findByRole("option", { name: "acme/widgets" })
    ).toBeInTheDocument();
  });

  it("re-lists when a binding's status changes, not only when one appears", async () => {
    mockBindings.value = [binding("acme")];
    mockListInstallationRepos.mockResolvedValue([repo("acme/widgets")]);

    const { rerender } = render(routeTree("org-1"));
    await waitFor(() =>
      expect(mockListInstallationRepos).toHaveBeenCalledTimes(1)
    );

    // Suspended, removed and unbound each stop an installation answering for
    // its repositories, so the set being unchanged is not the question.
    mockBindings.value = [binding("acme", { status: "suspended" })];
    rerender(routeTree("org-1"));

    await waitFor(() =>
      expect(mockListInstallationRepos).toHaveBeenCalledTimes(2)
    );
  });

  it("does not re-list when the live query re-delivers the same bindings", async () => {
    mockBindings.value = [binding("acme"), binding("beta")];
    mockListInstallationRepos.mockResolvedValue([repo("acme/widgets")]);

    const { rerender } = render(routeTree("org-1"));
    await waitFor(() =>
      expect(mockListInstallationRepos).toHaveBeenCalledTimes(1)
    );

    // A new array, equal content, and the rows in the other order — all three
    // are ordinary for a subscription and none of them is a change.
    mockBindings.value = [binding("beta"), binding("acme")];
    rerender(routeTree("org-1"));
    await act(async () => {});

    expect(mockListInstallationRepos).toHaveBeenCalledTimes(1);
  });

  it("does not re-list when the bindings query answers for the first time", async () => {
    // `undefined` is the state every cold load starts in: the bindings query is
    // not even subscribed until availability says `enabled`, so it answers
    // AFTER the first listing was asked for. That answer describes the same
    // installations that request was made against — reading it as a change
    // would double every page load.
    mockBindings.value = undefined;
    mockListInstallationRepos.mockResolvedValue([repo("acme/widgets")]);

    const { rerender } = render(routeTree("org-1"));
    await waitFor(() =>
      expect(mockListInstallationRepos).toHaveBeenCalledTimes(1)
    );

    mockBindings.value = [binding("acme")];
    rerender(routeTree("org-1"));
    await act(async () => {});

    expect(mockListInstallationRepos).toHaveBeenCalledTimes(1);
    // …and the listing that was in flight is still the one on screen.
    expect(
      await screen.findByRole("combobox", { name: "Repository" })
    ).toBeInTheDocument();
  });

  it("still resets the picker on an org switch, and still drops the stale listing", async () => {
    // The org-switch guarantees have to survive the refetch machinery: the
    // reset moved out of the listing effect, and the in-flight guard is now a
    // generation rather than a per-run flag.
    mockBindings.value = [binding("acme")];
    let resolveStale: ((repos: unknown[]) => void) | undefined;
    mockListInstallationRepos
      .mockResolvedValueOnce([repo("acme/widgets")])
      // The refetch caused by the bind below, left hanging so that the ORG
      // SWITCH happens while it is still in flight.
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStale = resolve as (repos: unknown[]) => void;
          })
      )
      .mockResolvedValue([repo("beta/gadgets", { accountLogin: "beta" })]);

    const user = userEvent.setup();
    const { rerender } = render(routeTree("org-1"));
    await waitFor(() =>
      expect(mockListInstallationRepos).toHaveBeenCalledTimes(1)
    );
    await chooseOption(user, "Repository", "acme/widgets");
    await chooseOption(user, "Outage policy", "Fail closed");

    // A second account is connected: the listing is re-read, and the choice
    // just made is deliberately KEPT — the organization it belongs to has not
    // changed, and losing it would punish someone for someone else's bind.
    mockBindings.value = [binding("acme"), binding("beta")];
    rerender(routeTree("org-1"));
    await waitFor(() =>
      expect(mockListInstallationRepos).toHaveBeenCalledTimes(2)
    );
    expect(screen.getByLabelText("Outage policy")).toHaveTextContent(
      "Fail closed"
    );

    // Now the org changes while that refetch is still in flight.
    rerender(routeTree("org-2"));
    await waitFor(() =>
      expect(mockListInstallationRepos).toHaveBeenCalledTimes(3)
    );
    expect(screen.getByLabelText("Repository")).toHaveTextContent(
      "Select a repository"
    );
    expect(screen.getByLabelText("Outage policy")).toHaveTextContent(
      "Select an outage policy"
    );

    // org-1's answer, arriving late. It must not repopulate org-2's picker.
    await act(async () => {
      resolveStale?.([repo("acme/widgets")]);
    });
    await user.click(screen.getByLabelText("Repository"));
    expect(
      await screen.findByRole("option", { name: "beta/gadgets" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "acme/widgets" })
    ).not.toBeInTheDocument();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// GITHUB ACCOUNTS — the org ↔ installation binding surface
// ═══════════════════════════════════════════════════════════════════════════
//
// Three properties this section has to hold, all of which are about NOT saying
// something:
//
//   1. No raw GitHub installation id is ever rendered. `installationRef` is an
//      opaque row id and is the only handle the page has.
//   2. A refusal is shown exactly as the backend worded it. The backend refuses
//      flatly on purpose — telling "already connected to another workspace"
//      apart from "that installation does not exist" would answer questions
//      about other people's accounts — so the page must not embellish.
//   3. Disconnecting asks first, and the confirmation says the LIMIT of the
//      consequence as well as the consequence.

describe("GithubChecksRoute installations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAvailability.value = { state: "enabled" };
    mockRepos.value = [];
    mockSuites.value = [];
    mockOrgsLoading.value = false;
    mockAuthLoading.value = false;
    mockBindings.value = [];
    mockListInstallationRepos.mockReset();
    mockListInstallationRepos.mockResolvedValue([]);
    mockStartInstallation.mockReset();
    mockStartInstallation.mockResolvedValue({
      installUrl: "https://github.com/apps/mcpjam/installations/new?state=abc",
    });
    mockStartDirectClaim.mockReset();
    mockStartDirectClaim.mockResolvedValue({
      authorizeUrl: "https://github.com/login/oauth/authorize?client_id=x",
    });
    mockUnbindInstallation.mockReset();
    mockUnbindInstallation.mockResolvedValue({ changed: true });
    mockRedirectToGithub.mockReset();
  });

  it("offers both an install and a claim, and explains why claiming needs GitHub", async () => {
    renderRoute();
    expect(
      await screen.findByRole("button", { name: /Install on a GitHub account/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Claim an existing installation/ })
    ).toBeInTheDocument();
    // The whole reason the claim path needs an OAuth leg, in one sentence: the
    // App JWT can read every installation it has, so installing is not proof
    // that an installation is yours to connect here.
    expect(
      screen.getByText(/is not on its own proof that it is yours to connect/i)
    ).toBeInTheDocument();
  });

  it("sends the admin to the server-built install URL", async () => {
    const user = userEvent.setup();
    renderRoute();
    await user.click(
      await screen.findByRole("button", { name: /Install on a GitHub account/ })
    );

    await waitFor(() => expect(mockStartInstallation).toHaveBeenCalledTimes(1));
    // The URL carries a one-time state the BACKEND minted and hashed. The page
    // only follows it.
    expect(mockRedirectToGithub).toHaveBeenCalledWith(
      "https://github.com/apps/mcpjam/installations/new?state=abc"
    );
  });

  it("sends the admin to the OAuth URL for a claim", async () => {
    const user = userEvent.setup();
    renderRoute();
    await user.click(
      await screen.findByRole("button", {
        name: /Claim an existing installation/,
      })
    );

    await waitFor(() => expect(mockStartDirectClaim).toHaveBeenCalledTimes(1));
    expect(mockRedirectToGithub).toHaveBeenCalledWith(
      "https://github.com/login/oauth/authorize?client_id=x"
    );
  });

  it("shows the backend's conflict wording verbatim, naming no other workspace", async () => {
    const conflict = Object.assign(new Error("Server Error"), {
      data: "That GitHub installation is already connected to a workspace. This is not a problem with your repositories — ask whoever set it up to disconnect it first, or install the app on a different account.",
    });
    mockStartInstallation.mockRejectedValue(conflict);
    const user = userEvent.setup();
    renderRoute();

    await user.click(
      await screen.findByRole("button", { name: /Install on a GitHub account/ })
    );
    await waitFor(() => expect(toast.error).toHaveBeenCalled());

    const shown = String(
      (toast.error as ReturnType<typeof vi.fn>).mock.calls[0][0]
    );
    expect(shown).toMatch(/already connected to a workspace/i);
    // Non-disclosure survives the trip through the UI.
    expect(shown).not.toMatch(/organization|workspace named|org-/i);
  });

  it.each([
    ["active", /Repositories on this account can run checks/i],
    ["suspended", /Suspended on GitHub/i],
    ["removed", /uninstalled from this account/i],
  ] as const)("renders the %s binding state", async (status, copy) => {
    mockBindings.value = [binding("acme", { status })];
    renderRoute();
    expect(await screen.findByText("acme")).toBeInTheDocument();
    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it("never renders a raw GitHub installation id", async () => {
    // The fixture CARRIES one, and this is the only assertion that mentions it.
    // Without it the test passes for any rendering — including one that echoes
    // an id it was never given — because no other fixture here has digits in.
    const RAW_INSTALLATION_ID = "48213907";
    mockBindings.value = [
      { ...binding("acme"), installationId: Number(RAW_INSTALLATION_ID) },
    ];
    const { container } = renderRoute();
    await screen.findByText("acme");

    // The opaque ref is all the page should use, and even that is not
    // user-facing.
    expect(container.textContent).not.toContain(RAW_INSTALLATION_ID);
    expect(container.textContent).not.toMatch(/\b\d{6,}\b/);
  });

  it("has copy for `unbound`, which the backend does not send", async () => {
    // The fourth state in `GITHUB_BINDING_STATUS_COPY`. The BACKEND filters
    // `unbound` rows out of `listBindingsForOrganization` — an admin severed
    // that relationship deliberately, and a fifth state to interpret adds
    // nothing — so this is unreachable in practice.
    //
    // The page deliberately does NOT re-implement that filter. A second
    // authority on which bindings are visible is exactly the kind of thing
    // that disagrees with the first one later. The map stays total over the
    // status union instead, so a backend that ever did send one renders
    // something true rather than `undefined`, and this pins that.
    mockBindings.value = [binding("acme", { status: "unbound" })];
    renderRoute();
    expect(
      await screen.findByText(/Disconnected from this workspace/i)
    ).toBeInTheDocument();
  });

  it("asks before disconnecting, and says what is KEPT as well as what stops", async () => {
    mockBindings.value = [binding("acme")];
    const user = userEvent.setup();
    renderRoute();

    await user.click(
      await screen.findByRole("button", { name: "Disconnect acme" })
    );
    expect(
      await screen.findByText(/Checks on its repositories stop immediately/i)
    ).toBeInTheDocument();
    // The limit matters as much as the consequence: reconnecting is not a
    // rebuild, and copy that implied otherwise would stop admins acting.
    expect(
      screen.getByText(/suite and policy settings are kept/i)
    ).toBeInTheDocument();
    // Nothing has happened yet.
    expect(mockUnbindInstallation).not.toHaveBeenCalled();
  });

  it("disconnects with the opaque ref once confirmed", async () => {
    mockBindings.value = [binding("acme", { installationRef: "bind-xyz" })];
    const user = userEvent.setup();
    renderRoute();

    await user.click(
      await screen.findByRole("button", { name: "Disconnect acme" })
    );
    await user.click(await screen.findByRole("button", { name: "Disconnect" }));

    await waitFor(() =>
      expect(mockUnbindInstallation).toHaveBeenCalledWith({
        installationRef: "bind-xyz",
      })
    );
  });

  it("does not disconnect when the confirmation is dismissed", async () => {
    mockBindings.value = [binding("acme")];
    const user = userEvent.setup();
    renderRoute();

    await user.click(
      await screen.findByRole("button", { name: "Disconnect acme" })
    );
    await user.click(
      await screen.findByRole("button", { name: "Keep it connected" })
    );

    expect(mockUnbindInstallation).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONNECTION STATUS, AND THE PICKER'S IDENTITY
// ═══════════════════════════════════════════════════════════════════════════

describe("GithubChecksRoute connection status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAvailability.value = { state: "enabled" };
    mockSuites.value = [
      { _id: "suite-1", name: "Fixture suite", projectId: "proj-1" },
    ];
    mockOrgsLoading.value = false;
    mockAuthLoading.value = false;
    mockBindings.value = [binding("mcpjam")];
    mockListInstallationRepos.mockReset();
    mockListInstallationRepos.mockResolvedValue([]);
  });

  it("renders no badge at all for a verified row", async () => {
    mockRepos.value = [ROW];
    renderRoute();
    await screen.findByText("mcpjam/mcp-check-fixture");
    // A badge saying "fine" on every healthy row makes the rows that need
    // attention harder to find.
    expect(screen.queryByText("Reconnect required")).not.toBeInTheDocument();
    expect(screen.queryByText("App inactive")).not.toBeInTheDocument();
    expect(screen.queryByText("No access")).not.toBeInTheDocument();
  });

  it.each([
    ["legacy_unverified", "Reconnect required", /Reconnect it to keep checks/i],
    ["installation_inactive", "App inactive", /not active on this account/i],
    ["repository_access_removed", "No access", /no longer has access/i],
  ] as const)("renders %s", async (status, label, explainer) => {
    mockRepos.value = [{ ...ROW, connectionStatus: status }];
    renderRoute();
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByText(explainer)).toBeInTheDocument();
    // Every one of these says what it is NOT, because the natural reading of a
    // stopped check is "my code did something" and none of these is that.
    expect(
      screen.getByText(
        /not a problem with your pull requests|nothing is wrong/i
      )
    ).toBeInTheDocument();
  });

  it("does NOT infer a status from a missing visibility badge", async () => {
    // GitHub omitting `private` means "we do not know", not "something is
    // wrong". Conflating them would put a warning on a healthy repository.
    mockRepos.value = [ROW];
    mockListInstallationRepos.mockResolvedValue([
      repo("mcpjam/mcp-check-fixture"),
    ]);
    renderRoute();
    await screen.findByText("mcpjam/mcp-check-fixture");
    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());

    expect(screen.queryByText("Private")).not.toBeInTheDocument();
    expect(screen.queryByText("Public")).not.toBeInTheDocument();
    expect(screen.queryByText("Reconnect required")).not.toBeInTheDocument();
  });

  it("labels the account only when it disambiguates", async () => {
    mockRepos.value = [];
    mockListInstallationRepos.mockResolvedValue([
      repo("acme/widgets", { accountLogin: "acme", installationRef: "b1" }),
      repo("globex/widgets", { accountLogin: "globex", installationRef: "b2" }),
    ]);
    const user = userEvent.setup();
    renderRoute();
    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());

    await user.click(screen.getByLabelText("Repository"));
    expect(
      await screen.findByRole("option", { name: "acme/widgets · acme" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "globex/widgets · globex" })
    ).toBeInTheDocument();
  });

  it("omits the account label when there is only one", async () => {
    mockRepos.value = [];
    mockListInstallationRepos.mockResolvedValue([
      repo("acme/widgets", { accountLogin: "acme" }),
      repo("acme/gadgets", { accountLogin: "acme" }),
    ]);
    const user = userEvent.setup();
    renderRoute();
    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());

    await user.click(screen.getByLabelText("Repository"));
    // One repeated label on every row is a column of noise.
    expect(
      await screen.findByRole("option", { name: "acme/widgets" })
    ).toBeInTheDocument();
  });

  it("sends no installationRef when the listing carried none", async () => {
    // The compatibility window: the backend is still falling back to its pinned
    // installation for an org with no binding, and omitting the reference is
    // what keeps that connect path reachable.
    mockRepos.value = [];
    mockConnectVerifiedRepo.mockReset();
    mockConnectVerifiedRepo.mockResolvedValue({ configId: "cfg-pinned" });
    mockListInstallationRepos.mockResolvedValue([
      repo("mcpjam/pinned-repo", { installationRef: null, accountLogin: "" }),
    ]);
    const user = userEvent.setup();
    renderRoute();
    await waitFor(() => expect(mockListInstallationRepos).toHaveBeenCalled());

    await chooseOption(user, "Repository", "mcpjam/pinned-repo");
    await chooseOption(user, "Suite", "Fixture suite");
    await chooseOption(user, "Outage policy", "Fail closed");
    await user.click(connectButton());

    await waitFor(() =>
      expect(mockConnectVerifiedRepo).toHaveBeenCalledTimes(1)
    );
    const sent = mockConnectVerifiedRepo.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(sent).not.toHaveProperty("installationRef");
    expect(sent.repositoryId).toBe(repositoryIds.get("mcpjam/pinned-repo"));
  });
});
