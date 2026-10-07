import { beforeEach, describe, expect, it, vi } from "vitest";

const { trackMock } = vi.hoisted(() => ({ trackMock: vi.fn() }));
vi.mock("@/lib/analytics", () => ({ track: trackMock }));
vi.mock("@/lib/config", () => ({ HOSTED_MODE: true }));

import { createConnectOutcomeTracker } from "../connect-outcome-telemetry";
import { OAUTH_AUTHORIZATION_CANCELLED_MESSAGE } from "../hosted-oauth-resume";

const config = { url: "https://secret.example.com/mcp" } as never;

function setup() {
  let clock = 1_000;
  const tracker = createConnectOutcomeTracker(() => clock);
  const dispatched: unknown[] = [];
  const dispatch = tracker.wrapDispatch((a) => dispatched.push(a));
  return {
    dispatch,
    dispatched,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const lastProps = () => trackMock.mock.calls.at(-1)?.[1];

beforeEach(() => trackMock.mockReset());

describe("connect outcome telemetry", () => {
  it("emits one event per attempt with its flow and duration", () => {
    const { dispatch, dispatched, advance } = setup();
    dispatch({ type: "CONNECT_REQUEST", name: "srv", config });
    advance(250);
    dispatch({ type: "CONNECT_SUCCESS", name: "srv", config, useOAuth: true });
    // The wrapped dispatch still forwards every action.
    expect(dispatched).toHaveLength(2);
    expect(trackMock).toHaveBeenCalledTimes(1);
    expect(trackMock).toHaveBeenCalledWith("server_connect_outcome", {
      outcome: "success",
      flow: "connect",
      hosted: true,
      transport: "http",
      auth: "oauth",
      duration_ms: 250,
    });
  });

  it("labels a reconnect failure with its slug and HTTP status", () => {
    const { dispatch } = setup();
    dispatch({ type: "RECONNECT_REQUEST", name: "srv", config });
    dispatch({
      type: "CONNECT_FAILURE",
      name: "srv",
      error: "The MCP server responded with HTTP 404 Not Found.",
      normalized: { slug: "server/http_error", rawCode: 404 } as never,
    });
    expect(lastProps()).toMatchObject({
      outcome: "failure",
      flow: "reconnect",
      error_slug: "server/http_error",
      http_status: 404,
    });
  });

  it.each([
    [
      "the client deadline",
      "Connection attempt timed out. Click Connect to retry.",
      undefined,
    ],
    ["a timeout slug", "x", "transport/etimedout"],
  ])("classifies %s as a timeout", (_name, error, slug) => {
    const { dispatch } = setup();
    dispatch({
      type: "CONNECT_FAILURE",
      name: "srv",
      error,
      ...(slug ? { normalized: { slug } as never } : {}),
    });
    expect(lastProps()).toMatchObject({
      outcome: "timeout",
      flow: "background",
    });
  });

  it.each([
    OAUTH_AUTHORIZATION_CANCELLED_MESSAGE,
    'Server "srv" requires authorization. Reconnect to sign in with OAuth.',
  ])("classifies %s as cancelled", (error) => {
    const { dispatch } = setup();
    dispatch({ type: "CONNECT_FAILURE", name: "srv", error });
    expect(lastProps()).toMatchObject({ outcome: "cancelled" });
  });

  it("emits nothing until an attempt ends, and never a name, URL or error text", () => {
    const { dispatch } = setup();
    dispatch({ type: "CONNECT_REQUEST", name: "srv", config });
    dispatch({ type: "CONNECT_CANCELLED", name: "srv", wasConnected: false });
    expect(trackMock).not.toHaveBeenCalled();
    dispatch({
      type: "CONNECT_FAILURE",
      name: "srv",
      error: "boom at https://secret.example.com",
    });
    const serialized = JSON.stringify(lastProps());
    expect(serialized).not.toContain("srv");
    expect(serialized).not.toContain("secret.example.com");
    expect(serialized).not.toContain("boom");
  });
});
