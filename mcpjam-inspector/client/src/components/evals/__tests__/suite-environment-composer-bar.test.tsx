/**
 * The suite header's target bar, in both write modes.
 *
 * What this pins:
 *  - a suite with no project keeps writing the legacy axes, because environments
 *    are project-scoped and no flag changes that;
 *  - a legacy suite in an environment-capable project shows what it already
 *    runs, WITHOUT writing anything, and the first edit converts it;
 *  - edits resolve before they write, so a resolve failure never leaves a
 *    half-updated suite;
 *  - backend rejections (schedule pins especially) reach the user verbatim;
 *  - an archived attachment blocks edits instead of being silently dropped.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalSuite } from "../types";

const {
  flags,
  environmentsRef,
  ensureAdhocMock,
  setSuiteEnvironmentsMock,
  onUpdateMock,
  toastError,
} = vi.hoisted(() => ({
  flags: { environments: true },
  environmentsRef: { current: [] as any[] },
  ensureAdhocMock: vi.fn(),
  setSuiteEnvironmentsMock: vi.fn(async () => ({})),
  onUpdateMock: vi.fn(async () => {}),
  toastError: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: () => setSuiteEnvironmentsMock,
  useConvexAuth: () => ({ isAuthenticated: true }),
  useConvex: () => ({
    query: vi.fn(async () => ({ modelMatrix: false })),
  }),
}));

vi.mock("@/hooks/useProjectEnvironmentsEnabled", () => ({
  useProjectEnvironmentsEnabled: () => flags.environments,
}));
vi.mock("@/hooks/useSkillsEnabled", () => ({
  useSkillsEnabled: () => false,
}));
vi.mock("@/hooks/useComputersEnabled", () => ({
  useComputersEnabled: () => false,
}));
vi.mock("@/hooks/useProjectEnvironments", () => ({
  useProjectEnvironments: (projectId: string | null) =>
    projectId ? environmentsRef.current : undefined,
  useEnsureAdhocEnvironments: () => ensureAdhocMock,
  useModelMatrixCapability: () => false,
}));
vi.mock("@/hooks/useClients", () => ({
  useHostList: () => ({
    hosts: [
      { hostId: "host-1", name: "Claude" },
      { hostId: "host-2", name: "Cursor" },
    ],
    isLoading: false,
  }),
}));
vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: () => <div data-testid="server-group-picker" />,
}));
vi.mock("@/components/project-environments/environment-picker", () => ({
  MAX_SUITE_ENVIRONMENTS: 10,
  EnvironmentPicker: ({ triggerTestId }: { triggerTestId?: string }) => (
    <button type="button" data-testid={triggerTestId} />
  ),
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: toastError },
}));
vi.mock("@/lib/app-navigation", () => ({
  navigateApp: vi.fn(),
  buildHostComparePath: () => "/hosts/compare",
  routePaths: { hosts: "/hosts", environments: "/environments" },
}));

import { SuiteEnvironmentComposerBar } from "../suite-environment-composer-bar";

const suite = (over: Partial<EvalSuite> = {}): EvalSuite =>
  ({
    _id: "suite-1",
    name: "Checkout",
    projectId: "proj-1",
    ...over,
  }) as EvalSuite;

function renderBar(over: Partial<EvalSuite> = {}, props: any = {}) {
  render(
    <SuiteEnvironmentComposerBar
      suite={suite(over)}
      onUpdate={onUpdateMock}
      onUpdateServerAttachment={vi.fn()}
      {...props}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` clears CALLS, not implementations — a `mockRejectedValue`
  // from an earlier case would otherwise leak into every case after it.
  setSuiteEnvironmentsMock.mockResolvedValue({});
  flags.environments = true;
  environmentsRef.current = [];
  ensureAdhocMock.mockImplementation(
    async (args: { stacks: Array<{ hostId: string }> }) =>
      args.stacks.map((stack) => ({
        environment: {
          environmentId: `adhoc-${stack.hostId}`,
          projectId: "proj-1",
          hostId: stack.hostId,
          origin: "adhoc",
          revision: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        created: true,
      })),
  );
});

describe("SuiteEnvironmentComposerBar — environment mode", () => {
  it("seeds a legacy suite from what it runs today, and writes nothing", () => {
    renderBar({
      hostAttachments: [
        { namedHostId: "host-1", enabledOptionalServerIds: [] },
      ] as any,
    });

    // Seeding is display only — a suite must not convert just by being looked at.
    expect(setSuiteEnvironmentsMock).not.toHaveBeenCalled();
    expect(ensureAdhocMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("suite-env-clients-picker")).toHaveTextContent(
      /claude/i,
    );
  });

  it("converts a legacy suite on the first edit", async () => {
    renderBar({
      hostAttachments: [
        { namedHostId: "host-1", enabledOptionalServerIds: [] },
      ] as any,
    });

    fireEvent.click(screen.getByTestId("suite-env-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^cursor$/i }));

    await waitFor(() => expect(setSuiteEnvironmentsMock).toHaveBeenCalled());
    // Both clients: the seeded one plus the edit — converting must not drop
    // what the suite was already running.
    expect(ensureAdhocMock).toHaveBeenCalledWith({
      projectId: "proj-1",
      stacks: [{ hostId: "host-1" }, { hostId: "host-2" }],
    });
    expect(setSuiteEnvironmentsMock).toHaveBeenCalledWith({
      suiteId: "suite-1",
      environmentIds: ["adhoc-host-1", "adhoc-host-2"],
    });
    // The legacy client write is NOT also fired — one axis per mode.
    expect(onUpdateMock).not.toHaveBeenCalled();
  });

  it("resolves before writing, so a failed resolve leaves the suite alone", async () => {
    ensureAdhocMock.mockRejectedValue(
      Object.assign(new Error("nope"), {
        data: { message: "Pinning plugin versions requires an admin." },
      }),
    );
    renderBar();

    fireEvent.click(screen.getByTestId("suite-env-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^claude$/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(setSuiteEnvironmentsMock).not.toHaveBeenCalled();
    expect(toastError.mock.calls[0][0]).toMatch(/requires an admin/i);
  });

  it("surfaces a backend rejection verbatim and rolls the strip back", async () => {
    setSuiteEnvironmentsMock.mockRejectedValue(
      Object.assign(new Error("nope"), {
        data: {
          message:
            'Environment "Alpha" is pinned by an enabled schedule. Disable it first.',
        },
      }),
    );
    renderBar();

    fireEvent.click(screen.getByTestId("suite-env-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^claude$/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0][0]).toMatch(/pinned by an enabled schedule/i);
    await waitFor(() =>
      expect(screen.getByTestId("suite-env-clients-picker")).toHaveTextContent(
        /pick/i,
      ),
    );
  });

  it("blocks edits while an attachment is archived, rather than dropping it", () => {
    environmentsRef.current = [
      {
        environmentId: "env-live",
        projectId: "proj-1",
        name: "Alpha",
        hostId: "host-1",
        revision: 1,
      },
    ];
    renderBar({ environmentIds: ["env-live", "env-archived"] } as any);

    expect(screen.getByTestId("suite-env-unresolved-hint")).toBeInTheDocument();
    expect(screen.getByTestId("suite-env-clients-picker")).toBeDisabled();
  });

  it("waits for the environment list before allowing an edit", () => {
    // Resolving against an empty live list would miss a matching NAMED
    // environment and mint an unnamed twin of it.
    environmentsRef.current = undefined as any;
    renderBar({ environmentIds: ["env-live"] } as any);

    expect(screen.getByTestId("suite-env-clients-picker")).toBeDisabled();
    // ...and it must NOT claim the attachment is archived while merely loading.
    expect(
      screen.queryByTestId("suite-env-unresolved-hint"),
    ).not.toBeInTheDocument();
  });

  it("clears the field when the last environment is detached", async () => {
    environmentsRef.current = [
      {
        environmentId: "env-live",
        projectId: "proj-1",
        name: "Alpha",
        origin: "named",
        hostId: "host-1",
        revision: 1,
      },
    ];
    renderBar({ environmentIds: ["env-live"] } as any);

    // Clearing the clients leaves the composition with nowhere to run. That is
    // a legitimate "back to legacy" move, so it clears the field rather than
    // erroring on a composition with no target.
    fireEvent.click(screen.getByTestId("suite-env-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^claude$/i }));

    await waitFor(() => expect(setSuiteEnvironmentsMock).toHaveBeenCalled());
    expect(setSuiteEnvironmentsMock).toHaveBeenCalledWith({
      suiteId: "suite-1",
      environmentIds: null,
    });
    expect(ensureAdhocMock).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("blocks editing when two attachments share a client", () => {
    // The strip fans out over hostIds, so these two would resolve to ONE row.
    // Losing a target silently is worse than refusing the edit.
    environmentsRef.current = [
      {
        environmentId: "env-a",
        projectId: "proj-1",
        name: "A",
        origin: "named",
        hostId: "host-1",
        serverAttachmentId: "grp-1",
        revision: 1,
      },
      {
        environmentId: "env-b",
        projectId: "proj-1",
        name: "B",
        origin: "named",
        hostId: "host-1",
        serverAttachmentId: "grp-2",
        revision: 1,
      },
    ];
    renderBar({ environmentIds: ["env-a", "env-b"] } as any);

    expect(screen.getByTestId("suite-env-attachments-collapse-hint")).toBeInTheDocument();
    expect(screen.getByTestId("suite-env-clients-picker")).toBeDisabled();
  });

  it("blocks editing when a lone attachment pins a model the strip cannot show", () => {
    // `useModelMatrixCapability` is mocked false here, so there is no models
    // slot. One attachment means the attachments AGREE, so the collapse check
    // passes it — and seeding reads the absent slot as "client defaults", so
    // the first pill edit would resolve a row without the override and move
    // the suite onto another model without saying so.
    environmentsRef.current = [
      {
        environmentId: "env-a",
        projectId: "proj-1",
        name: "A",
        origin: "named",
        hostId: "host-1",
        modelId: "anthropic/claude-haiku-4.5",
        revision: 1,
      },
    ];
    renderBar({ environmentIds: ["env-a"] } as any);

    expect(
      screen.getByTestId("suite-env-attachments-collapse-hint"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("suite-env-clients-picker")).toBeDisabled();
  });

  it("leaves an inherit-only attachment editable", () => {
    // The guard must not fire on every environment — only ones carrying an
    // override the strip has nowhere to put.
    environmentsRef.current = [
      {
        environmentId: "env-a",
        projectId: "proj-1",
        name: "A",
        origin: "named",
        hostId: "host-1",
        revision: 1,
      },
    ];
    renderBar({ environmentIds: ["env-a"] } as any);

    expect(
      screen.queryByTestId("suite-env-attachments-collapse-hint"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("suite-env-clients-picker")).not.toBeDisabled();
  });
});

describe("SuiteEnvironmentComposerBar — legacy mode", () => {
  it("writes host attachments for a suite with no project", async () => {
    renderBar({
      projectId: undefined,
      hostAttachments: [
        { namedHostId: "host-1", enabledOptionalServerIds: [] },
      ] as any,
    });

    // No project ⇒ no environments to compose into; the strip still renders,
    // it just writes the fields this suite actually runs.
    expect(
      screen.queryByTestId("suite-env-environments-picker"),
    ).not.toBeInTheDocument();
    expect(setSuiteEnvironmentsMock).not.toHaveBeenCalled();
  });

  it("writes host attachments when project environments are off", async () => {
    flags.environments = false;
    renderBar({
      hostAttachments: [
        { namedHostId: "host-1", enabledOptionalServerIds: [] },
      ] as any,
    });

    fireEvent.click(screen.getByTestId("suite-env-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^cursor$/i }));

    await waitFor(() => expect(onUpdateMock).toHaveBeenCalled());
    expect(onUpdateMock).toHaveBeenCalledWith([
      { namedHostId: "host-1", enabledOptionalServerIds: [] },
      { namedHostId: "host-2", enabledOptionalServerIds: [] },
    ]);
    expect(setSuiteEnvironmentsMock).not.toHaveBeenCalled();
  });

  it("refuses the last detach — a suite with no client cannot run", async () => {
    flags.environments = false;
    renderBar({
      hostAttachments: [
        { namedHostId: "host-1", enabledOptionalServerIds: [] },
      ] as any,
    });

    fireEvent.click(screen.getByTestId("suite-env-clients-picker"));
    fireEvent.click(screen.getByRole("checkbox", { name: /^claude$/i }));

    expect(onUpdateMock).not.toHaveBeenCalled();
  });

  it("is NOT editable for a suite that already attaches environments", () => {
    // `buildSuiteRunPlans` prefers environmentIds, so a legacy client write here
    // would report success and change nothing about what runs.
    flags.environments = false;
    renderBar({
      environmentIds: ["env-a"],
      hostAttachments: [
        { namedHostId: "host-1", hostName: "Claude", enabledOptionalServerIds: [] },
      ] as any,
    } as any);

    expect(
      screen.queryByTestId("suite-env-clients-picker"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
  });

  it("renders read-only when the caller says so", () => {
    flags.environments = false;
    renderBar(
      {
        hostAttachments: [
          { namedHostId: "host-1", hostName: "Claude", enabledOptionalServerIds: [] },
        ] as any,
      },
      { readOnly: true },
    );

    expect(
      screen.queryByTestId("suite-env-clients-picker"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Claude")).toBeInTheDocument();
  });
});
