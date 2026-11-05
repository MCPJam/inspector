import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CompletedTurnPersistence,
  COMPLETED_TURN_RETRY_TTL_MS,
} from "../completed-turn-persistence.js";

afterEach(() => vi.useRealTimers());
const owner = {
  subject: "actor-a",
  projectId: "project-a",
  chatSessionId: "chat",
  turnId: "turn",
};
const saved = { outcome: "saved" as const, version: 2 };

describe("completed-turn persistence ownership", () => {
  it("keeps the rightful handle after foreign actor/project/turn attempts and claims only once", async () => {
    const store = new CompletedTurnPersistence();
    const id = store.register(owner, "immutable", "chat", "turn")!;
    const persist = vi.fn(async (body: string) => {
      expect(body).toBe("immutable");
      return saved;
    });
    for (const wrong of [
      { subject: "other" },
      { projectId: "other" },
      { chatSessionId: "other" },
      { turnId: "other" },
    ])
      expect(await store.retry(id, { ...owner, ...wrong }, persist)).toBe(
        "missing",
      );
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const waiting = store.wait(id);
    const active = store.retry(id, owner, async (body) => {
      await gate;
      return persist(body);
    });
    expect(await store.retry(id, owner, persist)).toBe("busy");
    finish();
    expect(await active).toEqual(saved);
    expect(await waiting).toEqual(saved);
    expect(await store.retry(id, owner, persist)).toBe("missing");
    expect(persist).toHaveBeenCalledOnce();
  });

  it("expires, aborts in-flight retry, and bounds retained payloads per actor and globally", async () => {
    vi.useFakeTimers();
    const store = new CompletedTurnPersistence();
    const id = store.register(owner, "body", "chat", "turn")!;
    store.register(owner, "body", "chat", "turn2");
    expect(store.register(owner, "body", "chat", "turn3")).toBeUndefined();
    expect(
      store.register(
        { ...owner, subject: "oversize" },
        "x".repeat(8 * 1024 * 1024 + 1),
        "chat",
        "turn",
      ),
    ).toBeUndefined();
    const waiting = store.wait(id);
    let signal: AbortSignal | undefined;
    const active = store.retry(id, owner, async (_body, value) => {
      signal = value;
      await new Promise<void>((resolve) =>
        value.addEventListener("abort", () => resolve(), { once: true }),
      );
      return { outcome: "failed", failureKind: "timeout" };
    });
    await vi.advanceTimersByTimeAsync(COMPLETED_TURN_RETRY_TTL_MS);
    expect(signal?.aborted).toBe(true);
    expect(await waiting).toEqual({
      outcome: "failed",
      failureKind: "timeout",
    });
    await active;
    for (let i = 0; i < 16; i++)
      expect(
        store.register(
          { ...owner, subject: `actor-${i}` },
          "body",
          "chat",
          "turn",
        ),
      ).toBeTruthy();
    expect(
      store.register({ ...owner, subject: "overflow" }, "body", "chat", "turn"),
    ).toBeUndefined();
    await vi.advanceTimersByTimeAsync(COMPLETED_TURN_RETRY_TTL_MS);
    const large = "x".repeat(8 * 1024 * 1024);
    for (let i = 0; i < 8; i++)
      expect(
        store.register(
          { ...owner, subject: `large-${i}` },
          large,
          "chat",
          "turn",
        ),
      ).toBeTruthy();
    expect(
      store.register(
        { ...owner, subject: "large-overflow" },
        large,
        "chat",
        "turn",
      ),
    ).toBeUndefined();
    await vi.advanceTimersByTimeAsync(COMPLETED_TURN_RETRY_TTL_MS);
  });
});

it("bounds a non-cooperative retry and keeps its bytes charged until it settles", async () => {
  vi.useFakeTimers();
  const store = new CompletedTurnPersistence();
  const id = store.register(owner, "body", "chat", "turn")!;
  let settle!: () => void;
  const work = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const retry = store.retry(id, owner, async () => {
    await work;
    return saved;
  });
  const waiting = store.wait(id);
  await vi.advanceTimersByTimeAsync(COMPLETED_TURN_RETRY_TTL_MS);
  expect(await retry).toEqual({ outcome: "failed", failureKind: "timeout" });
  expect(await waiting).toEqual({ outcome: "failed", failureKind: "timeout" });
  expect(await store.retry(id, owner, async () => saved)).toBe("missing");
  expect(store.register(owner, "body", "chat", "second")).toBeTruthy();
  expect(store.register(owner, "body", "chat", "third")).toBeUndefined();
  settle();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(store.register(owner, "body", "chat", "third")).toBeTruthy();
  await vi.advanceTimersByTimeAsync(COMPLETED_TURN_RETRY_TTL_MS);
});
