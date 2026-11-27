import { describe, expect, it, vi } from "vitest";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/client";
import {
  PROBE_VALUE_KEYS,
  SERVER_PROBE_IDS,
  isBackgroundSafeCheck,
  isConformanceCheckRef,
} from "@mcpjam/sdk";
import { needsConnection, runServerProbes } from "../probe-runner.js";
import { LOCAL_LEGACY_EVENTS_SKIPPED } from "../probes/events-probe.js";
import { LOCAL_LEGACY_READS_SKIPPED } from "../probes/input-guard.js";
import { LOCAL_LEGACY_SKILL_READS_SKIPPED } from "../probes/skills-probe.js";
import {
  AS_ORIGIN,
  HTML,
  SECRET,
  SERVER_URL,
  byId,
  capture,
  doctorState,
  recordingFetch,
  recordingManager,
  skillFile,
  skillUri,
} from "./probe-fixtures.js";

describe("runServerProbes", () => {
  it("sends only read-only requests and never a forbidden method or request", async () => {
    const { manager, forbidden, managerCalls, reads } = recordingManager();
    const { fetchFn, calls } = recordingFetch();
    const run = runServerProbes(
      {
        hosted: false,
        manager,
        managerKey: "Fixture",
        serverUrl: SERVER_URL,
        capture: capture(),
      },
      { fetchFn, now: () => 7 },
    );
    const summaries = await run.summaries;

    expect(forbidden).toEqual([]);
    expect(new Set(managerCalls)).toEqual(
      new Set([
        "getManagedClient",
        "getEventsSupport",
        "getServerSkillResult",
        "listServerEvents",
      ]),
    );
    expect(reads.sort()).toEqual([
      skillUri("a"),
      skillUri("b"),
      "ui://chart",
      "ui://needs-input",
    ]);

    for (const call of calls) {
      expect(["GET", "POST"]).toContain(call.method);
      if (call.method === "POST") {
        expect(JSON.parse(call.body ?? "{}").method).toBe("initialize");
        expect(call.url.startsWith("https://srv.example.com/mcp")).toBe(true);
      }
      expect(Object.keys(call.headers)).not.toContain("authorization");
      expect(Object.keys(call.headers)).not.toContain("cookie");
      if (!call.url.startsWith("https://srv.example.com/mcp?")) {
        expect(call.url).not.toContain(SECRET);
      }
      // Never the registration, token or authorization endpoints.
      expect(call.url).not.toMatch(/\/(register|token|authorize)$/);
    }
    expect(calls.some((call) => call.url.endsWith("/.well-known/ai-catalog.json"))).toBe(
      true,
    );
    expect(calls.some((call) => call.url === "https://srv.example.com/mcp/server-card")).toBe(
      true,
    );

    expect(summaries.map((summary) => summary.probeId)).toEqual([...SERVER_PROBE_IDS]);
    expect(JSON.stringify(summaries)).not.toContain(SECRET);
    expect(JSON.stringify(summaries)).not.toMatch(/bearer/i);
  });

  it("writes only contract value keys and background-safe check refs", async () => {
    const { manager } = recordingManager();
    const { fetchFn } = recordingFetch();
    const summaries = await runServerProbes(
      { hosted: false, manager, managerKey: "Fixture", serverUrl: SERVER_URL, capture: capture() },
      { fetchFn },
    ).summaries;
    for (const summary of summaries) {
      const allowed: readonly string[] = PROBE_VALUE_KEYS[summary.probeId];
      for (const [key, value] of Object.entries(summary.values)) {
        expect(allowed).toContain(key);
        if (Array.isArray(value)) expect(value.length).toBeLessThanOrEqual(64);
        else expect(["string", "number", "boolean"]).toContain(typeof (value ?? false));
      }
      for (const ref of Object.keys(summary.checks ?? {})) {
        expect(isConformanceCheckRef(ref) && isBackgroundSafeCheck(ref)).toBe(true);
      }
    }
    const probes = byId(summaries);
    expect(probes.authorization?.values).toMatchObject({
      oauthRequired: true,
      challengeHasResourceMetadata: true,
      prmFound: true,
      prmResource: "https://srv.example.com/mcp",
      prmAuthorizationServers: [AS_ORIGIN],
      asMetadataFound: true,
      issuer: AS_ORIGIN,
      registrationEndpoint: true,
      cimdSupported: true,
      grantTypesSupported: ["authorization_code", "client_credentials"],
    });
    expect(probes["http-transport"]?.values).toMatchObject({ status: "oauth_required" });
    expect(probes["server-card"]?.values).toMatchObject({
      aiCatalogFound: false,
      serverCardFound: false,
    });
    expect(probes.skills?.values).toEqual({
      listed: true,
      count: 2,
      verified: 1,
      digestFailures: 1,
      frontmatterFailures: 0,
    });
    expect(probes["events-list"]).toMatchObject({
      status: "ok",
      values: { listed: true, eventCount: 1, deliveryModes: ["poll", "webhook"] },
      checks: {
        "events:events-capability-declared": "passed",
        "events:events-list-shape": "passed",
      },
    });
  });

  it("abandons a UI read that asks for input and leaves read checks ungraded", async () => {
    // A 2026-07-28 connection: ui://needs-input answers input_required.
    const { manager, forbidden, managerCalls, userHandler } = recordingManager();
    const summaries = await runServerProbes(
      { hosted: false, manager, managerKey: "Fixture", capture: capture() },
      { fetchFn: recordingFetch().fetchFn },
    ).summaries;
    // The read went to the client, never to the manager's loop that hands
    // input_required to the input collector.
    expect(forbidden).toEqual([]);
    expect(managerCalls).not.toContain("readResource");
    expect(userHandler).not.toHaveBeenCalled();
    const apps = byId(summaries)["apps-ui-resources"];
    expect(apps).toMatchObject({
      status: "ok",
      coverage: "partial",
      values: {
        uiResourceCount: 2,
        readCount: 1,
        readFailures: 0,
        abandonedInputRequired: 1,
        cspDeclared: true,
        prefersBorderDeclared: true,
        permissionsDeclared: false,
        domainDeclared: false,
      },
    });
    const refs = Object.keys(apps?.checks ?? {});
    expect(refs).toContain("apps:ui-tools-present");
    expect(refs).not.toContain("apps:ui-resources-readable");
    expect(refs).not.toContain("apps:ui-resource-contents-valid");
    expect(Object.values(apps?.checks ?? {})).not.toContain("failed");
  });

  it("abandons a UI read the server answers with a URL elicitation error", async () => {
    const { manager, forbidden, managerCalls, userHandler } = recordingManager({
      read: async (uri) => {
        if (uri.startsWith("skill://")) return skillFile(uri);
        if (uri === "ui://needs-input") {
          throw new ProtocolError(
            ProtocolErrorCode.UrlElicitationRequired,
            "Open a URL to continue",
          );
        }
        return { contents: [HTML] };
      },
    });
    const apps = byId(
      await runServerProbes({
        hosted: false,
        manager,
        managerKey: "Fixture",
        capture: capture("stdio"),
      }).summaries,
    )["apps-ui-resources"];
    expect(forbidden).toEqual([]);
    expect(managerCalls).not.toContain("readResource");
    expect(userHandler).not.toHaveBeenCalled();
    expect(apps).toMatchObject({
      status: "ok",
      coverage: "partial",
      detail: "A UI resource asked for input, so reading stopped there.",
      values: { readCount: 1, readFailures: 0, abandonedInputRequired: 1 },
    });
    expect(Object.keys(apps?.checks ?? {})).not.toContain("apps:ui-resources-readable");
    expect(Object.values(apps?.checks ?? {})).not.toContain("failed");
  });

  it("grades read checks when every UI resource was read", async () => {
    const { manager } = recordingManager({
      read: async (uri) => ({ contents: [{ ...HTML, uri }] }),
    });
    const summaries = await runServerProbes(
      { hosted: false, manager, managerKey: "Fixture", capture: capture() },
      { fetchFn: recordingFetch().fetchFn },
    ).summaries;
    const apps = byId(summaries)["apps-ui-resources"];
    expect(apps?.coverage).toBe("complete");
    expect(apps?.values.htmlProfileOk).toBe(true);
    expect(apps?.checks).toMatchObject({
      "apps:ui-resources-readable": "passed",
      "apps:ui-resource-contents-valid": "passed",
    });
  });

  it("marks HTTP probes not applicable on stdio and dials nothing", async () => {
    const { manager } = recordingManager();
    const { fetchFn, calls } = recordingFetch();
    const summaries = await runServerProbes(
      { hosted: false, manager, managerKey: "Fixture", capture: capture("stdio") },
      { fetchFn },
    ).summaries;
    const probes = byId(summaries);
    for (const id of ["http-transport", "authorization", "server-card"] as const) {
      expect(probes[id]?.status).toBe("not-applicable");
    }
    expect(calls).toEqual([]);
    expect(probes["events-list"]?.status).toBe("ok");
  });

  it("keeps one probe's failure from affecting the others", async () => {
    const { manager } = recordingManager({
      listServerEvents: async () => {
        throw new ProtocolError(-32603, `upstream said ${SECRET}`);
      },
    });
    const summaries = await runServerProbes(
      { hosted: false, manager, managerKey: "Fixture", serverUrl: SERVER_URL, capture: capture() },
      {
        fetchFn: recordingFetch().fetchFn,
        grade: () => {
          throw new Error(`grader broke on ${SECRET}`);
        },
      },
    ).summaries;
    const probes = byId(summaries);
    expect(probes["apps-ui-resources"]).toMatchObject({ status: "failed" });
    expect(probes["events-list"]).toMatchObject({
      status: "failed",
      checks: { "events:events-list-shape": "failed" },
    });
    expect(probes.skills?.status).toBe("ok");
    expect(probes.authorization?.status).toBe("ok");
    expect(JSON.stringify(summaries)).not.toContain(SECRET);
  });

  it("marks events not applicable when the server declares none", async () => {
    const { manager, managerCalls } = recordingManager({ eventsDeclared: false });
    const summaries = await runServerProbes(
      { hosted: false, manager, managerKey: "Fixture", capture: capture("stdio") },
    ).summaries;
    expect(byId(summaries)["events-list"]?.status).toBe("not-applicable");
    expect(managerCalls).not.toContain("listServerEvents");
  });

  it("hosted: declines a 2025 elicitation during a read, abandons the read and restores the handler", async () => {
    const answers: unknown[] = [];
    const { manager, managerCalls, reads, userHandler, elicit } = recordingManager({
      read: async (uri, _signal, ask) => {
        if (uri === "ui://chart") answers.push(await ask());
        if (uri.startsWith("skill://")) return skillFile(uri);
        return { contents: [{ ...HTML, uri }] };
      },
    });
    const summaries = await runServerProbes({
      hosted: true,
      manager,
      managerKey: "srv_1",
      capture: capture("stdio", doctorState(), "legacy"),
    }).summaries;

    expect(answers).toEqual([{ action: "decline" }]);
    expect(userHandler).not.toHaveBeenCalled();
    expect(reads.sort()).toEqual([
      skillUri("a"),
      skillUri("b"),
      "ui://chart",
      "ui://needs-input",
    ]);
    const apps = byId(summaries)["apps-ui-resources"];
    expect(apps).toMatchObject({
      status: "ok",
      coverage: "partial",
      values: { uiResourceCount: 2, readCount: 1, abandonedInputRequired: 1 },
    });
    expect(Object.keys(apps?.checks ?? {})).not.toContain("apps:ui-resources-readable");
    expect(managerCalls.filter((name) => name.endsWith("ElicitationHandler"))).toEqual([
      "setElicitationHandler",
      "clearElicitationHandler",
    ]);
    // After the window the server's requests reach the normal handling again.
    await elicit();
    expect(userHandler).toHaveBeenCalledTimes(1);
  });

  it("hosted: stops verifying skills when a skill read asks for input", async () => {
    const answers: unknown[] = [];
    const { manager, reads, userHandler } = recordingManager({
      read: async (uri, _signal, ask) => {
        answers.push(await ask());
        return skillFile(uri);
      },
    });
    const summaries = await runServerProbes({
      hosted: true,
      manager,
      managerKey: "srv_1",
      capture: capture("stdio", doctorState({ tools: [], resources: [] }), "legacy"),
    }).summaries;
    expect(answers).toEqual([{ action: "decline" }]);
    expect(userHandler).not.toHaveBeenCalled();
    expect(reads).toEqual([skillUri("a")]);
    expect(byId(summaries).skills).toMatchObject({
      status: "ok",
      coverage: "partial",
      detail: "A skill asked for input, so reading stopped there.",
      values: { listed: true, count: 2, verified: 0, digestFailures: 0 },
    });
  });

  it("local 2025: skips UI reads and events/list and leaves the user's elicitations with their handler", async () => {
    const answers: unknown[] = [];
    const { manager, managerCalls, reads, userHandler, elicit } = recordingManager({
      // Answering events/list, the server elicits; the probe must not send it.
      listServerEvents: async (ask) => {
        answers.push(await ask());
        return { events: [] };
      },
    });
    const summaries = await runServerProbes({
      hosted: false,
      manager,
      managerKey: "Fixture",
      capture: capture("stdio", doctorState(), "legacy"),
    }).summaries;

    expect(reads).toEqual([]);
    expect(managerCalls).not.toContain("listServerEvents");
    expect(answers).toEqual([]);
    expect(userHandler).not.toHaveBeenCalled();
    expect(managerCalls.some((name) => name.endsWith("ElicitationHandler"))).toBe(false);
    expect(byId(summaries)["events-list"]).toMatchObject({
      status: "skipped",
      coverage: "not-captured",
      detail: LOCAL_LEGACY_EVENTS_SKIPPED,
      checks: { "events:events-capability-declared": "passed" },
    });
    expect(Object.keys(byId(summaries)["events-list"]?.checks ?? {})).not.toContain(
      "events:events-list-shape",
    );
    // The user's own requests still reach their handler.
    await elicit();
    expect(userHandler).toHaveBeenCalledTimes(1);
    const apps = byId(summaries)["apps-ui-resources"];
    expect(apps).toMatchObject({
      status: "skipped",
      detail: LOCAL_LEGACY_READS_SKIPPED,
      values: { uiResourceCount: 2 },
      checks: { "apps:ui-tools-present": "passed" },
    });
    expect(Object.keys(apps?.checks ?? {})).not.toContain("apps:ui-resources-readable");
    expect(byId(summaries).skills).toMatchObject({
      status: "ok",
      coverage: "partial",
      detail: LOCAL_LEGACY_SKILL_READS_SKIPPED,
      values: { listed: true, count: 2 },
    });
  });

  it("local 2026-07-28: reads without touching the connection's elicitation handling", async () => {
    const { manager, managerCalls, reads } = recordingManager();
    await runServerProbes({
      hosted: false,
      manager,
      managerKey: "Fixture",
      capture: capture("stdio"),
    }).summaries;
    expect(reads.sort()).toEqual([
      skillUri("a"),
      skillUri("b"),
      "ui://chart",
      "ui://needs-input",
    ]);
    expect(managerCalls.some((name) => name.endsWith("ElicitationHandler"))).toBe(false);
    // Skill files are read on the client too, never through the manager's input loop.
    expect(managerCalls).not.toContain("readResource");
  });

  it("says a hosted connect has connection-bound work only when it does", () => {
    const quiet = recordingManager({ eventsDeclared: false }).manager;
    const noUi = doctorState({ tools: [], resources: [], skills: [] });
    expect(
      needsConnection({ manager: quiet, managerKey: "srv_1", capture: capture("stdio", noUi) }),
    ).toBe(false);
    expect(
      needsConnection({ manager: quiet, managerKey: "srv_1", capture: capture() }),
    ).toBe(true);
    expect(
      needsConnection({
        manager: recordingManager().manager,
        managerKey: "srv_1",
        capture: capture("stdio", noUi),
      }),
    ).toBe(true);
    expect(
      needsConnection({
        manager: quiet,
        managerKey: "srv_1",
        capture: capture("stdio", doctorState({ tools: [], resources: [] })),
      }),
    ).toBe(true);
    // A failed capture leaves only events/list to run on the connection.
    const { doctor: _none, ...failedCapture } = capture("stdio");
    expect(
      needsConnection({ manager: quiet, managerKey: "srv_1", capture: failedCapture }),
    ).toBe(false);
  });

  it("abandons connection-bound probes at the hosted budget and keeps HTTP probes going", async () => {
    vi.useFakeTimers();
    try {
      const aborted: string[] = [];
      const eventSignals: (AbortSignal | undefined)[] = [];
      const { manager } = recordingManager({
        read: (uri, signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              aborted.push(uri);
              reject(new Error("aborted"));
            });
          }),
        listServerEvents: (_elicit, signal) => {
          eventSignals.push(signal);
          return new Promise(() => undefined);
        },
      });
      const run = runServerProbes(
        {
          hosted: true,
          manager,
          managerKey: "srv_1",
          serverUrl: SERVER_URL,
          capture: capture(),
        },
        { fetchFn: recordingFetch().fetchFn },
      );
      let released = false;
      void run.connectionBound.then(() => {
        released = true;
      });
      await vi.advanceTimersByTimeAsync(2_999);
      expect(released).toBe(false);
      // events/list got the budget's signal, still live before the budget ends.
      expect(eventSignals).toHaveLength(1);
      expect(eventSignals[0]?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(released).toBe(true);
      expect(aborted.sort()).toEqual([skillUri("a"), "ui://chart", "ui://needs-input"]);
      expect(eventSignals[0]?.aborted).toBe(true);

      const probes = byId(await run.summaries);
      expect(probes["apps-ui-resources"]?.status).toBe("abandoned");
      expect(probes["events-list"]?.status).toBe("abandoned");
      expect(probes.skills?.status).toBe("abandoned");
      expect(probes.authorization?.status).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });
});
