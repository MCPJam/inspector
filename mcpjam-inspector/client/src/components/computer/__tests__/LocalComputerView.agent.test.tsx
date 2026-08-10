/**
 * The local face registers the SAME `surfaceId: "computer"` agent bridge as the
 * cloud ComputerView (only one is mounted at a time), but the cloud-lifecycle
 * verbs don't apply to the user's own machine — so they refuse with
 * `unsupported_in_mode` rather than vanishing from the catalog, and the
 * snapshot reports the local engine.
 */
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeInspectorCommand } from "@/lib/inspector-command-handlers";
import { readSurfaceSnapshot } from "@/lib/webmcp/surface-snapshot-registry";
import type {
  InspectorCommand,
  InspectorCommandResponse,
} from "@/shared/inspector-command.js";
import { LocalComputerView } from "../LocalComputerView";
import type { ComputerEngineState } from "@/hooks/useComputerEngine";

function engineState(): ComputerEngineState {
  return {
    engine: "local",
    selectedEngine: "local",
    setEngine: vi.fn(),
    resolved: true,
    localAvailable: true,
    localTerminalAvailable: false,
    workspaceDisplayRoot: "~/.mcpjam/computer",
    cloudAvailable: true,
    consent: {
      status: "granted",
      granted: true,
      token: "tok",
      grant: vi.fn(),
      revoke: vi.fn(),
    },
    toggleVisible: true,
  };
}

let seq = 0;
async function dispatch(command: Omit<InspectorCommand, "id">) {
  seq += 1;
  let response!: InspectorCommandResponse;
  await act(async () => {
    response = await executeInspectorCommand({
      ...command,
      id: `local-bridge-${seq}`,
    } as InspectorCommand);
  });
  return response;
}

describe("LocalComputerView — agent bridge", () => {
  beforeEach(() => {
    render(<LocalComputerView projectId="proj_1" engine={engineState()} />);
  });

  it.each([
    "startComputer",
    "hibernateComputer",
    "resetComputer",
    "deleteComputer",
  ] as const)("%s refuses with unsupported_in_mode on the local engine", async (type) => {
    const response = await dispatch({ type });
    expect(response).toMatchObject({
      status: "error",
      error: { code: "unsupported_in_mode" },
    });
    expect(JSON.stringify(response)).toMatch(/This machine/);
  });

  it("the snapshot reports the local engine and never a token", async () => {
    const snapshot = await readSurfaceSnapshot("computer");
    expect(snapshot).toMatchObject({
      ok: true,
      data: {
        engine: "local",
        consentGranted: true,
        terminalAvailable: false,
        workspaceDir: "~/.mcpjam/computer/proj_1",
      },
    });
    // The capability token must never appear in the snapshot.
    expect(JSON.stringify(snapshot).toLowerCase()).not.toContain("token");
  });
});
