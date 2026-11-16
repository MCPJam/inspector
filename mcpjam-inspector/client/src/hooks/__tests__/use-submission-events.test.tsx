/**
 * The events beside one submission: read by kind, newest first, merged
 * rather than replaced so that a read which left before a write cannot hide
 * it, and a replayed write shown once.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordedEvent,
  SCOPE,
} from "@/components/readiness/__tests__/readiness-fixtures";
import type { SubmissionEvent } from "@/lib/apis/directory-submissions-api";
import { useSubmissionEvents } from "../use-submission-events";

const api = vi.hoisted(() => ({
  listSubmissionEvents: vi.fn(),
  recordSubmissionEvent: vi.fn(),
}));
vi.mock("@/lib/apis/directory-submissions-api", () => api);

const submitted = recordedEvent({
  id: "evt_1",
  kind: "status",
  state: "submitted",
  createdAt: 10,
});
const inReview = recordedEvent({
  id: "evt_2",
  kind: "status",
  state: "in-review",
  createdAt: 20,
});
const said = recordedEvent({
  id: "evt_3",
  kind: "directory-finding",
  createdAt: 15,
  finding: {
    directory: "claude",
    text: "Add a privacy policy URL.",
    via: "email",
  },
});

/** What the server lists, by kind. */
function serve(events: SubmissionEvent[]) {
  api.listSubmissionEvents.mockImplementation(
    async (_scope: unknown, kind: SubmissionEvent["kind"]) =>
      events.filter((event) => event.kind === kind),
  );
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const ids = (events: SubmissionEvent[]) => events.map((event) => event.id);

describe("useSubmissionEvents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api.listSubmissionEvents.mockReset();
    api.recordSubmissionEvent.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("reads nothing while the page does not show the events", async () => {
    serve([submitted]);
    const { result } = renderHook(() => useSubmissionEvents(SCOPE, false));
    await settle(30_000);
    expect(api.listSubmissionEvents).not.toHaveBeenCalled();
    expect(result.current.loaded).toBe(false);
  });

  it("reads status events and the directory's words, one kind at a time", async () => {
    serve([submitted, said, inReview]);
    const { result } = renderHook(() => useSubmissionEvents(SCOPE));
    await settle();
    expect(api.listSubmissionEvents).toHaveBeenCalledWith(
      SCOPE,
      "status",
      expect.any(AbortSignal),
    );
    expect(api.listSubmissionEvents).toHaveBeenCalledWith(
      SCOPE,
      "directory-finding",
      expect.any(AbortSignal),
    );
    expect(ids(result.current.status)).toEqual(["evt_2", "evt_1"]);
    expect(ids(result.current.findings)).toEqual(["evt_3"]);
    expect(result.current.loaded).toBe(true);
  });

  it("keeps a recorded event that a later read has not caught up with", async () => {
    serve([submitted]);
    api.recordSubmissionEvent.mockResolvedValue(inReview);
    const { result } = renderHook(() => useSubmissionEvents(SCOPE));
    await settle();
    const before = result.current.version;
    await act(async () => {
      await result.current.record([
        { kind: "status", state: "in-review", reportedOrObserved: "reported" },
      ]);
    });
    expect(ids(result.current.status)).toEqual(["evt_2", "evt_1"]);
    // What reads the events, such as the handoff summary, reads them again.
    expect(result.current.version).not.toBe(before);

    // The next read still lists only the older event.
    await settle(15_000);
    expect(api.listSubmissionEvents).toHaveBeenCalledTimes(4);
    expect(ids(result.current.status)).toEqual(["evt_2", "evt_1"]);
  });

  it("shows a replayed write once", async () => {
    serve([]);
    api.recordSubmissionEvent.mockResolvedValue({
      ...submitted,
      replayed: true,
    });
    const { result } = renderHook(() => useSubmissionEvents(SCOPE));
    await settle();
    const body = {
      kind: "status" as const,
      state: "submitted",
      reportedOrObserved: "observed" as const,
      idempotencyKey: "ui-status-1-status",
    };
    await act(async () => {
      await result.current.record([body]);
      await result.current.record([body]);
    });
    expect(ids(result.current.status)).toEqual(["evt_1"]);
  });

  it("throws a refused write to the form and records nothing after it", async () => {
    serve([]);
    api.recordSubmissionEvent.mockRejectedValueOnce(
      new Error("The finding's text is empty."),
    );
    const { result } = renderHook(() => useSubmissionEvents(SCOPE));
    await settle();
    await expect(
      act(() =>
        result.current.record([
          {
            kind: "directory-finding",
            reportedOrObserved: "reported",
            finding: { text: " ", via: "email" },
          },
          {
            kind: "status",
            state: "changes-requested",
            reportedOrObserved: "reported",
          },
        ]),
      ),
    ).rejects.toThrow("The finding's text is empty.");
    expect(api.recordSubmissionEvent).toHaveBeenCalledTimes(1);
    expect(result.current.status).toEqual([]);
  });
});
