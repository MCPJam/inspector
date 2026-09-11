import { describe, expect, it } from "vitest";
import { WEB_CALL_TIMEOUT_MS } from "@/shared/hosted-web-timeouts";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import type { RemoteServer } from "@/hooks/useProjects";
import {
  buildSuiteStageFacts,
  formatTimeoutMs,
  stageFactStrings,
  type StageFacts,
  type StageFactsTargetInput,
} from "../suite-stage-facts";

const host: HostConfigDtoV2 = {
  id: "hc-1",
  schemaVersion: 2,
  hostStyle: "mcpjam",
  modelId: "anthropic/claude-haiku-4.5",
  systemPrompt: "",
  temperature: 0,
  requireToolApproval: false,
  serverIds: ["srv-1"],
  optionalServerIds: [],
  connectionDefaults: { headers: {}, requestTimeout: WEB_CALL_TIMEOUT_MS },
  clientCapabilities: { roots: {}, sampling: {} },
  hostContext: {},
};

const httpServer: RemoteServer = {
  _id: "srv-1",
  projectId: "p-1",
  name: "Server One",
  enabled: true,
  transportType: "http",
  url: "https://example.com/mcp?token=leaked",
  createdAt: 1,
  updatedAt: 1,
};

function target(
  overrides: Partial<StageFactsTargetInput> = {},
): StageFactsTargetInput {
  return {
    hostId: "host-1",
    hostName: "Claude",
    host,
    hostState: "ready",
    serverIds: ["srv-1"],
    servers: [httpServer],
    isHosted: true,
    ...overrides,
  };
}

function readyServers(facts: StageFacts) {
  if (facts.state !== "ready")
    throw new Error(`expected ready, got ${facts.state}`);
  return facts.servers;
}

function line(facts: StageFacts, serverIndex: number, id: string) {
  const found = readyServers(facts)[serverIndex]?.lines.find(
    (l) => l.id === id,
  );
  if (!found) throw new Error(`no server line ${id}`);
  return found;
}

function hostLine(facts: StageFacts, id: string) {
  if (facts.state !== "ready")
    throw new Error(`expected ready, got ${facts.state}`);
  const found = facts.hostLines.find((l) => l.id === id);
  if (!found) throw new Error(`no host line ${id}`);
  return found;
}

describe("formatTimeoutMs", () => {
  it("reads as a person would say it", () => {
    expect(formatTimeoutMs(30_000)).toBe("30 s");
    expect(formatTimeoutMs(1_500)).toBe("1.5 s");
    expect(formatTimeoutMs(250)).toBe("250 ms");
    expect(formatTimeoutMs(0)).toBe("Not set");
  });
});

