import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../route-error-report.js", () => ({
  reportRouteFailure: vi.fn(() => ({
    normalized: { slug: "transport/fetch_failed" },
    origin: "ambiguous",
  })),
}));

const requestEvent = vi.fn();
const systemEvent = vi.fn();
vi.mock("../request-logger.js", () => ({
  getRequestLogger: vi.fn(() => ({ event: requestEvent })),
  getSystemLogger: vi.fn(() => ({ event: systemEvent })),
}));

import { reportRouteFailure } from "../route-error-report.js";
import {
  createRequestStreamFailureReporter,
  createSystemStreamFailureReporter,
  oncePerTurn,
  type StreamFailureEvent,
} from "../stream-failure-reporter.js";

const failure = (over: Partial<StreamFailureEvent> = {}): StreamFailureEvent => ({
  message: "[test] turn failed",
  error: new Error("upstream reset"),
  source: "mcp.chat-v2.engine-step",
  hop: "user_server_hop",
  transport: "http_stream",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("stream failure reporter", () => {
  it("classifies first, then emits the typed event with the EFFECTIVE origin", () => {
    const report = createRequestStreamFailureReporter({} as never, "chat")(
      failure(),
    );

    // Classification went through reportRouteFailure (capture ordering,
    // Sentry stamp, free-form row all live there).
    expect(reportRouteFailure).toHaveBeenCalledTimes(1);
    expect(report.origin).toBe("ambiguous");

    expect(requestEvent).toHaveBeenCalledTimes(1);
    const [name, payload] = requestEvent.mock.calls[0];
    expect(name).toBe("route.operation.failed");
    // origin comes from the capture decision's return, slug from its
    // normalized — never re-derived here.
    expect(payload).toMatchObject({
      transport: "http_stream",
      source: "mcp.chat-v2.engine-step",
      hop: "user_server_hop",
      origin: "ambiguous",
      slug: "transport/fetch_failed",
      errorMessage: "upstream reset",
    });
  });

  it("caps the errorMessage at 500 chars", () => {
    createRequestStreamFailureReporter({} as never, "chat")(
      failure({ error: new Error("x".repeat(2000)) }),
    );
    expect(requestEvent.mock.calls[0][1].errorMessage).toHaveLength(500);
  });

  it("system variant emits through the system logger", () => {
    createSystemStreamFailureReporter("assistant-turn")(failure());
    expect(systemEvent).toHaveBeenCalledTimes(1);
    expect(requestEvent).not.toHaveBeenCalled();
  });

  it("oncePerTurn emits one typed event but still classifies every failure", () => {
    const wrapped = oncePerTurn(
      createRequestStreamFailureReporter({} as never, "chat"),
    );

    wrapped(failure({ source: "mcp.chat-v2.backend-stream" }));
    const second = wrapped(failure({ source: "mcp.chat-v2.agentic-loop" }));

    // A single turn must not count twice in the operation-failure rate…
    expect(requestEvent).toHaveBeenCalledTimes(1);
    // …but the second failure still gets its capture decision and free-form
    // row (Sentry dedupe is the stamp's job, not ours), and callers still
    // get a usable report back.
    expect(reportRouteFailure).toHaveBeenCalledTimes(2);
    expect(second.origin).toBe("ambiguous");
  });

  it("omits absent optional fields rather than fabricating them", () => {
    createRequestStreamFailureReporter({} as never, "chat")(failure());
    const payload = requestEvent.mock.calls[0][1];
    expect("errorCode" in payload).toBe(false);
    expect("rpcMethod" in payload).toBe(false);
  });
});
