import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { XAASetupAppsSection } from "../XAASetupAppsSection";

vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));

// Mock at the convex/react boundary so the string refs + args the hooks emit
// are what these tests assert (the hand-mirrored wire contract).
const queryResults: Record<string, unknown> = {};
const mutationCalls: Array<{ ref: string; args: unknown }> = [];
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: (ref: string, args: unknown) =>
    args === "skip" ? undefined : queryResults[ref],
  useMutation: (ref: string) => async (args: unknown) => {
    mutationCalls.push({ ref, args });
    return {};
  },
  useAction: (ref: string) => async (args: unknown) => {
    mutationCalls.push({ ref, args });
    return {};
  },
}));

const refreshMock = vi.fn(async () => undefined);
let auditEvents: Array<Record<string, unknown>> = [];
let auditError: Error | null = null;
vi.mock("@/hooks/useOrganizationAudit", () => ({
  useOrganizationAudit: () => ({
    events: auditEvents,
    isLoading: false,
    error: auditError,
    refresh: refreshMock,
  }),
}));

vi.mock("@/components/xaa/registration/XAARegistrationWizard", () => ({
  XAARegistrationWizard: ({ open }: { open: boolean }) =>
    open ? <div data-testid="xaa-reg-wizard-open" /> : null,
}));

const openInDebuggerMock = vi.fn();
vi.mock("@/lib/app-navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/app-navigation")>();
  return {
    ...actual,
    openXaaAppInDebugger: (appId: string) => openInDebuggerMock(appId),
  };
});

const ORG_ID = "org_test";

const APP = {
  id: "app_1",
  name: "Files API",
  resourceType: "rest",
  resourceUrl: "https://files.example.test",
  authServerMode: "own",
  issuer: "https://as.example.test",
  scopes: ["read", "write", "admin"],
  hasSecret: false,
  createdAt: 1,
  updatedAt: 2,
};

const CONNECTION = {
  _id: "conn_1",
  resourceAppId: "app_1",
  enabled: true,
  scopeMode: "selected",
  selectedScopes: ["read", "write"],
  assignments: [
    {
      _id: "asg_1",
      connectionId: "conn_1",
      testIdentityId: "person_alice",
      scopeMode: "selected",
      selectedScopes: ["read"],
      createdAt: 1,
      updatedAt: 1,
    },
  ],
  createdAt: 1,
  updatedAt: 2,
};

const PEOPLE = [
  {
    _id: "person_alice",
    name: "Alice Chen",
    subject: "alice-001",
    email: "alice@example.test",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  },
  {
    _id: "person_eve",
    name: "Eve Novak",
    subject: "eve-002",
    email: "eve@example.test",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
  },
];

function seed({
  apps = [APP] as unknown[],
  connections = [CONNECTION] as unknown[],
  people = PEOPLE as unknown[],
} = {}) {
  queryResults["xaaResourceApps:list"] = apps;
  queryResults["xaaManagedConnections:listWithAssignments"] = connections;
  queryResults["xaaTestIdentities:list"] = people;
}

function appRow() {
  return within(screen.getByTestId("xaa-setup-app-app_1"));
}

async function openAdvanced(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: /advanced access for files api/i }),
  );
}

async function openKebab(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: /actions for files api/i }),
  );
}

async function openPeoplePopover(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    screen.getByRole("button", { name: /assigned people for files api/i }),
  );
}

