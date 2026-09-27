import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import type { SwarmStreamEvent } from "@/shared/swarm-stream-events";
const mocks = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("@/lib/swarm-api", () => ({ streamJourneyRun: mocks.stream }));
import { useJourneyRunStream } from "../use-journey-run-stream";

it("notifies once for mid-run attempts and keeps completed sessions", () => {
  let emit: (event: SwarmStreamEvent) => void = () => {};
  mocks.stream.mockImplementation((_id, onEvent) => {
    emit = onEvent;
    return new Promise(() => {});
  });
  const store = useMCPJamLimitDialogStore;
  store.setState({
    authStatus: "signedIn",
    isOpen: false,
    notifiedKeys: new Set(),
  });
  const { result } = renderHook(() =>
    useJourneyRunStream("swarm-credits", true),
  );
  const base = {
    runId: "swarm-credits",
    hostId: "host",
    sessionIndex: 0,
    chatSessionId: "done",
  };
  act(() => emit({ ...base, type: "session_complete", status: "succeeded" }));
  act(() =>
    emit({
      ...base,
      chatSessionId: "blocked",
      type: "attempt_status",
      status: "failed",
      errorMessage: "Daily credit limit reached.",
    }),
  );
  expect(store.getState().isOpen).toBe(true);
  expect(store.getState().surface).toBe("swarm");
  act(() => store.getState().close());
  act(() =>
    emit({
      ...base,
      chatSessionId: "blocked",
      type: "session_complete",
      status: "failed",
      errorMessage: "Daily credit limit reached.",
    }),
  );
  expect(store.getState().isOpen).toBe(false);
  expect(result.current.sessions.done.attemptStatus).toBe("succeeded");
});

it("opens the dialog once for every run of a wave", () => {
  const emits: Array<(event: SwarmStreamEvent) => void> = [];
  mocks.stream.mockImplementation((_id, onEvent) => {
    emits.push(onEvent);
    return new Promise(() => {});
  });
  const store = useMCPJamLimitDialogStore;
  store.setState({
    authStatus: "signedIn",
    isOpen: false,
    notifiedKeys: new Set(),
  });
  // The wave id arrives with the run doc, after the stream is already open.
  const first = renderHook(
    ({ wave }: { wave?: string }) => useJourneyRunStream("run-a", true, wave),
    { initialProps: {} as { wave?: string } },
  );
  first.rerender({ wave: "wave-1" });
  renderHook(() => useJourneyRunStream("run-b", true, "wave-1"));
  const blocked = (runId: string) => ({
    runId,
    hostId: "host",
    sessionIndex: 0,
    chatSessionId: `${runId}-blocked`,
    type: "attempt_status" as const,
    status: "failed" as const,
    errorMessage: "Daily credit limit reached.",
  });

  act(() => emits[0]!(blocked("run-a")));
  expect(store.getState().isOpen).toBe(true);
  act(() => store.getState().close());
  act(() => emits[1]!(blocked("run-b")));
  expect(store.getState().isOpen).toBe(false);
  // The first stream did not reconnect when its wave id arrived.
  expect(mocks.stream).toHaveBeenCalledTimes(2);
});
