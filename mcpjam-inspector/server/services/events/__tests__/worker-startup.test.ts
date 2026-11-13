import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventsBackendClient } from "../backend-client.js";
import { startEventsExecutor } from "../executor.js";
import { startEventsKeeper } from "../keeper.js";

const workers: Array<{ stop(): Promise<void> }> = [];

beforeEach(() => {
  vi.stubEnv("MCPJAM_PROCESS_ROLE", undefined);
  vi.stubEnv("EVENTS_KEEPER_ENABLED", undefined);
  vi.stubEnv("EVENTS_EXECUTOR_ENABLED", undefined);
});

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("events worker startup", () => {
  it.each([false, true])(
    "does not start or wake claim loops on a web replica (injected: %s)",
    async (injected) => {
      vi.stubEnv("MCPJAM_PROCESS_ROLE", "web");
      vi.stubEnv("CONVEX_HTTP_URL", "https://events-test.convex.site");
      vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "events-worker-test-credential");
      const claimSubscriptions = vi
        .spyOn(EventsBackendClient.prototype, "claimSubscriptions")
        .mockResolvedValue([]);
      const claimRun = vi
        .spyOn(EventsBackendClient.prototype, "claimRun")
        .mockResolvedValue(null);
      const options = injected
        ? { deps: { backend: new EventsBackendClient() } }
        : undefined;
      const keeper = startEventsKeeper(options);
      const executor = startEventsExecutor(options);
      workers.push(keeper, executor);

      keeper.kick();
      executor.kick();
      await Promise.all([keeper.stop(), executor.stop()]);
      expect(claimSubscriptions).not.toHaveBeenCalled();
      expect(claimRun).not.toHaveBeenCalled();
    },
  );

  it.each([
    [undefined, undefined],
    ["all", "0"],
    ["worker", "0"],
  ])(
    "claims work with role %s when the old switches are %s",
    async (role, oldValue) => {
      vi.stubEnv("MCPJAM_PROCESS_ROLE", role);
      vi.stubEnv("CONVEX_HTTP_URL", "https://events-test.convex.site");
      vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "events-worker-test-credential");
      vi.stubEnv("EVENTS_KEEPER_ENABLED", oldValue);
      vi.stubEnv("EVENTS_EXECUTOR_ENABLED", oldValue);
      const claimSubscriptions = vi
        .spyOn(EventsBackendClient.prototype, "claimSubscriptions")
        .mockResolvedValue([]);
      const claimRun = vi
        .spyOn(EventsBackendClient.prototype, "claimRun")
        .mockResolvedValue(null);
      const keeper = startEventsKeeper();
      const executor = startEventsExecutor();
      workers.push(keeper, executor);

      await vi.waitFor(() => {
        expect(claimSubscriptions).toHaveBeenCalledTimes(1);
        expect(claimRun).toHaveBeenCalledTimes(1);
      });
      keeper.kick();
      executor.kick();
      await vi.waitFor(() => {
        expect(claimSubscriptions).toHaveBeenCalledTimes(2);
        expect(claimRun).toHaveBeenCalledTimes(2);
      });
    },
  );

  it.each(["CONVEX_HTTP_URL", "INSPECTOR_SERVICE_TOKEN"])(
    "does not claim work when %s is missing",
    async (missing) => {
      vi.stubEnv("CONVEX_HTTP_URL", "https://events-test.convex.site");
      vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "events-worker-test-credential");
      vi.stubEnv(missing, undefined);
      const claimSubscriptions = vi.spyOn(
        EventsBackendClient.prototype,
        "claimSubscriptions",
      );
      const claimRun = vi.spyOn(EventsBackendClient.prototype, "claimRun");
      const keeper = startEventsKeeper();
      const executor = startEventsExecutor();
      workers.push(keeper, executor);

      keeper.kick();
      executor.kick();
      await Promise.all([keeper.stop(), executor.stop()]);
      expect(claimSubscriptions).not.toHaveBeenCalled();
      expect(claimRun).not.toHaveBeenCalled();
    },
  );
});
