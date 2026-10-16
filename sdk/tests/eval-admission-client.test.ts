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
  it("rejects an expired authorization during construction", () => {
    expect(
      () => new AttemptStepGuard(client(), {
        ...receipt,
        expiresAt: Date.now(),
      })
    ).toThrow(expect.objectContaining({ code: "ADMISSION_CLOSED" }));
  });
  it("rejects an active receipt already expired when it arrives", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ ...receipt, expiresAt: Date.now() - 1 })
    ));
    await expect(client().admit(input)).rejects.toMatchObject({ code: "ADMISSION_CLOSED" });
  });
  it("preserves the original transport failure for diagnosis", async () => {
    vi.useFakeTimers();
    const cause = new Error("connection reset");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cause));
    const result = expect(client().admit(input)).rejects.toMatchObject({
      code: "PLATFORM_UNAVAILABLE", cause,
    });
    await vi.runAllTimersAsync();
    await result;
  });
  it("rejects cached grants at expiry without contacting the server", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const expiresAt = Date.now() + 1_000;
    const guard = new AttemptStepGuard(client(), {
      ...receipt,
      state: "active",
      grantedSteps: 5,
      expiresAt,
    });
    await guard.beforePrompt();
    vi.setSystemTime(expiresAt);
    await expect(guard.beforePrompt()).rejects.toMatchObject({
      code: "ADMISSION_CLOSED",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects a grant that arrives after the attempt expires", async () => {
    vi.useFakeTimers();
    const expiresAt = Date.now() + 1_000;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        vi.setSystemTime(expiresAt);
        return Response.json({ ...receipt, grantedSteps: 2, expiresAt });
      })
    );
    const guard = new AttemptStepGuard(client(), {
      ...receipt,
      state: "active",
      expiresAt,
    });
    await guard.beforePrompt();
    await expect(guard.beforePrompt()).rejects.toMatchObject({
      code: "ADMISSION_CLOSED",
    });
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
