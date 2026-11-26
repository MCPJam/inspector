/**
 * The filter a `subscriptions/listen` acknowledgement confirms, compared with
 * the one the probe asked for.
 *
 * "The client SHOULD check the acknowledged filter against what it requested
 * and handle any unsupported types gracefully" (2026-07-28 subscriptions.mdx,
 * Acknowledgment). The comparison has to name both directions: what the
 * server left out, and what it confirmed without being asked.
 */

import { describe, expect, it } from "vitest";
import {
  compareAcknowledgedFilter,
  SUBSCRIPTION_ACK_METHOD,
  type SubscriptionFilterWire,
} from "../../src/mcp-conformance/raw-listen.js";

const REQUESTED: SubscriptionFilterWire = {
  toolsListChanged: true,
  promptsListChanged: true,
  resourceSubscriptions: ["test://a", "test://b"],
};

function compare(notifications: unknown) {
  return compareAcknowledgedFilter({
    requestedFilter: REQUESTED,
    messages: [
      { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
      {
        jsonrpc: "2.0",
        method: SUBSCRIPTION_ACK_METHOD,
        params: { notifications },
      },
    ],
  });
}

describe("compareAcknowledgedFilter", () => {
  it("finds no difference when the server acknowledges the requested filter", () => {
    expect(compare({ ...REQUESTED })).toEqual({
      acknowledgedFilter: REQUESTED,
      notAcknowledged: {},
      acknowledgedNotRequested: {},
    });
  });

  it("names the flags and resources the server left out", () => {
    expect(
      compare({ toolsListChanged: true, resourceSubscriptions: ["test://b"] })
    ).toMatchObject({
      notAcknowledged: {
        promptsListChanged: true,
        resourceSubscriptions: ["test://a"],
      },
      acknowledgedNotRequested: {},
    });
  });

  it("names the flags and resources the server confirmed without being asked", () => {
    expect(
      compare({
        ...REQUESTED,
        resourcesListChanged: true,
        resourceSubscriptions: ["test://a", "test://b", "test://c"],
      })
    ).toMatchObject({
      notAcknowledged: {},
      acknowledgedNotRequested: {
        resourcesListChanged: true,
        resourceSubscriptions: ["test://c"],
      },
    });
  });

  it("does not count a flag acknowledged as false", () => {
    expect(compare({ ...REQUESTED, promptsListChanged: false })).toMatchObject({
      notAcknowledged: { promptsListChanged: true },
      acknowledgedNotRequested: {},
    });
  });

  it("treats an acknowledgement with no filter as honoring nothing", () => {
    expect(compare(undefined)).toEqual({
      acknowledgedFilter: {},
      notAcknowledged: REQUESTED,
      acknowledgedNotRequested: {},
    });
  });

  it("returns nothing when the stream carried no acknowledgement", () => {
    expect(
      compareAcknowledgedFilter({
        requestedFilter: REQUESTED,
        messages: [
          { jsonrpc: "2.0", method: "notifications/tools/list_changed" },
        ],
      })
    ).toBeUndefined();
  });
});
