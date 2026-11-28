import { describe, expect, it, vi } from "vitest";
import { ProtocolError, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import type { ProbeMcpServerConfig, ProbeMcpServerResult } from "@mcpjam/sdk";
import { runServerProbes } from "../probe-runner.js";
import { MAX_UI_RESOURCE_READS, UI_READS_SAMPLED } from "../probes/apps-probe.js";
import {
  HTML,
  byId,
  capture,
  doctorState,
  recordingFetch,
  recordingManager,
  skillFile,
} from "./probe-fixtures.js";

const ok = { status: "ok" as const, detail: "" };
const listingFailed = { status: "error" as const, detail: "tools/list failed" };

function run(
  options: Parameters<typeof recordingManager>[0] = {},
  doctor = doctorState(),
) {
  const recorded = recordingManager(options);
  const summaries = runServerProbes({
    hosted: false,
    manager: recorded.manager,
    managerKey: "Fixture",
    capture: capture("stdio", doctor),
  }).summaries;
  return { ...recorded, summaries };
}

describe("probes after the capture", () => {
  it("reads the Apps tools' _meta from the capture's toolsMetadata", async () => {
    const { summaries, reads } = run({
      read: async (uri) => (uri.startsWith("skill://") ? skillFile(uri) : { contents: [{ ...HTML, uri }] }),
    });
    const apps = byId(await summaries)["apps-ui-resources"];
    expect(reads.filter((uri) => uri.startsWith("ui://")).sort()).toEqual([
      "ui://chart",
      "ui://needs-input",
    ]);
    expect(apps?.checks).toMatchObject({
      "apps:ui-tools-present": "passed",
      "apps:ui-resources-readable": "passed",
    });
  });

  it("grades the read checks on a sample when the server has more UI resources than the cap", async () => {
    const uris = Array.from({ length: MAX_UI_RESOURCE_READS + 2 }, (_, i) => `ui://view-${i}`);
    const { summaries, reads } = run(
      {
        read: async (uri) =>
          uri.startsWith("skill://") ? skillFile(uri) : { contents: [{ ...HTML, uri }] },
      },
      doctorState({
        tools: uris.map((_, i) => ({ name: `view-${i}`, inputSchema: { type: "object" } })),
        toolsMetadata: Object.fromEntries(
          uris.map((uri, i) => [`view-${i}`, { ui: { resourceUri: uri } }]),
        ),
        resources: uris.map((uri) => ({ uri, name: uri, mimeType: HTML.mimeType })),
      }),
    );
    const apps = byId(await summaries)["apps-ui-resources"];
    expect(reads.filter((uri) => uri.startsWith("ui://"))).toHaveLength(MAX_UI_RESOURCE_READS);
    expect(apps).toMatchObject({
      status: "ok",
      // A sample cannot show that no UI resource declares a field.
      coverage: "partial",
      detail: UI_READS_SAMPLED,
      values: {
        uiResourceCount: MAX_UI_RESOURCE_READS + 2,
        readCount: MAX_UI_RESOURCE_READS,
        readFailures: 0,
        htmlProfileOk: true,
      },
    });
    expect(apps?.checks).toMatchObject({
      "apps:ui-resources-readable": "passed",
      "apps:ui-resource-contents-valid": "passed",
    });
  });

  it("does not run the Apps probe on incomplete lists, so the last good result stays", async () => {
    const doctor = doctorState();
    const { summaries, reads } = run(
      {},
      doctorState({ checks: { ...doctor.checks, tools: listingFailed } }),
    );
    const probes = byId(await summaries);
    expect(probes["apps-ui-resources"]).toMatchObject({
      status: "failed",
      coverage: "not-captured",
      detail: expect.stringContaining("did not list"),
    });
    expect(probes["apps-ui-resources"]?.checks).toBeUndefined();
    expect(reads.some((uri) => uri.startsWith("ui://"))).toBe(false);
    expect(probes.skills?.status).toBe("ok");
  });

  it("reports the list-based probes failed when the capture has no lists", async () => {
    const recorded = recordingManager();
    const { doctor: _none, ...failedCapture } = capture("stdio");
    const probes = byId(
      await runServerProbes({
        hosted: false,
        manager: recorded.manager,
        managerKey: "Fixture",
        capture: failedCapture,
      }).summaries,
    );
    expect(probes["apps-ui-resources"]?.status).toBe("failed");
    expect(probes.skills?.status).toBe("failed");
    expect(recorded.reads).toEqual([]);
  });

  it("does not pass the readable check when there is nothing to read", async () => {
    const { summaries } = run(
      {},
      doctorState({ tools: [], toolsMetadata: {}, resources: [], skills: [] }),
    );
    const apps = byId(await summaries)["apps-ui-resources"];
    expect(apps).toMatchObject({ status: "ok", coverage: "complete", values: { readCount: 0 } });
    expect(Object.keys(apps?.checks ?? {})).not.toContain("apps:ui-resources-readable");
  });
});

describe("read failures", () => {
  it("never grades a UI read that timed out or lost its connection", async () => {
    for (const error of [
      new SdkError(SdkErrorCode.RequestTimeout, "Request timed out"),
      new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed"),
      new TypeError("fetch failed"),
    ]) {
      const { summaries } = run({
        read: async (uri) => {
          if (uri.startsWith("skill://")) return skillFile(uri);
          throw error;
        },
      });
      const apps = byId(await summaries)["apps-ui-resources"];
      expect(apps).toMatchObject({
        status: "ok",
        coverage: "partial",
        detail: "A UI resource read got no answer in time.",
        values: { readCount: 0, readFailures: 0 },
      });
      const statuses = Object.values(apps?.checks ?? {});
      expect(statuses).not.toContain("failed");
      expect(Object.keys(apps?.checks ?? {})).not.toContain("apps:ui-resources-readable");
    }
  });

  it("grades a UI read the server answered with an error", async () => {
    const { summaries } = run({
      read: async (uri) => {
        if (uri.startsWith("skill://")) return skillFile(uri);
        throw new ProtocolError(-32603, "boom");
      },
    });
    const apps = byId(await summaries)["apps-ui-resources"];
    expect(apps?.values).toMatchObject({ readCount: 0, readFailures: 2 });
    expect(apps?.checks).toMatchObject({ "apps:ui-resources-readable": "failed" });
  });

  it("abandons events/list on a closed connection and fails it on an error answer", async () => {
    const closed = byId(
      await run({
        listServerEvents: async () => {
          throw new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed");
        },
      }).summaries,
    )["events-list"];
    expect(closed).toMatchObject({
      status: "abandoned",
      checks: { "events:events-capability-declared": "passed" },
    });
    expect(Object.keys(closed?.checks ?? {})).not.toContain("events:events-list-shape");

    const refused = byId(
      await run({
        listServerEvents: async () => {
          throw new ProtocolError(-32601, "Method not found");
        },
      }).summaries,
    )["events-list"];
    expect(refused).toMatchObject({
      status: "failed",
      checks: { "events:events-list-shape": "failed" },
    });
  });

  it("does not count a skill read that got no answer as a failure", async () => {
    const { summaries } = run({
      read: async (uri) => {
        if (uri.startsWith("skill://")) {
          throw new SdkError(SdkErrorCode.RequestTimeout, "Request timed out");
        }
        return { contents: [{ ...HTML, uri }] };
      },
    });
    expect(byId(await summaries).skills).toMatchObject({
      status: "ok",
      coverage: "partial",
      values: { verified: 0, digestFailures: 0, frontmatterFailures: 0 },
    });
  });
});

describe("private destinations", () => {
  const PUBLIC_URL = "https://srv.example.com/mcp";

  function cardRedirectingTo(landing: string) {
    const { fetchFn } = recordingFetch();
    const redirecting: typeof fetch = async (input, init) => {
      if (String(input) === `${PUBLIC_URL}/server-card`) {
        const response = new Response(JSON.stringify({ name: "x" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
        Object.defineProperty(response, "url", { value: landing });
        return response;
      }
      return fetchFn(input, init);
    };
    return redirecting;
  }

  async function probesFor(privateTarget: boolean, hosted = false) {
    const configs: ProbeMcpServerConfig[] = [];
    const resolvePrivate = vi.fn(async () => privateTarget);
    const probeServer = vi.fn(
      async (config: ProbeMcpServerConfig): Promise<ProbeMcpServerResult> => {
        configs.push(config);
        return {
          url: config.url,
          protocolVersion: "2025-11-25",
          status: "error",
          transport: { attempts: [] },
          oauth: { required: false, optional: false, registrationStrategies: [] },
          error: "unreachable",
        };
      },
    );
    const summaries = await runServerProbes(
      {
        hosted,
        manager: recordingManager().manager,
        managerKey: "Fixture",
        serverUrl: PUBLIC_URL,
        capture: capture(),
      },
      {
        fetchFn: cardRedirectingTo("http://127.0.0.1:9/card"),
        probeServer,
        privateTarget: resolvePrivate,
      },
    ).summaries;
    return { configs, card: byId(summaries)["server-card"], resolvePrivate };
  }

  it("keeps a public server's probes off loopback and the LAN", async () => {
    const { configs, card } = await probesFor(false);
    expect(configs.map((config) => config.allowPrivateNetwork)).toEqual([false]);
    // The hosted card redirected to loopback, so it was not used.
    expect(card).toMatchObject({ coverage: "partial", values: { serverCardFound: false } });
  });

  it("lets a private server's probes follow private pointers", async () => {
    const { configs, card } = await probesFor(true);
    expect(configs.map((config) => config.allowPrivateNetwork)).toEqual([true]);
    expect(card?.values.serverCardFound).toBe(true);
  });

  it("keeps a hosted run's probes off private addresses, even for a private server", async () => {
    const { configs, card, resolvePrivate } = await probesFor(true, true);
    expect(resolvePrivate).not.toHaveBeenCalled();
    expect(configs.map((config) => config.allowPrivateNetwork)).toEqual([false]);
    expect(card).toMatchObject({ coverage: "partial", values: { serverCardFound: false } });
  });
});
