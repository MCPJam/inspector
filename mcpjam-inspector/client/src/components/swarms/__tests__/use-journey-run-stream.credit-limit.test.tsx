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
    notifiedRunIds: new Set(),
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
