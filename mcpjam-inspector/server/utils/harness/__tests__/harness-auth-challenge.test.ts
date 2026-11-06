/**
 * Harness turns never start a mid-session sign-in. Their MCP tools run
 * out of process (proxy) or host-executed, and both report through
 * `scopeStepUpInfoFromToolError`, which stays blind to 401s: a 401 there is
 * an ordinary tool error, never a Connect card or a redirect.
 */
import { InsufficientScopeError } from "@modelcontextprotocol/client";
import { parseChallengeHeader } from "@mcpjam/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetHarnessScopeStepUpForTests,
  publishHarnessScopeStepUpFromToolError,
  subscribeHarnessScopeStepUp,
} from "../harness-scope-step-up.js";

const TURN = "11111111-1111-4111-8111-111111111111";

function http401(): Error {
  return Object.assign(new Error("Error POSTing to endpoint (HTTP 401)"), {
    status: 401,
    data: {
      authChallenge: parseChallengeHeader(
        'Bearer error="invalid_token", scope="orders:read", resource_metadata="https://orders.example/.well-known/oauth-protected-resource"',
      ),
    },
  });
}

describe("harness turns and mid-session sign-in", () => {
  beforeEach(() => __resetHarnessScopeStepUpForTests());

  it("does not publish anything for a 401 from a harness tool", () => {
    const listener = vi.fn();
    subscribeHarnessScopeStepUp(TURN, listener, ["orders"]);

    publishHarnessScopeStepUpFromToolError(TURN, {
      error: http401(),
      serverId: "orders",
      toolCallId: "call-1",
      toolName: "get_my_orders",
      toolInput: {},
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("still publishes a 403 step-up, as before", () => {
    const listener = vi.fn();
    subscribeHarnessScopeStepUp(TURN, listener, ["orders"]);

    publishHarnessScopeStepUpFromToolError(TURN, {
      error: new InsufficientScopeError({ requiredScope: "orders:write" }),
      serverId: "orders",
      toolCallId: "call-1",
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      requiredScope: "orders:write",
    });
  });
});
