import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRESEND_SYNC_TIMEOUT_MS,
  presendStateIsCurrent,
  withPresendSyncTimeout,
} from "../chat-history-presend";

const live = {
  _id: "history-1",
  chatSessionId: "chat-1",
  version: 7,
  directVisibility: "private" as const,
};
const current = {
  activeHistorySessionId: "history-1",
  chatSessionId: "chat-1",
  live,
  resumedVersion: 7,
  visibility: "private" as const,
};

describe("presendStateIsCurrent", () => {
  it("lets Send go when the live session matches the thread and the cursor reached it", () => {
    expect(presendStateIsCurrent(current)).toBe(true);
    expect(presendStateIsCurrent({ ...current, resumedVersion: 8 })).toBe(true);
  });

  it("reads the state first when the visibility changed without a version bump", () => {
    // Unshared elsewhere: same version, but this turn would send "project".
    expect(presendStateIsCurrent({ ...current, visibility: "project" })).toBe(
      false,
    );
    // Shared elsewhere: the read applies the normalized value.
    expect(
      presendStateIsCurrent({
        ...current,
        live: { ...live, directVisibility: "project" },
      }),
    ).toBe(false);
  });

  it("reads the state first when another writer moved the session past the cursor", () => {
    expect(presendStateIsCurrent({ ...current, resumedVersion: 6 })).toBe(
      false,
    );
  });

  it("reads the state first while the subscription has not delivered, or found nothing", () => {
    expect(presendStateIsCurrent({ ...current, live: undefined })).toBe(false);
    expect(presendStateIsCurrent({ ...current, live: null })).toBe(false);
    expect(presendStateIsCurrent({ ...current, resumedVersion: null })).toBe(
      false,
    );
  });

  it("never trusts a session that belongs to another row or conversation", () => {
    expect(
      presendStateIsCurrent({
        ...current,
        activeHistorySessionId: "history-2",
      }),
    ).toBe(false);
    expect(presendStateIsCurrent({ ...current, chatSessionId: "chat-2" })).toBe(
      false,
    );
    expect(
      presendStateIsCurrent({ ...current, activeHistorySessionId: null }),
    ).toBe(false);
  });
});

describe("withPresendSyncTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes a prompt read through unchanged", async () => {
    await expect(
      withPresendSyncTimeout(Promise.resolve("state")),
    ).resolves.toBe("state");
    const failure = new Error("403");
    await expect(withPresendSyncTimeout(Promise.reject(failure))).rejects.toBe(
      failure,
    );
  });

  it("fails a read that outlasts the bound so Send reports the sync failure", async () => {
    vi.useFakeTimers();
    const pending = withPresendSyncTimeout(new Promise<never>(() => {}));
    const outcome = expect(pending).rejects.toThrow(
      `Chat history sync took longer than ${PRESEND_SYNC_TIMEOUT_MS} ms`,
    );
    await vi.advanceTimersByTimeAsync(PRESEND_SYNC_TIMEOUT_MS);
    await outcome;
  });
});
