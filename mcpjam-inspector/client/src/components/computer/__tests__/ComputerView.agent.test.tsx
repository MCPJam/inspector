/**
 * ComputerView agent bridge handlers (S5). Commands are dispatched through the
 * real command bus against a mounted ComputerView; the lifecycle action hooks
 * and status are mocked so the handlers act through the SAME reserve / hibernate
 * / reset / delete callbacks the buttons use, behind the SAME gates.
 *
 * Findings this pins:
 * - start reserves through the same path and honors the daily cap: a cap
 *   rejection comes back as execution_failed naming the cap, NEVER a bypass;
 * - hibernate/reset/delete map to their hooks;
 * - unavailable (no data plane, or signed out) → unsupported_in_mode with the
 *   action hook never called;
 * - the snapshot reports redacted status and never a terminal token.
 */
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeInspectorCommand } from "@/lib/inspector-command-handlers";
import { readSurfaceSnapshot } from "@/lib/webmcp/surface-snapshot-registry";
import type {
  ComputerView as ComputerViewModel,
} from "@/hooks/useProjectComputer";
import type {
  InspectorCommand,
  InspectorCommandResponse,
} from "@/shared/inspector-command.js";

const reserve = vi.fn(async () => ({ status: "requested" }) as never);
const deleteComputer = vi.fn(async () => ({ deleted: true }));
const hibernateComputer = vi.fn(async () => ({ hibernated: true }));
const resetComputer = vi.fn(async () => ({ reset: true }));
const mintToken = vi.fn(async () => ({ token: "SECRET-TERMINAL-TOKEN" }) as never);

let mockStatus: ComputerViewModel | null | undefined;
let mockDataPlane:
  | { localConfigured: boolean; remoteDataPlaneUrl: string | null }
  | undefined;

vi.mock("@/hooks/useProjectComputer", () => ({
  useComputerStatus: () => mockStatus,
  useComputerUsage: () => undefined,
  useReserveComputer: () => reserve,
  useDeleteComputer: () => deleteComputer,
  useHibernateComputer: () => hibernateComputer,
  useMintTerminalToken: () => mintToken,
  useComputersDataPlaneConfig: () => mockDataPlane,
}));

vi.mock("@/hooks/useComputerEnvironments", () => ({
  useEnvironments: () => [{ environmentId: "env-1", name: "My Image" }],
  useResetComputer: () => resetComputer,
}));

vi.mock("../EnvironmentsDrawer", () => ({
  EnvironmentsDrawer: ({ open }: { open: boolean }) =>
    open ? <div data-testid="env-drawer" /> : null,
}));

