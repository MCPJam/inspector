import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PostHog } from "posthog-js";
import { installNetworkStub } from "../../__tests__/telemetry-egress/support/jsdom-network";
import {
  vendorRecorder,
  RELAY_PROJECT_ID,
  TELEMETRY_ACTOR_ID,
} from "../../__tests__/telemetry-egress/support/vendor-recorder";
import { scanAll, posthogEvents } from "../../../../e2e/telemetry/egress";

const state = vi.hoisted(() => ({ client: undefined as PostHog | undefined }));
vi.mock("posthog-js/react", () => ({ usePostHog: () => state.client }));
vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({
    user: {
      id: "user_01K00000000000000000000000",
      email: "member@example.test",
      firstName: "Member",
      lastName: "Fixture",
    },
    getAccessToken: async () => "fixture",
  }),
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true }),
  useQuery: () => null,
}));
vi.mock("@/hooks/use-actor-key", () => ({
  useActorKey: () => "user_01K00000000000000000000000",
}));
vi.mock("@/lib/server-feature-flags", () => ({
  refreshServerFeatureFlagsForActor: async () => {},
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function setupIdentityFixture() {
  vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
  const vendor = vendorRecorder(() => ({
    recording: "full",
    identity: "full",
    content: "full",
    telemetryActorId: TELEMETRY_ACTOR_ID,
  }));
  const network = installNetworkStub(async (request) => {
    await vendor.receive(request);
    return { body: '{"status":1,"featureFlags":{}}' };
  });
  await import("@/lib/install-telemetry-transport");
  const { PostHog } = await import("posthog-js");
  const { getPostHogKey, getPostHogOptions } =
    await import("@/lib/PosthogUtils");
  const telemetry = await import("@/lib/telemetry-context");
  const { setSessionPrivacy } = await import("@/lib/session-privacy");
  const { usePostHogIdentify } = await import("../usePostHogIdentify");
  const client = new PostHog();
  state.client = client;
  client.init(getPostHogKey(), {
    ...getPostHogOptions(),
    bootstrap: {
      distinctID: "019a0000-0000-7000-8000-000000000099",
      isIdentifiedID: false,
    },
    api_host: `${window.location.origin}/tlm`,
    capture_pageview: false,
    autocapture: false,
    request_batching: false,
    advanced_disable_feature_flags: true,
    persistence: "memory",
    request_headers: { Authorization: "Bearer synthetic-member" },
  });
  telemetry.setTelemetryActor(TELEMETRY_ACTOR_ID);
  telemetry.setTelemetryCaptureContext({
    projectIds: [RELAY_PROJECT_ID],
    organizationIds: [],
  });
  setSessionPrivacy("pending");
  return {
    client,
    telemetry,
    network,
    vendor,
    setSessionPrivacy,
    usePostHogIdentify,
  };
}

async function proveUnload(
  fixture: Awaited<ReturnType<typeof setupIdentityFixture>>,
) {
  const { client, telemetry, network, vendor } = fixture;
  client.set_config({ request_batching: true });
  client.capture("full_unload_control", { safe: "full" });
  window.dispatchEvent(
    new PageTransitionEvent("pagehide", { persisted: true }),
  );
  await expect
    .poll(async () => {
      await network.settle();
      return posthogEvents(scanAll(vendor.requests).decoded).filter(
        (row) => row.event === "full_unload_control",
      ).length;
    })
    .toBe(1);
  const sends = network.requests.filter((request) =>
    /\/(e|i\/v0\/e)\/?/.test(new URL(request.url).pathname),
  );
  expect(sends.length).toBeGreaterThan(0);
  expect(sends.every((request) => request.transport === "fetch")).toBe(true);
  expect(sends.at(-1)?.headers).toMatchObject({
    authorization: "Bearer synthetic-member",
    "x-mcpjam-telemetry-policy": "full",
  });
  client.capture("must_drop_queued_full");
  telemetry.setTelemetryContentPolicy(TELEMETRY_ACTOR_ID, "strict");
  window.dispatchEvent(
    new PageTransitionEvent("pagehide", { persisted: true }),
  );
  await network.settle();
  expect(
    posthogEvents(scanAll(vendor.requests).decoded).some(
      (row) => row.event === "must_drop_queued_full",
    ),
  ).toBe(false);
}

it("identifies once after content resolves and preserves unload policy with the installed SDK", async () => {
  const fixture = await setupIdentityFixture();
  const {
    client,
    telemetry,
    network,
    vendor,
    setSessionPrivacy,
    usePostHogIdentify,
  } = fixture;
  const anonymous = client.get_distinct_id();
  const hook = renderHook(usePostHogIdentify);
  try {
    expect(client.get_distinct_id()).toBe(anonymous);
    await act(async () => {
      telemetry.setTelemetryIdentity(TELEMETRY_ACTOR_ID, "full");
      telemetry.setTelemetryContentPolicy(TELEMETRY_ACTOR_ID, "full");
    });
    expect(telemetry.currentTelemetryCaptureContext().policy.content).toBe(
      "full",
    );
    expect(client.has_opted_out_capturing()).toBe(false);
    expect(client.get_distinct_id()).toBe(TELEMETRY_ACTOR_ID);
    await expect
      .poll(async () => {
        await network.settle();
        return posthogEvents(scanAll(vendor.requests).decoded).filter(
          (event) => event.event === "$identify",
        ).length;
      })
      .toBe(1);
    const events = posthogEvents(scanAll(vendor.requests).decoded);
    const identify = events.filter((event) => event.event === "$identify");
    expect(identify).toHaveLength(1);
    expect(identify[0]).toMatchObject({
      properties: { $anon_distinct_id: anonymous },
      $set: { email: "member@example.test" },
    });
    expect(telemetry.currentTelemetryCaptureContext().policy.recording).toBe(
      "off",
    );
    await act(async () => {
      setSessionPrivacy("full");
      hook.rerender();
    });
    await network.settle();
    expect(
      posthogEvents(scanAll(vendor.requests).decoded).filter(
        (event) => event.event === "$identify",
      ),
    ).toHaveLength(1);
    await proveUnload(fixture);
  } finally {
    hook.unmount();
    client.stopSessionRecording();
    client.opt_out_capturing();
    telemetry.setTelemetryActor(null);
    network.restore();
  }
});
