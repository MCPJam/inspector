import type {
  HarnessV1,
  HarnessV1StartOptions,
  HarnessV1Session,
} from "@ai-sdk/harness";
import { createHash } from "node:crypto";
import { z } from "zod";
import { logger } from "../logger.js";
import { diskResumeState } from "./local/resume-state.js";
import { warmBridgeCommand } from "./warm-bridge-files.js";

export const WARM_ATTACH_TIMEOUT_MS = 1500;
export const WARM_RETENTION_TIMEOUT_MS = 1500;

const coordinates = z.object({
  data: z.object({
    bridge: z.object({
      port: z.number().int().positive(),
      token: z.string().min(1),
    }),
  }),
});

function withoutSpawn<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, key) {
      if (key === "spawn")
        return () => {
          throw new Error("Warm bridge is unavailable.");
        };
      const value = Reflect.get(object, key);
      if (key === "restricted" && typeof value === "function")
        return () => withoutSpawn(value.call(object));
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

/** A warm attempt cannot dispatch a prompt or spawn a replacement process. */
export function withWarmBridgeRuntime<T extends HarnessV1>(
  factory: (startupTimeoutMs?: number, sandboxHomeDir?: string) => T,
  configuration: string,
): T {
  const ordinary = factory();

  return new Proxy(ordinary, {
    get(target, key) {
      if (key !== "doStart") {
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (options: HarnessV1StartOptions) => {
        options.abortSignal?.throwIfAborted();
        if (!("defaultWorkingDirectory" in options.sandboxSession))
          return target.doStart(options);
        const bootstrap = await target.getBootstrap?.({
          abortSignal: options.abortSignal,
        });
        const fingerprint = createHash("sha256")
          .update(configuration)
          .update(JSON.stringify(bootstrap?.files ?? []))
          .digest("hex");
        const saved = coordinates.safeParse(options.resumeFrom);
        let session: HarnessV1Session | undefined;
        // Resume approvals through the original adapter, then retain the
        // completed process through the same detach path as an ordinary turn.
        if (saved.success && !options.continueFrom) {
          const abort = new AbortController();
          const signal = options.abortSignal
            ? AbortSignal.any([options.abortSignal, abort.signal])
            : abort.signal;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const attempt = async () => {
            const result = await options.sandboxSession.run({
              command: warmBridgeCommand({
                sessionId: options.sessionId,
                configuration: fingerprint,
                ...saved.data.data.bridge,
                park: false,
                includeHome: true,
              }),
              abortSignal: signal,
            });
            const probe = z.object({ ready: z.literal(true), home: z.string().optional() })
              .safeParse(JSON.parse(result.stdout));
            if (result.exitCode !== 0 || !probe.success)
              throw new Error("Warm bridge identity or configuration changed.");
            // This value comes from the current, identity-checked sandbox command,
            // never the persisted resume payload or a client-supplied path.
            const home = probe.data.home;
            const sandboxHomeDir = home?.startsWith("/") && !home.includes("\0")
              ? home : undefined;
            signal.throwIfAborted();
            return factory(WARM_ATTACH_TIMEOUT_MS, sandboxHomeDir).doStart({
              ...options,
              abortSignal: signal,
              sandboxSession: withoutSpawn(options.sandboxSession),
            });
          };
          const pending = Promise.resolve(attempt());
          try {
            session = await Promise.race([
              pending,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  abort.abort();
                  reject(new Error("Warm bridge deadline exceeded."));
                }, WARM_ATTACH_TIMEOUT_MS);
              }),
            ]);
            logger.info("[harness] warm bridge attached", {
              harness: target.harnessId,
            });
          } catch {
            // No prompt was dispatched. A late attach only detaches its socket;
            // it must neither retain a socket nor stop the replacement process.
            void pending
              .then(
                (late) => late.doDetach(),
                () => undefined,
              )
              .catch(() => {
                logger.warn("[harness] late warm socket cleanup failed", {
                  harness: target.harnessId,
                });
              });
            options.abortSignal?.throwIfAborted();
            logger.info(
              "[harness] warm bridge unavailable; resuming from disk",
              { harness: target.harnessId },
            );
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
        session ??= await target.doStart({
          ...options,
          ...(options.resumeFrom && !options.continueFrom
            ? { resumeFrom: diskResumeState(options.resumeFrom) }
            : {}),
        });
        const active = session;
        return new Proxy(active, {
          get(current, property) {
            if (property === "doDetach")
              return async () => {
                const state = await current.doDetach();
                const bridge = coordinates.safeParse(state);
                if (bridge.success) {
                  const abort = new AbortController();
                  let timer: ReturnType<typeof setTimeout> | undefined;
                  try {
                    const write = options.sandboxSession.run({
                      command: warmBridgeCommand({
                        sessionId: options.sessionId,
                        configuration: fingerprint,
                        ...bridge.data.data.bridge,
                        park: true,
                      }),
                      abortSignal: abort.signal,
                    });
                    const result = await Promise.race([
                      write,
                      new Promise<never>((_, reject) => {
                        timer = setTimeout(() => {
                          abort.abort();
                          reject(
                            new Error("Bridge retention deadline exceeded."),
                          );
                        }, WARM_RETENTION_TIMEOUT_MS);
                      }),
                    ]);
                    if (result.exitCode !== 0)
                      logger.info("[harness] bridge could not be retained", {
                        harness: target.harnessId,
                      });
                  } catch {
                    // Persistence is an optimization; disk state is already complete.
                    logger.info("[harness] bridge retention unavailable", {
                      harness: target.harnessId,
                    });
                  } finally {
                    if (timer) clearTimeout(timer);
                  }
                }
                return state;
              };
            const value = Reflect.get(current, property);
            return typeof value === "function" ? value.bind(current) : value;
          },
        });
      };
    },
  });
}
