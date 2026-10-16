import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AttemptStepGuard,
  EvalAdmissionClient,
} from "../src/eval-admission-client.js";
const receipt = {
  executionId: "execution",
  iterationId: "iteration",
  attemptId: "attempt",
  state: "active",
  grantedSteps: 1,
  expiresAt: Date.now() + 60_000,
};
const input = {
  executionKey: "execution",
  externalRunId: "run",
  purpose: "eval" as const,
  iterationKey: "iteration",
  attemptIndex: 0,
  initialSteps: 1,
  planFingerprint: "dynamic",
};
const client = () =>
  new EvalAdmissionClient({
    apiKey: "sk_test",
    baseUrl: "https://app.example.com",
  });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("local admission transport", () => {
  it("rejects cached prompt coverage at expiry without making a request", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const guard = new AttemptStepGuard(client(), {
      ...receipt,
      state: "active",
      grantedSteps: 200,
      expiresAt: Date.now() + 1000,
    });
    await guard.beforePrompt();
    vi.advanceTimersByTime(1000);
    await expect(guard.beforePrompt()).rejects.toMatchObject({
      code: "ADMISSION_CLOSED",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects an active receipt that expired before its response arrived", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ ...receipt, expiresAt: Date.now() - 1 })
    ));
    await expect(client().admit(input)).rejects.toMatchObject({
      code: "ADMISSION_CLOSED",
    });
  });
  it("does not retry exhausted quota as a transient rate limit", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({
      code: "RATE_LIMITED",
      message: "Daily eval quota reached.",
      details: { code: "billing_limit_reached", resetsAt: Date.now() + 60_000 },
    }, { status: 429 }));
    vi.stubGlobal("fetch", fetch);
    await expect(client().admit(input)).rejects.toMatchObject({
      code: "BILLING_LIMIT_REACHED",
      details: { code: "billing_limit_reached" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("requires credentials without making a request", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(
      () =>
        new EvalAdmissionClient({
          apiKey: "",
          baseUrl: "https://app.example.com",
        })
    ).toThrowError(expect.objectContaining({ code: "CREDENTIALS_MISSING" }));
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([402, 409, 426])(
    "never retries terminal status %s",
    async (status) => {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          Response.json({ message: "The original remedy." }, { status })
        );
      vi.stubGlobal("fetch", fetch);
      await expect(client().admit(input)).rejects.toThrow(
        "The original remedy."
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );
  it("reuses exact request identity after a transient response", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValue(Response.json(receipt));
    vi.stubGlobal("fetch", fetch);
    const promise = client().admit(input);
    const result = expect(promise).resolves.toMatchObject(receipt);
    await vi.runAllTimersAsync();
    await result;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[1][1].body);
  });
  it("serializes concurrent prompt extensions with distinct ordinals", async () => {
    const targets: number[] = [];
    const fetch = vi.fn(async (_url, init) => {
      const { target } = JSON.parse(init.body);
      targets.push(target);
      return Response.json({ ...receipt, grantedSteps: target });
    });
    vi.stubGlobal("fetch", fetch);
    const guard = new AttemptStepGuard(
      client(),
      { ...receipt, state: "active" },
      undefined
    );
    await Promise.all(Array.from({ length: 5 }, () => guard.beforePrompt()));
    expect(targets).toEqual([2, 3, 4, 5]);
  });
  it("does not permit a late successful response after cancellation", async () => {
    const controller = new AbortController();
    let complete: (response: Response) => void = () => {
      throw new Error("Fetch not started");
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          })
      )
    );
    const promise = client().admit(input, controller.signal);
    controller.abort(new Error("cancelled"));
    complete(Response.json(receipt));
    await expect(promise).rejects.toThrow("cancelled");
  });
  it("retains an expired receipt without granting new work", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ ...receipt, state: "expired" }))
    );
    await expect(client().admit(input)).rejects.toMatchObject({
      code: "ADMISSION_CLOSED",
      receipt: { state: "expired" },
    });
  });
});