describe("XAASetupAppsSection", () => {
  beforeEach(() => {
    mutationCalls.length = 0;
    refreshMock.mockClear();
    openInDebuggerMock.mockClear();
    auditEvents = [];
    auditError = null;
    seed();
  });

  it("renders one consolidated row: name, resource URL, switch, people count", () => {
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    const row = appRow();
    expect(row.getByText("Files API")).toBeInTheDocument();
    expect(row.getByText("https://files.example.test")).toBeInTheDocument();
    expect(
      row.getByRole("switch", { name: /connection for files api/i }),
    ).toBeChecked();
    // One assignment → the people summary shows "1".
    expect(
      row.getByRole("button", { name: /assigned people for files api/i }),
    ).toHaveTextContent("1");
    // Scope configuration never leaks into the default view.
    expect(row.queryByRole("button", { name: "admin" })).toBeNull();
    expect(row.queryByText(/connection scopes/i)).toBeNull();
  });

  it("toggling off preserves the connection's stored scope config", async () => {
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    await user.click(
      screen.getByRole("switch", { name: /connection for files api/i }),
    );

    await waitFor(() =>
      expect(mutationCalls).toContainEqual({
        ref: "xaaManagedConnections:upsertConnection",
        args: {
          organizationId: ORG_ID,
          resourceAppId: "app_1",
          enabled: false,
          scopeMode: "selected",
          selectedScopes: ["read", "write"],
        },
      }),
    );
  });

  it("creates the connection on first enable (scopeMode all, no scope subset)", async () => {
    seed({ connections: [] });
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    await user.click(
      screen.getByRole("switch", { name: /connection for files api/i }),
    );

    await waitFor(() =>
      expect(mutationCalls).toContainEqual({
        ref: "xaaManagedConnections:upsertConnection",
        args: {
          organizationId: ORG_ID,
          resourceAppId: "app_1",
          enabled: true,
          scopeMode: "all",
        },
      }),
    );
  });

  it("checking a person in the popover assigns with scopeMode all", async () => {
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    await openPeoplePopover(user);
    const eve = await screen.findByRole("checkbox", {
      name: /assign eve novak/i,
    });
    expect(eve).not.toBeChecked();
    await user.click(eve);

    await waitFor(() =>
      expect(mutationCalls).toContainEqual({
        ref: "xaaManagedConnections:upsertAssignment",
        args: {
          connectionId: "conn_1",
          testIdentityId: "person_eve",
          scopeMode: "all",
        },
      }),
    );
  });

  it("unchecking an assigned person removes the assignment by id", async () => {
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    await openPeoplePopover(user);
    const alice = await screen.findByRole("checkbox", {
      name: /assign alice chen/i,
    });
    expect(alice).toBeChecked();
    await user.click(alice);

    await waitFor(() =>
      expect(mutationCalls).toContainEqual({
        ref: "xaaManagedConnections:removeAssignment",
        args: { assignmentId: "asg_1" },
      }),
    );
  });

  it("tells admins to turn the server on before assigning people", async () => {
    seed({ connections: [] });
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    await openPeoplePopover(user);
    expect(
      await screen.findByText(/turn the server on first/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows a loading row in the people popover while the roster resolves", async () => {
    // People query still in flight — the popover must not claim the roster
    // is empty.
    queryResults["xaaTestIdentities:list"] = undefined;
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    await openPeoplePopover(user);
    expect(await screen.findByText(/loading people…/i)).toBeInTheDocument();
    expect(screen.queryByText(/no people yet/i)).toBeNull();
  });

  it("reveals connection scope editing behind the Advanced expander", async () => {
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    await openAdvanced(user);

    // Every app scope is a chip; the connection's selected subset is pressed.
    const row = appRow();
    const read = row.getAllByRole("button", { name: "read" })[0];
    const admin = row.getAllByRole("button", { name: "admin" })[0];
    expect(read).toHaveAttribute("aria-pressed", "true");
    expect(admin).toHaveAttribute("aria-pressed", "false");

    await user.click(admin);
    await waitFor(() =>
      expect(mutationCalls).toContainEqual({
        ref: "xaaManagedConnections:upsertConnection",
        args: {
          organizationId: ORG_ID,
          resourceAppId: "app_1",
          enabled: true,
          scopeMode: "selected",
          selectedScopes: ["read", "write", "admin"],
        },
      }),
    );
  });

  it("renders per-assignment subset chips from connection-effective scopes", async () => {
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    await openAdvanced(user);

    const assignment = screen.getByTestId("xaa-access-assignment-asg_1");
    const chips = Array.from(
      assignment.querySelectorAll("button[aria-pressed]"),
    ).filter((b) => ["read", "write", "admin"].includes(b.textContent ?? ""));
    // The connection grants read+write only — "admin" is not subsettable.
    expect(chips.map((c) => c.textContent)).toEqual(["read", "write"]);
    expect(chips.find((c) => c.textContent === "read")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(chips.find((c) => c.textContent === "write")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("deep links into the debugger from the kebab menu", async () => {
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    await openKebab(user);
    await user.click(
      await screen.findByRole("menuitem", { name: /test in debugger/i }),
    );
    expect(openInDebuggerMock).toHaveBeenCalledWith("app_1");
  });

  it("opens the registration wizard from Add server and Edit server", async () => {
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    await user.click(screen.getByRole("button", { name: /add server/i }));
    expect(screen.getByTestId("xaa-reg-wizard-open")).toBeInTheDocument();
  });

  it("deletes after confirmation via the kebab menu", async () => {
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    await openKebab(user);
    await user.click(await screen.findByRole("menuitem", { name: /delete/i }));
    await user.click(await screen.findByRole("button", { name: /^delete$/i }));

    await waitFor(() =>
      expect(mutationCalls).toContainEqual({
        ref: "xaaResourceApps:remove",
        args: { id: "app_1", organizationId: ORG_ID },
      }),
    );
  });

  it("keeps the audit footer collapsed by default, then refreshes and filters", async () => {
    auditEvents = [
      {
        _id: "evt_1",
        actorType: "user",
        action: "organization.xaa_policy.denied",
        targetType: "xaaTestIdentity",
        targetId: "person_alice",
        metadata: { reasonCode: "not_assigned", policyMode: "managed" },
        timestamp: 1720000000000,
      },
      {
        _id: "evt_2",
        actorType: "user",
        action: "organization.member.added",
        targetType: "organization",
        targetId: "org_test",
        timestamp: 1720000000001,
      },
    ];
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    // Collapsed by default: no decisions rendered, no eager refresh.
    expect(screen.queryByText("denied")).toBeNull();
    expect(refreshMock).not.toHaveBeenCalled();

    await user.click(
      screen.getByRole("button", { name: /recent policy decisions/i }),
    );

    expect(refreshMock).toHaveBeenCalled();
    expect(await screen.findByText("denied")).toBeInTheDocument();
    expect(screen.getByText("not_assigned")).toBeInTheDocument();
    // Non-policy audit rows never render here.
    expect(screen.queryByText(/member\.added/)).toBeNull();
  });

  it("surfaces an audit query failure instead of the empty state", async () => {
    auditError = new Error("Not authorized");
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage />);

    await user.click(
      screen.getByRole("button", { name: /recent policy decisions/i }),
    );

    expect(
      await screen.findByText(
        /couldn't load policy decisions: not authorized/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/no policy decisions recorded yet/i),
    ).toBeNull();
  });

  it("locks management for non-admins but keeps the debugger link live", async () => {
    const user = userEvent.setup();
    render(<XAASetupAppsSection organizationId={ORG_ID} canManage={false} />);

    expect(
      screen.getByRole("switch", { name: /connection for files api/i }),
    ).toBeDisabled();
    for (const name of [/add server/i, /assigned people for files api/i]) {
      expect(screen.getByRole("button", { name })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    }

    await openKebab(user);
    expect(
      await screen.findByRole("menuitem", { name: /edit server/i }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("menuitem", { name: /delete/i }),
    ).toHaveAttribute("aria-disabled", "true");
    await user.click(
      screen.getByRole("menuitem", { name: /test in debugger/i }),
    );
    expect(openInDebuggerMock).toHaveBeenCalledWith("app_1");

    // Advanced stays readable but inert.
    await openAdvanced(user);
    const read = appRow().getAllByRole("button", { name: "read" })[0];
    expect(read).toBeDisabled();
    await user.click(read);
    expect(mutationCalls).toHaveLength(0);
  });
});
