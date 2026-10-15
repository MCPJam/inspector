import { afterEach, describe, expect, it, vi } from "vitest";
import { AdmissionWaitBudget } from "../../services/sessionSimulation/admission-retry";
import { withSwarmStepAdmissionRetry } from "../swarm-step-admission";

const busy = () =>
  new Response(
    JSON.stringify({
      code: "spending_reservation_busy",
      isRetryable: true,
      retryAfter: 2000,
    }),
    { status: 503, headers: { "Retry-After": "2" } },
  );
const options = () => ({
  sourceType: "swarm",
  stepIndex: 1,
  budget: new AdmissionWaitBudget(),
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Swarm step admission retry", () => {
  it.each([
    { sourceType: "chat", stepIndex: 1 },
    { sourceType: "scenario", stepIndex: 1 },
    { sourceType: undefined, stepIndex: 1 },
    { sourceType: "swarm", stepIndex: 0 },
  ])("leaves existing retry ownership unchanged for %j", async (context) => {
    const response = busy();
    const request = vi.fn().mockResolvedValue(response);
    expect(
      await withSwarmStepAdmissionRetry(request, {
        ...options(),
        ...context,
      }),
    ).toBe(response);
    expect(request).toHaveBeenCalledTimes(1);
    expect(response.bodyUsed).toBe(false);
  });

  it.each([
    new Response("upstream unavailable", { status: 503 }),
    new Response("null", { status: 503 }),
    new Response('{"code":"provider_not_allowlisted"}', { status: 403 }),
    new Response('{"code":"mcpjam_config_error"}', { status: 503 }),
    new Response('{"code":"spending_reservation_busy","isRetryable":false}', {
      status: 503,
    }),
    new Response(
      '{"code":"user_rate_limit","refusalReason":"allowance_exhausted"}',
      { status: 429 },
    ),
    new Response('{"code":"spending_reservation_busy"}', { status: 200 }),
  ])("does not retry a different or terminal refusal", async (response) => {
    const request = vi.fn().mockResolvedValue(response);
    expect(await withSwarmStepAdmissionRetry(request, options())).toBe(
      response,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(response.bodyUsed).toBe(false);
  });

  it("returns the final response intact after bounded retries", async () => {
    vi.useFakeTimers();
    const responses = [busy(), busy()];
    const request = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    const result = withSwarmStepAdmissionRetry(request, {
      ...options(),
      budget: new AdmissionWaitBudget(300_000, 2),
    });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await vi.runAllTimersAsync();
    const response = await result;
    expect(request).toHaveBeenCalledTimes(2);
    expect(response).toBe(responses[1]);
    expect(response.headers.get("Retry-After")).toBe("2");
    expect(await response.json()).toMatchObject({
      code: "spending_reservation_busy",
    });
  });

  it("shares the wait budget across refused model steps", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const shared = { ...options(), budget: new AdmissionWaitBudget(2500) };
    const first = vi
      .fn()
      .mockResolvedValueOnce(busy())
      .mockResolvedValue(new Response("ok"));
    const result = withSwarmStepAdmissionRetry(first, shared);
    await vi.waitFor(() => expect(shared.budget.remainingMs).toBe(0));
    await vi.runAllTimersAsync();
    expect((await result).ok).toBe(true);
    const response = busy();
    const second = vi.fn().mockResolvedValue(response);
    expect(
      await withSwarmStepAdmissionRetry(second, { ...shared, stepIndex: 2 }),
    ).toBe(response);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("aborts a wait without sending another request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const request = vi.fn().mockResolvedValue(busy());
    const context = options();
    const result = expect(
      withSwarmStepAdmissionRetry(request, {
        ...context,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() =>
      expect(context.budget.remainingMs).toBeLessThan(300_000),
    );
    controller.abort();
    await result;
    expect(request).toHaveBeenCalledTimes(1);
  });
});
