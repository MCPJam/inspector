import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  requestPayloadEnvelopeFields,
  useRequestPayloads,
} from "../use-request-payloads";

/**
 * Saved model requests for a session, as Raw reads them.
 *
 * Two failures this pins. Convex hands back a fresh turn-trace array on every
 * push and a running session pushes every turn, so keying the fetch on the
 * array re-downloaded every blob and blanked Raw each time. And a failed read
 * used to come back as `[]`, which Raw then described as "no requests were
 * saved" — a claim about the session that the failed fetch cannot support.
 */

const REQUESTS = [
  {
    turnId: "t",
    promptIndex: 0,
    stepIndex: 0,
    payload: { system: "saved system", tools: {}, messages: [] },
  },
];

const turns = (url = "https://storage.test/r0.json") => [
  { promptIndex: 0, requestPayloadsBlobUrl: url },
];

describe("useRequestPayloads", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches once per set of blob URLs, not once per turn-trace push", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () => new Response(JSON.stringify(REQUESTS), { status: 200 }),
      );
    const { result, rerender } = renderHook(
      ({ list }) => useRequestPayloads("session", list),
      { initialProps: { list: turns() } },
    );
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.entries[0]?.payload.system).toBe("saved system");

    // Same URLs, fresh array — what every Convex push looks like.
    rerender({ list: turns() });
    rerender({ list: turns() });
    expect(result.current.entries).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps showing entries while a new turn's blob loads", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(JSON.stringify(REQUESTS), { status: 200 }),
    );
    const { result, rerender } = renderHook(
      ({ list }) => useRequestPayloads("session", list),
      { initialProps: { list: turns() } },
    );
    await waitFor(() => expect(result.current.pending).toBe(false));

    rerender({
      list: [
        ...turns(),
        {
          promptIndex: 1,
          requestPayloadsBlobUrl: "https://storage.test/r1.json",
        },
      ],
    });
    expect(result.current.pending).toBe(true);
    expect(result.current.entries).toHaveLength(1);
  });

  it("reports a failed read as an error, not as no requests", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response("gone", { status: 404 }),
    );
    const { result } = renderHook(() => useRequestPayloads("session", turns()));
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.entries).toEqual([]);
    expect(result.current.error).toMatch(/could not be loaded/);
    expect(requestPayloadEnvelopeFields(result.current)).toEqual({
      requestPayloadsError: result.current.error,
    });
  });

  it("is pending, not empty, while turn traces are still loading", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { result } = renderHook(() =>
      useRequestPayloads("session", undefined),
    );
    expect(result.current.pending).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