vi.mock("@/stores/preferences/preferences-provider", () => ({
  usePreferencesStore: (sel: (s: { themeMode: string }) => unknown) =>
    sel({ themeMode: "dark" }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../ComputerTerminal", () => ({
  ComputerTerminal: () => <div data-testid="terminal-stub" />,
}));

import { ComputerView } from "../ComputerView";

let commandSeq = 0;
async function dispatch(command: Omit<InspectorCommand, "id">) {
  commandSeq += 1;
  let response!: InspectorCommandResponse;
  await act(async () => {
    response = await executeInspectorCommand({
      ...command,
      id: `computer-bridge-${commandSeq}`,
    } as InspectorCommand);
  });
  return response;
}

function renderComputer(props?: {
  isAuthenticated?: boolean;
  projectId?: string | null;
}) {
  render(
    <ComputerView
      projectId={props?.projectId ?? "proj-1"}
      isAuthenticated={props?.isAuthenticated ?? true}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStatus = { computerId: "c-1", status: "ready", provider: "e2b" };
  // Default: this server IS a data plane (computers available here).
  mockDataPlane = { localConfigured: true, remoteDataPlaneUrl: null };
  reserve.mockResolvedValue({ status: "requested" } as never);
});

describe("ComputerView — agent bridge handlers", () => {
  it("startComputer reserves through the same path (no terminal opened)", async () => {
    renderComputer();
    const response = await dispatch({ type: "startComputer" });
    expect(response).toMatchObject({
      status: "success",
      result: { status: "computer_starting" },
    });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(reserve).toHaveBeenCalledWith({ projectId: "proj-1" });
  });

  it("startComputer honors the daily cap: a cap rejection → execution_failed naming the cap", async () => {
    // The backend enforces the daily start cap on reserve; mirror the button,
    // which just reserves and reports the cap.
    renderComputer();
    reserve.mockRejectedValueOnce(
      new Error(
        JSON.stringify({
          code: "billing_limit_reached",
          limitName: "computerStartsPerDay",
          allowedValue: 5,
        }),
      ),
    );
    const response = await dispatch({ type: "startComputer" });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "execution_failed" },
    });
    expect(
      (response as { error: { message: string } }).error.message,
    ).toContain("Daily computer limit reached");
    // Reserve WAS attempted (there's no client-side pre-check) but nothing was
    // bypassed — the error propagates.
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it("hibernate/reset/delete map to their hooks", async () => {
    renderComputer();
    const hib = await dispatch({ type: "hibernateComputer" });
    expect(hib).toMatchObject({
      status: "success",
      result: { status: "computer_hibernating", hibernated: true },
    });
    expect(hibernateComputer).toHaveBeenCalledWith({ projectId: "proj-1" });

    const reset = await dispatch({ type: "resetComputer" });
    expect(reset).toMatchObject({
      status: "success",
      result: { status: "computer_resetting", reset: true },
    });
    expect(resetComputer).toHaveBeenCalledWith({ projectId: "proj-1" });

    const del = await dispatch({ type: "deleteComputer" });
    expect(del).toMatchObject({
      status: "success",
      result: { status: "computer_deleted", deleted: true },
    });
    expect(deleteComputer).toHaveBeenCalledWith({ projectId: "proj-1" });
  });

  it("refuses every command as unsupported_in_mode when signed out (hooks never called)", async () => {
    renderComputer({ isAuthenticated: false });
    for (const type of [
      "startComputer",
      "hibernateComputer",
      "resetComputer",
      "deleteComputer",
    ] as const) {
      const response = await dispatch({ type });
      expect(response, type).toMatchObject({
        status: "error",
        error: { code: "unsupported_in_mode" },
      });
    }
    expect(reserve).not.toHaveBeenCalled();
    expect(hibernateComputer).not.toHaveBeenCalled();
    expect(resetComputer).not.toHaveBeenCalled();
    expect(deleteComputer).not.toHaveBeenCalled();
  });

  it("refuses commands as unsupported_in_mode when computers are unavailable here", async () => {
    // No local data plane AND no remote to delegate to ⇒ dataPlaneUnavailable.
    mockDataPlane = { localConfigured: false, remoteDataPlaneUrl: null };
    renderComputer();
    const response = await dispatch({ type: "startComputer" });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "unsupported_in_mode" },
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("snapshot reports redacted status and NEVER a terminal token", async () => {
    mockStatus = {
      computerId: "c-1",
      status: "ready",
      provider: "e2b",
      environmentId: "env-1",
    };
    renderComputer();
    const snapshot = await readSurfaceSnapshot("computer");
    expect(snapshot).toMatchObject({
      ok: true,
      data: {
        status: "ready",
        hasComputer: true,
        isReady: true,
        environment: { id: "env-1", name: "My Image" },
        terminalOpen: false,
      },
    });
    // The terminal token must never appear anywhere in the snapshot.
    expect(JSON.stringify(snapshot)).not.toContain("SECRET-TERMINAL-TOKEN");
    expect(JSON.stringify(snapshot).toLowerCase()).not.toContain("token");
  });

  it("snapshot is gated (no state leak) when computers are unavailable", async () => {
    mockDataPlane = { localConfigured: false, remoteDataPlaneUrl: null };
    renderComputer();
    const snapshot = await readSurfaceSnapshot("computer");
    expect(snapshot).toMatchObject({ ok: true, data: { gated: true } });
  });

  it("does NOT reserve/bill while the data-plane config is still loading", async () => {
    // dataPlane undefined = config unresolved: dataPlaneUnavailable is false,
    // but we must not reach reserve() before we know a data plane exists.
    mockDataPlane = undefined;
    renderComputer();
    const response = await dispatch({ type: "startComputer" });
    // Retryable, not "unsupported" — the config just hasn't landed yet.
    expect(response).toMatchObject({
      status: "error",
      error: { code: "execution_failed" },
    });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("refuses reset from a non-resettable status (same gate as the disabled button)", async () => {
    mockStatus = { computerId: "c-1", status: "provisioning", provider: "e2b" };
    renderComputer();
    const response = await dispatch({ type: "resetComputer" });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "execution_failed" },
    });
    // The destructive wipe/rebuild mutation is never invoked from this state.
    expect(resetComputer).not.toHaveBeenCalled();
  });

  it("snapshot never passes raw provider error text into the transcript", async () => {
    mockStatus = {
      computerId: "c-1",
      status: "error",
      provider: "e2b",
      lastError: "auth failed token=SECRET-abc123 at https://internal.example/vm",
    } as ComputerViewModel;
    renderComputer();
    const snapshot = await readSurfaceSnapshot("computer");
    expect(snapshot).toMatchObject({ ok: true, data: { hasError: true } });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("SECRET-abc123");
    expect(serialized).not.toContain("internal.example");
  });
});
