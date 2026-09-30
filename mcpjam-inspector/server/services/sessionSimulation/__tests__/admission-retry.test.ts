import { afterEach, expect, it, vi } from "vitest";
import { AdmissionWaitBudget, withAdmissionRetry } from "../admission-retry";

const refusal = () =>
  new Error(
    'swarm-agent https://example.test/turn failed (429): {"code":"user_rate_limit","refusalReason":"holds_committed","retryAfter":15000,"error":"MCPJam model limit reached for the moment."}',
  );
const busy = () =>
  new Error(
    'swarm-agent https://example.test/turn failed (503): {"code":"spending_reservation_busy","isRetryable":true,"retryAfter":2000,"error":"MCPJam could not reserve spending capacity because this organization has many model calls starting at once. The model was not called for this request. Please retry."}',
  );

const emptyHostTurnBusy = () =>
  Object.assign(new Error("Spending approval timed out"), {
    name: "RecordedAssistantTurnError",
    refusal: {
      code: "spending_reservation_busy",
      retryAfterMs: 2000,
      httpStatus: 503,
    },
  });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("waits within jitter bounds and succeeds", async () => {
  vi.useFakeTimers();
  const op = vi.fn().mockRejectedValueOnce(refusal()).mockResolvedValue("done");
  const onWait = vi.fn();
  const result = withAdmissionRetry(op, {
    budget: new AdmissionWaitBudget(),
    onWait,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(onWait.mock.calls[0][0]).toBeGreaterThanOrEqual(7500);
  expect(onWait.mock.calls[0][0]).toBeLessThanOrEqual(15000);
  await vi.runAllTimersAsync();
  expect(await result).toBe("done");
  expect(op).toHaveBeenCalledTimes(2);
});
it("retries a hold that arrives as plain text, with no JSON and no reason", async () => {
  // A flattened error keeps the backend's sentence and the code suffix the
  // runner appends, but not the structured reason.
  vi.useFakeTimers();
  const plain = new Error(
    "MCPJam model limit reached for the moment: 2 in-flight request(s) hold the remaining credits and release them as they finish. (user_rate_limit, HTTP 429)",
  );
  const op = vi.fn().mockRejectedValueOnce(plain).mockResolvedValue("done");
  const result = withAdmissionRetry(op, { budget: new AdmissionWaitBudget() });
  await vi.runAllTimersAsync();
  expect(await result).toBe("done");
  expect(op).toHaveBeenCalledTimes(2);
});
it.each([busy, emptyHostTurnBusy])(
  "recovers from a busy admission before a turn executes",
  async (makeError) => {
    vi.useFakeTimers();
    const op = vi
      .fn()
      .mockRejectedValueOnce(makeError())
      .mockResolvedValue("done");
    const resume = vi.fn();
    const onWait = vi.fn((_delayMs: number) => resume);
    const result = withAdmissionRetry(op, {
      budget: new AdmissionWaitBudget(),
      onWait,
    });
    await vi.advanceTimersByTimeAsync(0);
    // The backend's two-second hint is bounded by the existing five-second floor.
    expect(onWait.mock.calls[0][0]).toBeGreaterThanOrEqual(2500);
    expect(onWait.mock.calls[0][0]).toBeLessThanOrEqual(5000);
    await vi.runAllTimersAsync();
    expect(await result).toBe("done");
    expect(op).toHaveBeenCalledTimes(2);
    expect(resume).toHaveBeenCalledOnce();
  },
);

it("lets 45 concurrent sessions recover after spending approval is busy", async () => {
  vi.useFakeTimers();
  const calls = Array.from({ length: 45 }, (_, i) =>
    vi.fn().mockRejectedValueOnce(busy()).mockResolvedValue(`session-${i}`),
  );
  const results = Promise.all(
    calls.map((op) =>
      withAdmissionRetry(op, { budget: new AdmissionWaitBudget() }),
    ),
  );
  await vi.runAllTimersAsync();
  expect(await results).toEqual(calls.map((_, i) => `session-${i}`));
  for (const op of calls) expect(op).toHaveBeenCalledTimes(2);
});

it.each([refusal, busy])(
  "shares the session wait budget and rethrows the last refusal",
  async (makeError) => {
    const error = makeError();
    const op = vi.fn().mockRejectedValue(error);
    await expect(
      withAdmissionRetry(op, { budget: new AdmissionWaitBudget(1) }),
    ).rejects.toBe(error);
    expect(op).toHaveBeenCalledTimes(1);
  },
);
it.each([refusal, busy])("bounds attempts per call", async (makeError) => {
  vi.useFakeTimers();
  const error = makeError();
  const op = vi.fn().mockRejectedValue(error);
  const result = expect(
    withAdmissionRetry(op, { budget: new AdmissionWaitBudget(300000, 3) }),
  ).rejects.toBe(error);
  await vi.runAllTimersAsync();
  await result;
  expect(op).toHaveBeenCalledTimes(3);
});
it.each([refusal, busy])(
  "aborts during a wait without another invocation",
  async (makeError) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const op = vi.fn().mockRejectedValue(makeError());
    const result = expect(
      withAdmissionRetry(op, {
        budget: new AdmissionWaitBudget(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await result;
    expect(op).toHaveBeenCalledTimes(1);
  },
);
it("waits out a busy spending reservation instead of failing", async () => {
  // MCPJam's own reservation lost its concurrency race and committed nothing:
  // the model was never called, so asking again is safe.
  vi.useFakeTimers();
  const busy = new Error(
    'swarm-agent https://example.test/persona failed (503): {"ok":false,"code":"spending_reservation_busy","error":"MCPJam could not reserve spending capacity because concurrent requests kept changing it. The model was not called for this request. Please retry.","statusCode":503,"isRetryable":true}',
  );
  const op = vi.fn().mockRejectedValueOnce(busy).mockResolvedValue("done");
  const result = withAdmissionRetry(op, { budget: new AdmissionWaitBudget() });
  await vi.runAllTimersAsync();
  expect(await result).toBe("done");
  expect(op).toHaveBeenCalledTimes(2);
});
it("retries a host step's structured busy refusal", async () => {
  vi.useFakeTimers();
  const busy = Object.assign(new Error("MCPJam is temporarily busy."), {
    refusal: { code: "spending_reservation_busy", httpStatus: 503 },
  });
  const op = vi.fn().mockRejectedValueOnce(busy).mockResolvedValue("done");
  const result = withAdmissionRetry(op, { budget: new AdmissionWaitBudget() });
  await vi.runAllTimersAsync();
  expect(await result).toBe("done");
  expect(op).toHaveBeenCalledTimes(2);
});
it.each([
  new Error("provider 429"),
  new Error('{"code":"user_rate_limit","refusalReason":"allowance_exhausted"}'),
  Object.assign(refusal(), { name: "RecordedAssistantTurnError" }),
  Object.assign(busy(), { name: "RecordedAssistantTurnError" }),
  Object.assign(busy(), {
    name: "RecordedAssistantTurnError",
    refusal: undefined,
    errorRefusal: { code: "spending_reservation_busy" },
  }),
])("does not replay terminal or partially executed calls", async (error) => {
  const op = vi.fn().mockRejectedValue(error);
  await expect(
    withAdmissionRetry(op, { budget: new AdmissionWaitBudget() }),
  ).rejects.toBe(error);
  expect(op).toHaveBeenCalledTimes(1);
});
