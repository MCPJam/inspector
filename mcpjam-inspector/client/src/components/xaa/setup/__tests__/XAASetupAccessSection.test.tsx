import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { XAASetupAccessSection } from "../XAASetupAccessSection";

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
vi.mock("@/hooks/useOrganizationAudit", () => ({
  useOrganizationAudit: () => ({
    events: auditEvents,
    isLoading: false,
    error: null,
    refresh: refreshMock,
  }),
}));

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
  apps = [APP],
  connections = [CONNECTION] as unknown[],
  people = PEOPLE,
} = {}) {
  queryResults["xaaResourceApps:list"] = apps;
  queryResults["xaaManagedConnections:listWithAssignments"] = connections;
  queryResults["xaaTestIdentities:list"] = people;
}

async function expandApp(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /expand files api/i }));
}

describe("XAASetupAccessSection", () => {
  beforeEach(() => {
    mutationCalls.length = 0;
    refreshMock.mockClear();
    auditEvents = [];
    seed();
  });

  it("renders connection scope chips from the app's scope catalog", async () => {
    const user = userEvent.setup();
    render(<XAASetupAccessSection organizationId={ORG_ID} canManage />);

    await expandApp(user);

    // Every app scope is a chip; the connection's selected subset is pressed.
    const read = screen.getAllByRole("button", { name: "read" })[0];
    const write = screen.getAllByRole("button", { name: "write" })[0];
    const admin = screen.getAllByRole("button", { name: "admin" })[0];
    expect(read).toHaveAttribute("aria-pressed", "true");
    expect(write).toHaveAttribute("aria-pressed", "true");
    expect(admin).toHaveAttribute("aria-pressed", "false");
  });

  it("toggles the connection through upsertConnection with the full row", async () => {
    const user = userEvent.setup();
    render(<XAASetupAccessSection organizationId={ORG_ID} canManage />);

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

  it("creates a connection on first enable (scopeMode all)", async () => {
    seed({ connections: [] });
    const user = userEvent.setup();
    render(<XAASetupAccessSection organizationId={ORG_ID} canManage />);

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

  it("narrows the connection subset by toggling a scope chip", async () => {
    const user = userEvent.setup();
    render(<XAASetupAccessSection organizationId={ORG_ID} canManage />);

    await expandApp(user);
    await user.click(screen.getAllByRole("button", { name: "admin" })[0]);

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
    render(<XAASetupAccessSection organizationId={ORG_ID} canManage />);

    await expandApp(user);

    const assignment = screen.getByTestId("xaa-access-assignment-asg_1");
    const chips = Array.from(
      assignment.querySelectorAll("button[aria-pressed]"),
    ).filter((b) => ["read", "write", "admin"].includes(b.textContent ?? ""));
    // The connection grants read+write only — "admin" is not subsettable.
    expect(chips.map((c) => c.textContent)).toEqual(["read", "write"]);
    expect(
      chips.find((c) => c.textContent === "read"),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      chips.find((c) => c.textContent === "write"),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("assigns an unassigned person with scopeMode all", async () => {
    const user = userEvent.setup();
    render(<XAASetupAccessSection organizationId={ORG_ID} canManage />);

    await expandApp(user);
    await user.click(screen.getByRole("button", { name: /assign person/i }));
    // Alice is already assigned; only Eve is offered (anchored: the row's
    // "Remove Alice Chen" button must not match).
    expect(screen.queryByRole("button", { name: /^alice chen$/i })).toBeNull();
    await user.click(await screen.findByRole("button", { name: /eve novak/i }));

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

  it("removes an assignment by id", async () => {
    const user = userEvent.setup();
    render(<XAASetupAccessSection organizationId={ORG_ID} canManage />);

    await expandApp(user);
    await user.click(
      screen.getByRole("button", { name: /remove alice chen/i }),
    );

    await waitFor(() =>
      expect(mutationCalls).toContainEqual({
        ref: "xaaManagedConnections:removeAssignment",
        args: { assignmentId: "asg_1" },
      }),
    );
  });

  it("refreshes and filters the audit footer to policy decisions", async () => {
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
    render(<XAASetupAccessSection organizationId={ORG_ID} canManage />);

    await user.click(
      screen.getByRole("button", { name: /recent policy decisions/i }),
    );

    expect(refreshMock).toHaveBeenCalled();
    expect(await screen.findByText("denied")).toBeInTheDocument();
    expect(screen.getByText("not_assigned")).toBeInTheDocument();
    // Non-policy audit rows never render here.
    expect(screen.queryByText(/member\.added/)).toBeNull();
  });

  it("is inert for non-admins", async () => {
    const user = userEvent.setup();
    render(
      <XAASetupAccessSection organizationId={ORG_ID} canManage={false} />,
    );

    expect(
      screen.getByRole("switch", { name: /connection for files api/i }),
    ).toBeDisabled();

    await expandApp(user);
    const read = screen.getAllByRole("button", { name: "read" })[0];
    expect(read).toBeDisabled();
    await user.click(read);
    expect(mutationCalls).toHaveLength(0);
  });
});