describe("connection facts", () => {
  it("names the eval-run default when the client pins no timeout", () => {
    const { connection } = buildSuiteStageFacts(
      target({
        host: { ...host, connectionDefaults: { headers: {} } as never },
      }),
    );
    expect(hostLine(connection, "timeout").value).toBe(
      `${formatTimeoutMs(WEB_CALL_TIMEOUT_MS)} · default for eval runs`,
    );
  });

  it("names the client's own timeout when it pins one", () => {
    const { connection } = buildSuiteStageFacts(
      target({
        host: {
          ...host,
          connectionDefaults: { headers: {}, requestTimeout: 12_000 },
        },
      }),
    );
    expect(hostLine(connection, "timeout").value).toBe(
      "12 s · from this client",
    );
  });

  it("says a server's own timeout is not the one a hosted run uses", () => {
    // The debugging payoff: the server page says 10 s, the run uses the
    // client's value, and a reader comparing the two needs to be told which
    // one is in force. A hosted run builds its connection from the client, so
    // the server row's timeout is the one fact here that does NOT apply.
    const { connection } = buildSuiteStageFacts(
      target({ servers: [{ ...httpServer, timeout: 10_000 }] }),
    );
    const timeout = line(connection, 0, "timeout");
    // The fixture client pins 30 s of its own, so that is what is in force.
    expect(timeout.value).toBe("30 s · from this client");
    expect(timeout.note).toBe(
      "This server sets 10 s — eval runs use the client's value",
    );
  });

  it("uses the client's per-server override, and says where it came from", () => {
    const { connection } = buildSuiteStageFacts(
      target({
        host: {
          ...host,
          serverConnectionOverrides: {
            "srv-1": { requestTimeoutOverride: 5_000 },
          },
        },
      }),
    );
    const timeout = line(connection, 0, "timeout");
    expect(timeout.value).toBe("5 s · client override");
    expect(timeout.note).toBeUndefined();
  });

  it("resolves the timeout per server on local runs, with its source", () => {
    const { connection } = buildSuiteStageFacts(
      target({
        isHosted: false,
        servers: [{ ...httpServer, timeout: 10_000 }],
      }),
    );
    const timeout = line(connection, 0, "timeout");
    expect(timeout.value).toBe("10 s · server");
    expect(timeout.note).toBeUndefined();
  });

  it("shows header NAMES and never a header value", () => {
    const { connection } = buildSuiteStageFacts(
      target({
        servers: [
          {
            ...httpServer,
            headers: {
              Authorization: "Bearer super-secret",
              "X-Tenant": "acme-42",
            },
          },
        ],
      }),
    );
    expect(line(connection, 0, "headers").value).toBe(
      "Authorization, X-Tenant",
    );
    const everything = stageFactStrings(connection).join(" ");
    expect(everything).not.toContain("super-secret");
    expect(everything).not.toContain("acme-42");
  });

  it("names stored headers it cannot enumerate rather than claiming none", () => {
    const { connection } = buildSuiteStageFacts(
      target({ servers: [{ ...httpServer, hasHeaders: true }] }),
    );
    expect(line(connection, 0, "headers").value).toContain("Stored headers");
  });

  it("shows only a URL's origin, never its path or query", () => {
    const { connection } = buildSuiteStageFacts(target());
    expect(line(connection, 0, "transport").value).toBe(
      "HTTP · https://example.com",
    );
    expect(stageFactStrings(connection).join(" ")).not.toContain("leaked");
  });

  it("reads auth from the server row", () => {
    const oauth = buildSuiteStageFacts(
      target({ servers: [{ ...httpServer, useOAuth: true }] }),
    );
    expect(line(oauth.connection, 0, "auth").value).toContain("OAuth");

    const xaa = buildSuiteStageFacts(
      target({ servers: [{ ...httpServer, useXaa: true }] }),
    );
    expect(line(xaa.connection, 0, "auth").value).toBe("Cross-App Access");

    const none = buildSuiteStageFacts(target());
    expect(line(none.connection, 0, "auth").value).toBe("None");
  });

  it("prefers a per-server protocol pin over the client default", () => {
    const { connection } = buildSuiteStageFacts(
      target({
        host: {
          ...host,
          mcpProfile: { profileVersion: 1, mcpProtocolVersion: "2025-11-25" },
          serverConnectionOverrides: {
            "srv-1": { mcpProtocolVersionOverride: "2026-07-28" },
          },
        },
      }),
    );
    expect(line(connection, 0, "protocol").value).toContain("2026-07-28");
    expect(hostLine(connection, "protocolDefault").value).toBe("2025-11-25");
  });

  it("says a version is negotiated when nothing pins one", () => {
    const auto = buildSuiteStageFacts(
      target({
        host: {
          ...host,
          mcpProfile: { profileVersion: 1, mcpProtocolVersion: "auto" },
        },
      }),
    );
    expect(hostLine(auto.connection, "protocolDefault").value).toBe(
      "Negotiated at connect",
    );
    const absent = buildSuiteStageFacts(target());
    expect(hostLine(absent.connection, "protocolDefault").value).toBe(
      "Negotiated at connect",
    );
  });

  it("flags a server capabilities override as unused on hosted runs", () => {
    const hosted = buildSuiteStageFacts(
      target({
        servers: [{ ...httpServer, clientCapabilities: { roots: {} } }],
      }),
    );
    expect(line(hosted.connection, 0, "capabilities").tone).toBe("attention");
    expect(line(hosted.connection, 0, "capabilities").note).toContain(
      "Not applied",
    );

    const local = buildSuiteStageFacts(
      target({
        isHosted: false,
        servers: [{ ...httpServer, clientCapabilities: { roots: {} } }],
      }),
    );
    expect(line(local.connection, 0, "capabilities").note).toContain("Applied");
  });

  it("omits auth and headers for a stdio server and flags it on hosted", () => {
    const { connection } = buildSuiteStageFacts(
      target({
        servers: [
          {
            ...httpServer,
            transportType: "stdio",
            url: undefined,
            command: "node",
          },
        ],
      }),
    );
    const ids = readyServers(connection)[0].lines.map((l) => l.id);
    expect(ids).not.toContain("auth");
    expect(ids).not.toContain("headers");
    expect(line(connection, 0, "transport").note).toContain(
      "cannot spawn STDIO",
    );
  });

  it("lists the client's advertised capabilities", () => {
    const { connection } = buildSuiteStageFacts(target());
    expect(hostLine(connection, "clientCapabilities").value).toBe(
      "roots, sampling",
    );
  });
});

