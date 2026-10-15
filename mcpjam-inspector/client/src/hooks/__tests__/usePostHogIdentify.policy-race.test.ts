import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { PostHog } from "posthog-js";
import { installNetworkStub } from "../../__tests__/telemetry-egress/support/jsdom-network";
import {
  vendorRecorder,
  RELAY_PROJECT_ID,
  TELEMETRY_ACTOR_ID,
} from "../../__tests__/telemetry-egress/support/vendor-recorder";
import { posthogEvents, scanAll } from "../../../../e2e/telemetry/egress";

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

function holdFirstCompression() {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const NativeCompressionStream = globalThis.CompressionStream;
  let holdFirst = true;
  vi.stubGlobal(
    "CompressionStream",
    class {
      constructor(format: CompressionFormat) {
        const stream = new NativeCompressionStream(format);
        const delayed = stream.readable.pipeThrough(
          new TransformStream({
            async transform(chunk, controller) {
              if (holdFirst) {
                holdFirst = false;
                started.resolve();
                await release.promise;
              }
              controller.enqueue(chunk);
            },
          }),
        );
        Object.defineProperty(stream, "readable", { value: delayed });
        return stream;
      }
    },
  );
  return { started: started.promise, release: () => release.resolve() };
}

async function setup() {
  vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
  const compression = holdFirstCompression();
  const vendor = vendorRecorder(() => ({
    recording: "full",
    identity: "full",
    content: "full",
    telemetryActorId: TELEMETRY_ACTOR_ID,
  }));
  const network = installNetworkStub(async (request) => {
    await vendor.receive(request);
    return { body: '{"status":1}' };
  });
  await import("@/lib/install-telemetry-transport");
  const { PostHog } = await import("posthog-js");
  const { getPostHogKey, getPostHogOptions } =
    await import("@/lib/PosthogUtils");
  const telemetry = await import("@/lib/telemetry-context");
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
  const hook = renderHook(usePostHogIdentify);
  return { compression, vendor, network, telemetry, client, hook };
}

async function proveConsent({
  client,
  network,
  telemetry,
}: Pick<
  Awaited<ReturnType<typeof setup>>,
  "client" | "network" | "telemetry"
>) {
  const mark = network.requests.length;
  client.set_config({ respect_dnt: true });
  vi.stubGlobal("doNotTrack", "1");
  await act(async () => {
    telemetry.setTelemetryContentPolicy(TELEMETRY_ACTOR_ID, "strict");
    telemetry.setTelemetryContentPolicy(TELEMETRY_ACTOR_ID, "full");
  });
  await network.settle();
  expect(network.requests).toHaveLength(mark);
  vi.stubGlobal("doNotTrack", "0");
  client.opt_out_capturing();
  await act(async () => {
    telemetry.setTelemetryContentPolicy(TELEMETRY_ACTOR_ID, "strict");
    telemetry.setTelemetryContentPolicy(TELEMETRY_ACTOR_ID, "full");
  });
  await network.settle();
  expect(network.requests).toHaveLength(mark);
}

it("retries profile delivery after live policy drops an asynchronously compressed identify", async () => {
  const { compression, vendor, network, telemetry, client, hook } =
    await setup();
  const events = () => posthogEvents(scanAll(vendor.requests).decoded);
  try {
    await act(async () => {
      telemetry.setTelemetryIdentity(TELEMETRY_ACTOR_ID, "full");
      telemetry.setTelemetryContentPolicy(TELEMETRY_ACTOR_ID, "full");
    });
    await compression.started;
    await act(async () => {
      telemetry.setTelemetryContentPolicy(TELEMETRY_ACTOR_ID, "strict");
      compression.release();
      await expect
        .poll(async () => {
          await network.settle();
          return posthogEvents(scanAll(network.requests).decoded).filter(
            (event) => event.event === "$identify",
          ).length;
        })
        .toBe(1);
      expect(
        network.requests.find((request) => request.url.includes("/e/"))
          ?.headers["x-mcpjam-telemetry-policy"],
      ).toBe("strict");
      expect(events().filter((event) => event.$set)).toHaveLength(0);
      telemetry.setTelemetryContentPolicy(TELEMETRY_ACTOR_ID, "full");
    });
    await expect
      .poll(async () => {
        await network.settle();
        return events().filter((event) => event.$set).length;
      })
      .toBe(1);
    expect(events()).toContainEqual(
      expect.objectContaining({
        event: "$set",
        properties: expect.objectContaining({
          distinct_id: TELEMETRY_ACTOR_ID,
        }),
        $set: expect.objectContaining({
          email: "member@example.test",
          name: "Member Fixture",
        }),
      }),
    );
    hook.rerender();
    await network.settle();
    expect(events().filter((event) => event.$set)).toHaveLength(1);
    expect(
      posthogEvents(scanAll(network.requests).decoded).filter(
        (event) => event.event === "$identify",
      ),
    ).toHaveLength(1);
    await proveConsent({ client, network, telemetry });
  } finally {
    compression.release();
    hook.unmount();
    client.opt_out_capturing();
    telemetry.setTelemetryActor(null);
    network.restore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});
