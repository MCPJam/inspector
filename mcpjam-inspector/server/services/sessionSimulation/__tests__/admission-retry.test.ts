import { afterEach, expect, it, vi } from "vitest";
import { AdmissionWaitBudget, withAdmissionRetry } from "../admission-retry";

const refusal = () =>
  new Error(
    'swarm-agent https://example.test/turn failed (429): {"code":"user_rate_limit","refusalReason":"holds_committed","retryAfter":15000,"error":"MCPJam model limit reached for the moment."}',
  );
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
it("shares the session wait budget and rethrows the last refusal", async () => {
  const error = refusal();
  const op = vi.fn().mockRejectedValue(error);
  await expect(
    withAdmissionRetry(op, { budget: new AdmissionWaitBudget(1) }),
  ).rejects.toBe(error);
  expect(op).toHaveBeenCalledTimes(1);
});
it("bounds attempts per call", async () => {
  vi.useFakeTimers();
  const error = refusal();
  const op = vi.fn().mockRejectedValue(error);
  const result = expect(
    withAdmissionRetry(op, { budget: new AdmissionWaitBudget(300000, 3) }),
  ).rejects.toBe(error);
  await vi.runAllTimersAsync();
  await result;
  expect(op).toHaveBeenCalledTimes(3);
});
it("aborts during a wait without another invocation", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const op = vi.fn().mockRejectedValue(refusal());
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
});
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
])("does not replay terminal or partially executed calls", async (error) => {
  const op = vi.fn().mockRejectedValue(error);
  await expect(
    withAdmissionRetry(op, { budget: new AdmissionWaitBudget() }),
  ).rejects.toBe(error);
  expect(op).toHaveBeenCalledTimes(1);
});
