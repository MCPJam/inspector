import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { XAASetupPeopleSection } from "../XAASetupPeopleSection";

vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));

// Mock at the convex/react boundary (not the hooks) so these tests prove the
// hooks call the RIGHT string refs with the RIGHT args — the hand-mirrored
// wire contract is the thing under test.
const queryResults: Record<string, unknown> = {};
const mutationCalls: Array<{ ref: string; args: unknown }> = [];
const mutationImpls: Record<string, (args: unknown) => Promise<unknown>> = {};
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: (ref: string, args: unknown) =>
    args === "skip" ? undefined : queryResults[ref],
  useMutation: (ref: string) => async (args: unknown) => {
    mutationCalls.push({ ref, args });
    const impl = mutationImpls[ref];
    return impl ? impl(args) : {};
  },
  // Imported (not called) via the LockedIconButton reuse chain.
  useAction: (ref: string) => async (args: unknown) => {
    mutationCalls.push({ ref, args });
    return {};
  },
}));

// Avoid the chatboxes import chain — only the avatar is borrowed from it.
vi.mock("@/components/chatboxes/personas", () => ({
  CharacterAvatar: ({ name }: { name: string }) => (
    <span data-testid="avatar">{name[0]}</span>
  ),
}));

// PersonForm is reused with submitOverride, so the project mutations are
// never exercised here; stub the module to avoid its import chain.
vi.mock("@/hooks/useXaaPeople", () => ({
  useXaaPeopleMutations: () => ({
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
}));

vi.mock("@/hooks/useProjects", () => ({
  useProjectQueries: () => ({
    sortedProjects: [
      { _id: "proj_alpha", name: "Alpha", organizationId: "org_test" },
    ],
    projects: [],
    allProjects: [],
    isLoading: false,
    hasProjects: true,
    hasAnyProjects: true,
  }),
}));

const ORG_ID = "org_test";

const alice = {
  _id: "person_alice",
  name: "Alice Chen",
  subject: "alice-001",
  email: "alice@example.test",
  status: "active",
  createdAt: 1,
  updatedAt: 2,
};
const sam = {
  _id: "person_sam",
  name: "Sam Rivera",
  subject: "sam-002",
  email: "sam@example.test",
  status: "suspended",
  createdAt: 1,
  updatedAt: 2,
};

function seedQueries({ people = [alice, sam], connections = [] as unknown[] } = {}) {
  queryResults["xaaTestIdentities:list"] = people;
  queryResults["xaaManagedConnections:listWithAssignments"] = connections;
}

describe("XAASetupPeopleSection", () => {
  beforeEach(() => {
    mutationCalls.length = 0;
    for (const key of Object.keys(mutationImpls)) delete mutationImpls[key];
    seedQueries();
  });

  it("renders the roster with suspended people visually distinct", () => {
    render(<XAASetupPeopleSection organizationId={ORG_ID} canManage />);

    expect(screen.getByText("Alice Chen")).toBeInTheDocument();
    expect(screen.getByText("Sam Rivera")).toBeInTheDocument();
    expect(screen.getByText("Suspended")).toBeInTheDocument();
    expect(screen.getByTestId("xaa-setup-person-person_sam")).toHaveClass(
      "opacity-70",
    );
  });

  it("shows per-person assigned-app counts from the connections join", () => {
    seedQueries({
      connections: [
        {
          _id: "conn_1",
          resourceAppId: "app_1",
          enabled: true,
          scopeMode: "all",
          assignments: [
            {
              _id: "asg_1",
              connectionId: "conn_1",
              testIdentityId: "person_alice",
              scopeMode: "all",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
    render(<XAASetupPeopleSection organizationId={ORG_ID} canManage />);

    expect(screen.getByText("Assigned to 1 app")).toBeInTheDocument();
    expect(screen.getByText("Not assigned to any app")).toBeInTheDocument();
  });

  it("creates an org person through the reused PersonForm", async () => {
    const user = userEvent.setup();
    render(<XAASetupPeopleSection organizationId={ORG_ID} canManage />);

    await user.click(screen.getByRole("button", { name: /add person/i }));
    await user.type(await screen.findByLabelText(/name/i), "Nia Park");
    await user.type(screen.getByLabelText(/subject/i), "nia-003");
    await user.type(screen.getByLabelText(/email/i), "nia@example.test");
    const save = screen
      .getAllByRole("button", { name: /add person/i })
      .find((button) => button.getAttribute("type") === "submit")!;
    await user.click(save);

    await waitFor(() =>
      expect(mutationCalls).toContainEqual({
        ref: "xaaTestIdentities:create",
        args: {
          organizationId: ORG_ID,
          name: "Nia Park",
          subject: "nia-003",
          email: "nia@example.test",
        },
      }),
    );
  });

  it("updates without a subject arg (immutable) and locks the field", async () => {
    const user = userEvent.setup();
    render(<XAASetupPeopleSection organizationId={ORG_ID} canManage />);

    await user.click(screen.getByRole("button", { name: /edit alice chen/i }));
    const subjectInput = await screen.findByLabelText(/subject/i);
    expect(subjectInput).toBeDisabled();

    const nameInput = screen.getByLabelText(/name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Alice C.");
    await user.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(mutationCalls).toContainEqual({
        ref: "xaaTestIdentities:update",
        args: {
          testIdentityId: "person_alice",
          name: "Alice C.",
          email: "alice@example.test",
        },
      }),
    );
  });

  it("suspends and reactivates through setStatus", async () => {
    const user = userEvent.setup();
    render(<XAASetupPeopleSection organizationId={ORG_ID} canManage />);

    await user.click(
      screen.getByRole("button", { name: /suspend alice chen/i }),
    );
    await waitFor(() =>
      expect(mutationCalls).toContainEqual({
        ref: "xaaTestIdentities:setStatus",
        args: { testIdentityId: "person_alice", status: "suspended" },
      }),
    );

    await user.click(
      screen.getByRole("button", { name: /reactivate sam rivera/i }),
    );
    await waitFor(() =>
      expect(mutationCalls).toContainEqual({
        ref: "xaaTestIdentities:setStatus",
        args: { testIdentityId: "person_sam", status: "active" },
      }),
    );
  });

  it("archives after confirmation", async () => {
    const user = userEvent.setup();
    render(<XAASetupPeopleSection organizationId={ORG_ID} canManage />);

    await user.click(
      screen.getByRole("button", { name: /archive alice chen/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: /^archive$/i }),
    );

    await waitFor(() =>
      expect(mutationCalls).toContainEqual({
        ref: "xaaTestIdentities:archive",
        args: { testIdentityId: "person_alice" },
      }),
    );
  });

  it("imports a project's fixtures and reports the summary", async () => {
    mutationImpls["xaaTestIdentities:importFromProject"] = async () => ({
      imported: 2,
      skippedExisting: 1,
      skippedOverCap: 0,
    });
    const user = userEvent.setup();
    render(<XAASetupPeopleSection organizationId={ORG_ID} canManage />);

    await user.click(
      screen.getByRole("button", { name: /import from project/i }),
    );
    await user.click(await screen.findByRole("button", { name: /^import$/i }));

    await waitFor(() =>
      expect(mutationCalls).toContainEqual({
        ref: "xaaTestIdentities:importFromProject",
        args: { organizationId: ORG_ID, projectId: "proj_alpha" },
      }),
    );
    expect(
      await screen.findByText(/imported 2 · 1 already existed/i),
    ).toBeInTheDocument();
  });

  it("locks every management affordance for non-admins", async () => {
    const user = userEvent.setup();
    render(
      <XAASetupPeopleSection organizationId={ORG_ID} canManage={false} />,
    );

    for (const name of [
      /add person/i,
      /import from project/i,
      /edit alice chen/i,
      /suspend alice chen/i,
    ]) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAttribute("aria-disabled", "true");
      await user.click(button);
    }
    expect(mutationCalls).toHaveLength(0);
    // Locked clicks must not open the add/edit popovers either.
    expect(screen.queryByLabelText(/subject/i)).not.toBeInTheDocument();
  });
});
