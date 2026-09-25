import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));
const post = vi.hoisted(() => vi.fn());
vi.mock("../base", () => ({ webPost: post }));
vi.mock("../context", () => ({
  tryGetHostedServerDisplayName: () => undefined,
  buildServerRequest: vi.fn(),
}));
import { validateHostedServer } from "../servers-api";
import { serverCheckQueue } from "@/lib/server-check-queue";
afterEach(() => {
  serverCheckQueue.cancelAll();
  vi.useRealTimers();
  post.mockReset();
});

describe("hosted validation scheduling", () => {
  it("keeps waiting time outside the request deadline and actually aborts timed-out fetches", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const finish: Array<() => void> = [];
    post.mockImplementation(
      (_path, _body, options) =>
        new Promise((resolve, reject) => {
          signals.push(options.signal);
          finish.push(() => resolve({ success: true }));
          options.signal.addEventListener(
            "abort",
            () => reject(options.signal.reason),
            { once: true },
          );
        }),
    );
    const results = Array.from({ length: 11 }, (_, i) =>
      validateHostedServer(String(i), undefined, undefined, {
        projectId: "project",
        serverId: String(i),
      }),
    );
    const settled = Promise.allSettled(results);
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(10);
    await vi.advanceTimersByTimeAsync(40_000);
    finish[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(post).toHaveBeenCalledTimes(11);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(signals[1].aborted).toBe(true);
    expect(signals[10].aborted).toBe(false);
    finish[10]();
    const outcomes = await settled;
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(2);
  });
  it("queues automatic preparation in card order without acquiring a second slot for HTTP", async () => {
    const order = Array.from({ length: 12 }, (_, i) => String(11 - i));
    serverCheckQueue.setOrder("ordered", order);
    const started: string[] = [];
    post.mockImplementation(async (_path, body) => {
      started.push(body.serverId);
      return { success: true };
    });
    const jobs = [...order]
      .reverse()
      .map((serverName) =>
        serverCheckQueue.run(
          {
            projectId: "ordered",
            serverName,
            identity: "connection-operation",
          },
          (queueSignal) =>
            validateHostedServer(serverName, undefined, undefined, {
              projectId: "ordered",
              serverId: serverName,
              queueSignal,
            }),
        ),
      );
    await Promise.all(jobs);
    expect(started).toEqual(order);
  });

  it("propagates user cancellation to the request signal", async () => {
    const controller = new AbortController();
    let observed!: AbortSignal;
    post.mockImplementation(
      (_path, _body, options) =>
        new Promise((_resolve, reject) => {
          observed = options.signal;
          observed.addEventListener("abort", () => reject(observed.reason), {
            once: true,
          });
        }),
    );
    const result = validateHostedServer(
      "server",
      undefined,
      undefined,
      { projectId: "project", serverId: "server" },
      controller.signal,
    );
    const rejected = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    controller.abort();
    await rejected;
    expect(observed.aborted).toBe(true);
  });
});
