import { format } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { captureException, posthogCapture } = vi.hoisted(() => ({
  captureException: vi.fn(),
  posthogCapture: vi.fn(),
}));
vi.mock("@sentry/node", () => ({ captureException, captureMessage: vi.fn() }));
vi.mock("posthog-node", () => ({
  PostHog: vi.fn(function () {
    return { capture: posthogCapture, shutdown: vi.fn(async () => undefined) };
  }),
}));

import { logger } from "../logger.js";
import { captureServerEventForActor, shutdownAnalytics } from "../analytics.js";
import { registerDeliveredSecret } from "../../../shared/delivered-secret-registry.js";
import { scrubLogText } from "../../../shared/log-scrubber.js";
import { webError, ErrorCode } from "../../routes/web/errors.js";
import { jsonError } from "../mcp-error-serialize.js";
import { rpcLogBus } from "../../services/rpc-log-bus.js";

// No `Bearer` prefix anywhere below: the shape scrubbers cannot see these.
const TOKEN = "tok_EFTW41_SECRET_shared_account";

const printed = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls
    .flat()
    .map((arg) =>
      arg instanceof Error ? String(arg.stack) : JSON.stringify(arg),
    )
    .join("\n");

beforeEach(() => {
  registerDeliveredSecret(TOKEN, "oauth-token");
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DO_NOT_TRACK", "");
  vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "");
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  captureException.mockClear();
  posthogCapture.mockClear();
  await shutdownAnalytics();
});

describe("a credential the backend delivered", () => {
  it("never reaches the server logger's console", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    logger.error(
      `connect failed with ${TOKEN}`,
      new Error(`upstream rejected ${TOKEN}`, { cause: new Error(TOKEN) }),
    );
    logger.warn(`refresh returned ${TOKEN}`);
    logger.info(`using ${TOKEN}`);
    logger.debug(`debug ${TOKEN}`, { header: TOKEN }, TOKEN);

    for (const spy of [error, warn, log]) {
      expect(spy).toHaveBeenCalled();
      expect(printed(spy)).not.toContain(TOKEN);
    }
    expect(printed(error)).toContain("[redacted-oauth-token]");
  });

  it("is replaced when a format specifier prints a nested object", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const nested = { a: { b: { c: { token: TOKEN } } } };

    logger.debug("%j", nested);
    logger.error("%j", nested);

    // What the console renders from those arguments.
    for (const spy of [log, error]) {
      expect(format(...(spy.mock.calls[0] as [string]))).not.toContain(TOKEN);
    }
  });

  it("is replaced in what the logger hands Sentry", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    logger.error(`connect failed with ${TOKEN}`, new Error("boom"), {
      detail: { reason: `server said ${TOKEN}` },
    });
    expect(captureException).toHaveBeenCalledOnce();
    const [, hint] = captureException.mock.calls[0];
    expect(JSON.stringify(hint.extra)).not.toContain(TOKEN);
    expect(hint.extra.message).toBe(
      "connect failed with [redacted-oauth-token]",
    );
  });

  it("is replaced in server-side PostHog properties", () => {
    captureServerEventForActor(
      { distinctId: "user_01H00000000000000000000000" },
      "send_message_server",
      { origin: "playground", note: `failed with ${TOKEN}` },
    );
    expect(posthogCapture).toHaveBeenCalledOnce();
    const [{ properties }] = posthogCapture.mock.calls[0];
    expect(JSON.stringify(properties)).not.toContain(TOKEN);
    expect(properties.origin).toBe("playground");
  });

  it("is replaced by the shared telemetry scrubber", () => {
    expect(scrubLogText(`error: ${TOKEN} expired`)).toBe(
      "error: [redacted-oauth-token] expired",
    );
  });

  it("is replaced in error bodies sent to the browser", () => {
    const bodies: unknown[] = [];
    const c = {
      set: vi.fn(),
      json: (body: unknown) => (bodies.push(body), body),
    };
    webError(c, 502, ErrorCode.SERVER_UNREACHABLE, `upstream said ${TOKEN}`);
    jsonError(c, new Error(`upstream said ${TOKEN}`), 502);
    expect(JSON.stringify(bodies)).not.toContain(TOKEN);
  });

  it("is replaced in the Logs panel feed", () => {
    const seen: unknown[] = [];
    const unsubscribe = rpcLogBus.subscribe(["srv-echo"], (event) =>
      seen.push(event),
    );
    rpcLogBus.publish({
      serverId: "srv-echo",
      direction: "receive",
      timestamp: new Date().toISOString(),
      message: { jsonrpc: "2.0", id: 1, result: { echoed: TOKEN } },
    } as never);
    unsubscribe();
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
  });
});
