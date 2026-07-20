/**
 * SwarmsTab agent bridge handlers (finding: launch must route through the SAME
 * gated launchJourneyRun path with the SAME per-launch idempotency key, and a
 * 402 must surface as a billing/quota `execution_failed` — never a bypass).
 *
 * Commands are dispatched through the real command bus against a mounted
 * SwarmsTab, mirroring EvalsTab.test.tsx. Convex reads/mutations and the launch
 * REST call are mocked; the persona is selected via the UI so the handlers see
 * the same query data the buttons do.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeInspectorCommand } from "@/lib/inspector-command-handlers";
import { readSurfaceSnapshot } from "@/lib/webmcp/surface-snapshot-registry";
import type {
  InspectorCommand,
  InspectorCommandResponse,
} from "@/shared/inspector-command.js";

const persona = {
  _id: "persona-1",
  personaId: "p1",
  name: "Persona One",
  role: "tester",
  notes: "",
};
const journey = {
  _id: "journey-1",
  personaRefId: "persona-1",
  goal: "Book a flight",
  hostIds: ["host-1"],
  config: { sessionsPerHost: 2, maxTurns: 6 },
};
const host = { hostId: "host-1", name: "Host One" };

const { createPersonaMutation } = vi.hoisted(() => ({
  createPersonaMutation: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: (name: string, args: unknown) => {
    if (args === "skip") return undefined;
    switch (name) {
      case "personas:listPersonas":
        return [persona];
      case "journeys:listJourneysByPersona":
        return [journey];
      case "hosts:listHosts":
        return [host];
      default:
        return undefined; // track record + rollup
    }
  },
  useMutation: (name: string) => {
    if (name === "personas:createPersona") return createPersonaMutation;
    return vi.fn().mockResolvedValue(undefined);
  },
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    loadMore: vi.fn(),
    isLoading: false,
  }),
}));

const launchJourneyRunMock = vi.fn();
vi.mock("@/lib/swarm-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/swarm-api")>();
  return {
    ...actual,
    launchJourneyRun: (...args: unknown[]) => launchJourneyRunMock(...args),
  };
});

vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: () => null,
}));
vi.mock("@/components/hosts/ServerGroupPicker", () => ({
  ServerGroupPicker: () => (
    <button type="button">No server group · pick one</button>
  ),
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: [],
    isLoading: false,
  }),
  useProjectServers: () => ({ servers: [], isLoading: false }),
  useDbUserReady: () => true,
}));
vi.mock("@/lib/chatbox-session", () => ({
  getShareableAppOrigin: () => "https://app.test",
}));
vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { SwarmsTab } from "../SwarmsTab";
import { LaunchJourneyRunError } from "@/lib/swarm-api";

let commandSeq = 0;
async function dispatch(command: Omit<InspectorCommand, "id">) {
  commandSeq += 1;
  let response!: InspectorCommandResponse;
  // Handlers call the component's own callbacks/setState, so the dispatch is a
  // React state update and belongs inside act().
  await act(async () => {
    response = await executeInspectorCommand({
      ...command,
      id: `swarms-bridge-${commandSeq}`,
    } as InspectorCommand);
  });
  return response;
}

function renderAndSelectPersona() {
  render(<SwarmsTab projectId="proj-1" isAuthenticated />);
  fireEvent.click(screen.getByText("Persona One"));
}

beforeEach(() => {
  vi.clearAllMocks();
  createPersonaMutation.mockResolvedValue({ _id: "persona-new" });
  launchJourneyRunMock.mockReset();
});

describe("SwarmsTab — agent bridge handlers", () => {
  it("createPersona commits directly through the persona mutation and selects it", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);

    const response = await dispatch({
      type: "createPersona",
      payload: { name: "Impatient buyer", role: "customer", notes: "hurried" },
    });

    expect(response).toMatchObject({
      status: "success",
      result: { status: "persona_created", personaId: "persona-new" },
    });
    expect(createPersonaMutation).toHaveBeenCalledWith({
      projectId: "proj-1",
      name: "Impatient buyer",
      role: "customer",
      notes: "hurried",
    });
  });

  it("createPersona rejects a missing role without touching the mutation", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);

    const response = await dispatch({
      type: "createPersona",
      payload: { name: "No role", role: "  " } as never,
    });

    expect(response).toMatchObject({
      status: "error",
      error: { code: "invalid_request" },
    });
    expect(createPersonaMutation).not.toHaveBeenCalled();
  });

  it("openJourneyForm opens the new-journey form with a goal prefill — no journey is created", async () => {
    renderAndSelectPersona();

    const response = await dispatch({
      type: "openJourneyForm",
      payload: { goal: "Book a flight to Tokyo" },
    });

    expect(response).toMatchObject({
      status: "success",
      result: { status: "form_opened", prefilledGoal: "Book a flight to Tokyo" },
    });
    // The form is now open with the goal seeded for the user to finish.
    await waitFor(() => {
      expect(
        screen.getByDisplayValue("Book a flight to Tokyo"),
      ).toBeInTheDocument();
    });
  });

  it("openJourneyForm rejects an unknown persona as invalid_request", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated />);

    const response = await dispatch({
      type: "openJourneyForm",
      payload: { persona: "Nobody" },
    });

    expect(response).toMatchObject({
      status: "error",
      error: { code: "invalid_request" },
    });
  });

  it("launchSwarmRun routes through launchJourneyRun with a launch key and reports the run id", async () => {
    launchJourneyRunMock.mockResolvedValue({ runId: "run-1" });
    renderAndSelectPersona();

    const response = await dispatch({
      type: "launchSwarmRun",
      payload: { journey: "Book a flight" },
    });

    expect(response).toMatchObject({
      status: "success",
      result: { status: "run_requested", journeyId: "journey-1", runId: "run-1" },
    });
    expect(launchJourneyRunMock).toHaveBeenCalledTimes(1);
    const arg = launchJourneyRunMock.mock.calls[0]![0] as {
      journeyId: string;
      projectId: string;
      launchKey: string;
    };
    expect(arg.journeyId).toBe("journey-1");
    expect(arg.projectId).toBe("proj-1");
    expect(typeof arg.launchKey).toBe("string");
    expect(arg.launchKey.length).toBeGreaterThan(0);
  });

  it("launchSwarmRun maps a 402 to a billing/quota execution_failed error", async () => {
    launchJourneyRunMock.mockRejectedValue(
      new LaunchJourneyRunError(402, "Swarm run limit reached"),
    );
    renderAndSelectPersona();

    const response = await dispatch({
      type: "launchSwarmRun",
      payload: { journey: "Book a flight" },
    });

    expect(response).toMatchObject({
      status: "error",
      error: { code: "execution_failed" },
    });
    const message = response.status === "error" ? response.error.message : "";
    expect(message).toMatch(/Swarm run limit reached/);
    expect(message).toMatch(/quota/i);
    expect(launchJourneyRunMock).toHaveBeenCalledTimes(1);
  });

  it("launchSwarmRun rejects an unknown journey without calling the launch path", async () => {
    renderAndSelectPersona();

    const response = await dispatch({
      type: "launchSwarmRun",
      payload: { journey: "Not a journey" },
    });

    expect(response).toMatchObject({
      status: "error",
      error: { code: "invalid_request" },
    });
    expect(launchJourneyRunMock).not.toHaveBeenCalled();
  });

  it("reuses the SAME launch key on retry after a failure (no duplicate run/spend)", async () => {
    renderAndSelectPersona();

    // First attempt fails — the key must be RETAINED for the retry so the
    // backend dedupes rather than creating a second run.
    launchJourneyRunMock.mockRejectedValueOnce(
      new LaunchJourneyRunError(500, "upstream unavailable"),
    );
    const first = await dispatch({
      type: "launchSwarmRun",
      payload: { journey: "Book a flight" },
    });
    expect(first).toMatchObject({ status: "error" });
    const firstKey = (launchJourneyRunMock.mock.calls[0]![0] as { launchKey: string })
      .launchKey;

    // Retry succeeds with the SAME key.
    launchJourneyRunMock.mockResolvedValueOnce({ runId: "run-1" });
    await dispatch({
      type: "launchSwarmRun",
      payload: { journey: "Book a flight" },
    });
    const retryKey = (launchJourneyRunMock.mock.calls[1]![0] as { launchKey: string })
      .launchKey;
    expect(retryKey).toBe(firstKey);

    // After the confirmed 2xx, a subsequent launch mints a FRESH key.
    launchJourneyRunMock.mockResolvedValueOnce({ runId: "run-2" });
    await dispatch({
      type: "launchSwarmRun",
      payload: { journey: "Book a flight" },
    });
    const nextKey = (launchJourneyRunMock.mock.calls[2]![0] as { launchKey: string })
      .launchKey;
    expect(nextKey).not.toBe(firstKey);
  });

  it("refuses every command as unsupported_in_mode when signed out", async () => {
    render(<SwarmsTab projectId="proj-1" isAuthenticated={false} />);

    const response = await dispatch({
      type: "launchSwarmRun",
      payload: { journey: "Book a flight" },
    });

    expect(response).toMatchObject({
      status: "error",
      error: { code: "unsupported_in_mode" },
    });
    expect(launchJourneyRunMock).not.toHaveBeenCalled();
  });

  it("snapshot reports redacted state — persona/journey names, ids, host target names, counts", async () => {
    renderAndSelectPersona();

    const snapshot = await readSurfaceSnapshot("swarms");
    expect(snapshot).toMatchObject({
      ok: true,
      data: {
        selectedPersona: { id: "persona-1", name: "Persona One", role: "tester" },
        personaCount: 1,
        personas: [{ id: "persona-1", name: "Persona One" }],
        journeys: [
          {
            id: "journey-1",
            goal: "Book a flight",
            hostTargets: ["Host One"],
            sessionsPerHost: 2,
            maxTurns: 6,
          },
        ],
      },
    });
  });
});
