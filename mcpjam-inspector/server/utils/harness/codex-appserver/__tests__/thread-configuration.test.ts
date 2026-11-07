import { expect, it, vi } from "vitest";
import { openConfiguredThread } from "../bridge/thread-configuration.js";

it.each([true, false])(
  "preserves the previous transcript when restart=%s",
  async (restart) => {
    const request = vi.fn(
      async <T>(_method: string, _params: unknown): Promise<T> =>
        ({ thread: { id: "current" } }) as T,
    );
    const config = {
      config: { mcp_servers: { app: { command: "new-app-catalog" } } },
      developerInstructions: "current instructions",
    };
    await openConfiguredThread(
      { request },
      config,
      "prior-transcript",
      restart,
    );
    expect(request).toHaveBeenCalledWith(
      restart ? "thread/fork" : "thread/resume",
      { ...config, threadId: "prior-transcript" },
    );
  },
);
it("starts empty only when there is no previous thread", async () => {
  const request = vi.fn(
    async <T>(): Promise<T> => ({ thread: { id: "new" } }) as T,
  );
  await openConfiguredThread({ request }, {}, undefined, true);
  expect(request).toHaveBeenCalledWith("thread/start", {});
});
