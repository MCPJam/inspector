import { isRetryableTransientError, retryWithPolicy } from "../src/retry";

describe("retryWithPolicy", () => {
  it("does not treat HTTP 501 as retryable", () => {
    expect(
      isRetryableTransientError(
        Object.assign(new Error("HTTP 501"), { statusCode: 501 })
      )
    ).toBe(false);
  });

  it("does not start another attempt when aborted during backoff", async () => {
    const abortController = new AbortController();
    const operation = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
      );

    const promise = retryWithPolicy({
      policy: {
        retries: 1,
        retryDelayMs: 25,
      },
      signal: abortController.signal,
      operation: async () => operation(),
      shouldRetryError: () => true,
    });

    setTimeout(() => abortController.abort(new Error("Request cancelled")), 5);

    await expect(promise).rejects.toThrow("Request cancelled");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