describe("discovery facts", () => {
  it("reads visibility, progressive discovery and pagination from the client", () => {
    const { discovery } = buildSuiteStageFacts(
      target({
        host: {
          ...host,
          respectToolVisibility: false,
          progressiveToolDiscovery: true,
          mcpProfile: {
            profileVersion: 1,
            paginationTraversal: "firstPageOnly",
          },
        },
      }),
    );
    expect(hostLine(discovery, "toolVisibility").value).toContain("Every tool");
    expect(hostLine(discovery, "progressiveDiscovery").value).toContain("On —");
    expect(hostLine(discovery, "pagination").value).toBe("First page only");
    expect(hostLine(discovery, "pagination").tone).toBe("attention");
  });

  it("reads an absent visibility flag as the spec default, not as off", () => {
    const { discovery } = buildSuiteStageFacts(target());
    expect(hostLine(discovery, "toolVisibility").value).toContain(
      "spec default",
    );
    expect(hostLine(discovery, "pagination").value).toContain("every page");
  });

  it("names the server group when one is attached", () => {
    const grouped = buildSuiteStageFacts(
      target({ attachment: { id: "att-1", name: "Prod pair" } }),
    );
    expect(hostLine(grouped.discovery, "serverScope").value).toBe(
      'Server group "Prod pair" · 1 server',
    );
    const own = buildSuiteStageFacts(target());
    expect(hostLine(own.discovery, "serverScope").value).toBe(
      "Client's own servers · 1",
    );
  });
});

describe("states", () => {
  it("is loading while the host or the project's servers are in flight", () => {
    expect(
      buildSuiteStageFacts(target({ hostState: "loading" })).connection.state,
    ).toBe("loading");
    expect(
      buildSuiteStageFacts(target({ servers: undefined })).discovery.state,
    ).toBe("loading");
  });

  it("says so when the client is gone, and offers a way back", () => {
    const { connection } = buildSuiteStageFacts(
      target({ hostState: "missing", host: undefined }),
    );
    expect(connection.state).toBe("unavailable");
    if (connection.state !== "unavailable") throw new Error("unreachable");
    expect(connection.message).toContain("no longer exists");
    expect(connection.link).toEqual({ kind: "host", hostId: "host-1" });
  });

  it("marks a server the project no longer has, without throwing", () => {
    const { connection } = buildSuiteStageFacts(
      target({ serverIds: ["srv-1", "srv-gone"] }),
    );
    const rows = readyServers(connection);
    expect(rows[1].missing).toBe(true);
    expect(rows[1].lines[0].value).toBe("No longer in this project");
  });
});

describe("vocabulary", () => {
  it("never borrows run-state words for a config state", () => {
    // Settings has observed nothing. "Not measured" and "no grader" describe a
    // run and an ungraded stage respectively; either would state something
    // nobody looked at.
    const variants: StageFactsTargetInput[] = [
      target(),
      target({ isHosted: false }),
      target({ hostState: "loading" }),
      target({ hostState: "missing", host: undefined }),
      target({ serverIds: ["srv-gone"] }),
      target({
        host: {
          ...host,
          respectToolVisibility: false,
          mcpProfile: {
            profileVersion: 1,
            paginationTraversal: "firstPageOnly",
          },
        },
        servers: [{ ...httpServer, timeout: 10_000, clientCapabilities: {} }],
      }),
    ];
    for (const variant of variants) {
      const facts = buildSuiteStageFacts(variant);
      const text = [
        ...stageFactStrings(facts.connection),
        ...stageFactStrings(facts.discovery),
      ]
        .join(" ")
        .toLowerCase();
      expect(text).not.toContain("not measured");
      expect(text).not.toContain("no grader");
      expect(text).not.toContain("passed");
    }
  });
});
