import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

// Convex reads dispatched by query name; runs/sessions are empty.
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
  useMutation: () => vi.fn(),
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

// The session viewer is heavy (chat-ui + trace-viewer); stub it — the launch
// flow never renders it.
vi.mock("@/components/connection/share-usage/ShareUsageThreadDetail", () => ({
  ShareUsageThreadDetail: () => null,
}));
vi.mock("@/hooks/useViews", () => ({
  useProjectServerAttachments: () => ({
    serverAttachments: [],
    isLoading: false,
  }),
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

function selectPersonaAndRun() {
  render(<SwarmsTab projectId="proj-1" isAuthenticated />);
  fireEvent.click(screen.getByText("Persona One"));
  return screen.getByRole("button", { name: "Run journey" });
}

beforeEach(() => {
  launchJourneyRunMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SwarmsTab — Run journey launch", () => {
  it("POSTs via launchJourneyRun with the journeyId, projectId, and a generated launch key", async () => {
    launchJourneyRunMock.mockResolvedValue({ runId: "run-1" });

    const runBtn = selectPersonaAndRun();
    expect(runBtn).not.toBeDisabled();
    fireEvent.click(runBtn);

    await waitFor(() => expect(launchJourneyRunMock).toHaveBeenCalledTimes(1));
    const arg = launchJourneyRunMock.mock.calls[0]![0] as any;
    expect(arg.journeyId).toBe("journey-1");
    expect(arg.projectId).toBe("proj-1");
    expect(typeof arg.launchKey).toBe("string");
    expect(arg.launchKey.length).toBeGreaterThan(0);
  });

  it("surfaces a 4xx as an inline error", async () => {
    launchJourneyRunMock.mockRejectedValue(
      new LaunchJourneyRunError(400, "This journey has no pinned hosts to run")
    );

    const runBtn = selectPersonaAndRun();
    fireEvent.click(runBtn);

    await waitFor(() =>
      expect(
        screen.getByText("This journey has no pinned hosts to run")
      ).toBeInTheDocument()
    );
  });

  it("reuses the SAME launchKey on retry after a 5xx/network failure, and only clears it after a confirmed 2xx", async () => {
    // A 5xx or dropped connection can land AFTER the backend created the run, so
    // the key MUST survive to keep the retry idempotent (no duplicate run/spend).
    launchJourneyRunMock.mockRejectedValueOnce(
      new LaunchJourneyRunError(500, "upstream unavailable")
    );

    const runBtn = selectPersonaAndRun();
    fireEvent.click(runBtn);
    await waitFor(() =>
      expect(launchJourneyRunMock).toHaveBeenCalledTimes(1)
    );
    const firstKey = (launchJourneyRunMock.mock.calls[0]![0] as any).launchKey;

    // Retry succeeds — the SAME launch key is reused (backend dedupes to the
    // already-created run rather than minting a second).
    launchJourneyRunMock.mockResolvedValueOnce({ runId: "run-1" });
    fireEvent.click(runBtn);
    await waitFor(() =>
      expect(launchJourneyRunMock).toHaveBeenCalledTimes(2)
    );
    const retryKey = (launchJourneyRunMock.mock.calls[1]![0] as any).launchKey;
    expect(retryKey).toBe(firstKey);

    // After the confirmed 2xx, a subsequent launch mints a FRESH key.
    launchJourneyRunMock.mockResolvedValueOnce({ runId: "run-2" });
    fireEvent.click(runBtn);
    await waitFor(() =>
      expect(launchJourneyRunMock).toHaveBeenCalledTimes(3)
    );
    const nextKey = (launchJourneyRunMock.mock.calls[2]![0] as any).launchKey;
    expect(nextKey).not.toBe(firstKey);
  });
});
