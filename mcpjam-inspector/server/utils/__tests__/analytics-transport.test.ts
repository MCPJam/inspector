import { afterEach, describe, expect, it, vi } from "vitest";
import { analyticsTransport } from "../analytics-transport";
import { rebuildServerAnalytics } from "../../../shared/strict-server-analytics";
import { PostHog } from "posthog-node";

const actor = "user_01H00000000000000000000000";
const host = "https://us.i.posthog.com";
afterEach(() => vi.unstubAllGlobals());

describe("server analytics network boundary", () => {
  it("receives and reconstructs actual posthog-node batches", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    const client = new PostHog("public-token", {
      host,
      disableCompression: true,
      flushAt: 20,
      fetch: analyticsTransport(host, "public-token", () => false),
    });
    client.capture({
      distinctId: actor,
      event: "api_agent_turn_completed",
      properties: {
        outcome: "ok",
        tool_call_count: 2,
        prompt: "PRIVATE_SENTINEL",
      },
    });
    await client.flush();
    await client.shutdown();
    expect(fetch).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(fetch.mock.calls[0][1].body);
    expect(payload.batch[0].properties.tool_call_count).toBe(2);
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_SENTINEL");
  });
  it("reconstructs a queued event and blocks it when DNT changes", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    let disabled = false;
    const send = analyticsTransport(host, "public-token", () => disabled);
    const body = JSON.stringify({
      batch: [
        {
          event: "send_message_server",
          distinct_id: actor,
          properties: {
            origin: "playground",
            tool_name: "PRIVATE_SENTINEL",
            $set: { email: "PRIVATE_SENTINEL" },
          },
          context: "PRIVATE_SENTINEL",
        },
      ],
    });
    const options = { method: "POST" as const, headers: {}, body };
    await send(`${host}/batch/`, options);
    expect(fetch).toHaveBeenCalledTimes(1);
    const landed = JSON.parse(fetch.mock.calls[0][1].body);
    expect(landed.batch[0].properties.origin).toBe("playground");
    expect(JSON.stringify(landed)).not.toContain("PRIVATE_SENTINEL");
    disabled = true;
    await send(`${host}/batch/`, options);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([actor, "0192a3f1-8c5e-7b3d-8f21-6a4c9e0d1b2f"])(
    "keeps flag evaluation for %s while removing person content",
    async (distinctId) => {
      const fetch = vi.fn().mockResolvedValue(new Response("{}"));
      vi.stubGlobal("fetch", fetch);
      const send = analyticsTransport(host, "public-token", () => true);
      await send(`${host}/flags/?v=2`, {
        method: "POST",
        headers: {},
        body: JSON.stringify({
          distinct_id: distinctId,
          person_properties: {
            email: "PRIVATE_SENTINEL",
            deployment: "self_hosted",
            platform: "mac",
            customer: "PRIVATE_SENTINEL",
          },
        }),
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1].body).not.toContain("PRIVATE_SENTINEL");
      expect(JSON.parse(fetch.mock.calls[0][1].body).person_properties).toEqual(
        {
          deployment: "self_hosted",
          platform: "mac",
        },
      );
      expect(JSON.parse(fetch.mock.calls[0][1].body).distinct_id).toBe(
        distinctId,
      );
      await send(`${host}/flags/?v=2`, {
        method: "POST",
        headers: {},
        body: JSON.stringify({ distinct_id: "PRIVATE_SENTINEL" }),
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects unregistered events, malformed identities and invalid scalars", () => {
    expect(rebuildServerAnalytics("attacker", actor, {})).toBeNull();
    expect(
      rebuildServerAnalytics("send_message_server", "attacker", {}),
    ).toBeNull();
    expect(
      rebuildServerAnalytics("api_agent_turn_completed", actor, {
        duration_ms: Infinity,
        outcome: "ok",
        tool_call_count: 3,
        op_names: ["PRIVATE_SENTINEL"],
      })?.properties,
    ).toEqual({ outcome: "ok", tool_call_count: 3 });
  });
});
