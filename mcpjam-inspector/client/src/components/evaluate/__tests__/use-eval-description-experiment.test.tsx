/**
 * Polling for one description experiment stops at a terminal status.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import type { EvalDescriptionExperiment } from "@/lib/apis/eval-description-experiment-api";
import {
  useEvalDescriptionExperiment,
  type EvalDescriptionExperimentState,
} from "../use-eval-description-experiment";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  get: vi.fn(),
  propose: vi.fn(),
  start: vi.fn(),
}));

vi.mock("@/lib/apis/eval-description-experiment-api", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/apis/eval-description-experiment-api")
  >("@/lib/apis/eval-description-experiment-api");
  return {
    ...actual,
    listEvalDescriptionExperimentsForRun: mocks.list,
    fetchEvalDescriptionExperiment: mocks.get,
    proposeEvalDescriptionRewrite: mocks.propose,
    startEvalDescriptionExperiment: mocks.start,
  };
});

function experiment(
  over: Partial<EvalDescriptionExperiment> = {},
): EvalDescriptionExperiment {
  return {
    id: "exp_1",
    suiteId: "suite_1",
    sourceRunId: "run_1",
    toolName: "get_user",
    status: "proposing",
    ...over,
  };
}

function Harness({
  enabled = true,
  revision = "completed::::",
  onState,
}: {
  enabled?: boolean;
  revision?: string;
  onState: (state: EvalDescriptionExperimentState) => void;
}) {
  onState(
    useEvalDescriptionExperiment({
      projectId: "proj_1",
      sourceRunId: "run_1",
      revision,
      enabled,
    }),
  );
  return null;
}

function renderHook(
  props: Partial<Parameters<typeof Harness>[0]> = {},
) {
  const states: EvalDescriptionExperimentState[] = [];
  const utils = render(
    <Harness {...props} onState={(state) => states.push(state)} />,
  );
  return {
    ...utils,
    states,
    latest: () => states[states.length - 1]!,
  };
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.get.mockReset();
  mocks.propose.mockReset();
  mocks.start.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useEvalDescriptionExperiment", () => {
  it("issues no request when the flag is off", () => {
    renderHook({ enabled: false });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("polls while proposing and stops at proposed", async () => {
    vi.useFakeTimers();
    mocks.list.mockResolvedValue([experiment({ status: "proposing" })]);
    mocks.get.mockResolvedValue(experiment({ status: "proposed" }));

    const { latest } = renderHook();
    await vi.waitFor(() =>
      expect(latest().experiment?.status).toBe("proposing"),
    );
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.get).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() =>
      expect(latest().experiment?.status).toBe("proposed"),
    );
    expect(mocks.get).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("polls while running and stops at completed", async () => {
    vi.useFakeTimers();
    mocks.list.mockResolvedValue([experiment({ status: "running" })]);
    mocks.get.mockResolvedValue(experiment({ status: "completed" }));

    const { latest } = renderHook();
    await vi.waitFor(() => expect(latest().experiment?.status).toBe("running"));

    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(latest().experiment?.status).toBe("completed"));
    expect(mocks.get).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });

  it("stops at failed without another read", async () => {
    vi.useFakeTimers();
    mocks.list.mockResolvedValue([experiment({ status: "failed" })]);

    const { latest } = renderHook();
    await vi.waitFor(() => expect(latest().experiment?.status).toBe("failed"));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("stops at cancelled without another read", async () => {
    vi.useFakeTimers();
    mocks.list.mockResolvedValue([experiment({ status: "cancelled" })]);

    const { latest } = renderHook();
    await vi.waitFor(() =>
      expect(latest().experiment?.status).toBe("cancelled"),
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
