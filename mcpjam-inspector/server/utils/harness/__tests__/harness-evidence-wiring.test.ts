/**
 * The wiring, end to end: does an eval turn actually ARM capture, and does a
 * playground turn actually stay inert?
 *
 * The unit tests around this cover each piece — the client's protocol, the
 * bridge's hook, the mint's all-or-nothing scope. What none of them can catch
 * is the failure this program is most exposed to: every piece correct, and the
 * iteration id never reaching the mint. The run would execute perfectly,
 * record nothing, and read afterwards as a run whose model made no tool calls.
 */
import { describe, expect, test, vi } from "vitest";
import { buildHarnessProxyMcpJsonFromManager } from "../run-harness-turn";
import { HARNESS_EVIDENCE_TURN_HEADER } from "../mcp-config";

vi.mock("../harness-proxy-token-client.js", () => ({
  fetchHarnessProxyTokens: vi.fn(),
}));
vi.mock("../harness-proxy-strategy.js", () => ({
  resolveHarnessProxyUrl: vi.fn(
    async ({ serverId }: { serverId: string }) =>
      `https://proxy.test/${serverId}`,
  ),
}));

const { fetchHarnessProxyTokens } =
  await import("../harness-proxy-token-client.js");

function managerWithServer(serverId: string) {
  return {
    getServerConfig: (id: string) => (id === serverId ? { url: "x" } : null),
  } as never;
}

const baseArgs = {
  selectedServerIds: ["server-1"],
  authHeader: "Bearer abc",
  projectId: "proj_1",
  strategy: { plane: "web-authorized" as const },
  scopeStepUpCorrelationId: "turn-abc",
};

function entryHeaders(mcpJson: {
  mcpServers: Record<string, { headers?: Record<string, string> }>;
}): Record<string, string> {
  return Object.values(mcpJson.mcpServers)[0]?.headers ?? {};
}

describe("an eval turn on a capture-on run", () => {
  test("asks the mint for the iteration scope and puts the turn on the config", async () => {
    vi.mocked(fetchHarnessProxyTokens).mockResolvedValue({
      ok: true,
      tokens: { "server-1": "tok" },
      harnessEvidence: { captureEnabled: true, gradingSource: "evidence" },
    });

    const result = await buildHarnessProxyMcpJsonFromManager({
      ...baseArgs,
      manager: managerWithServer("server-1"),
      evidenceScope: { iterationId: "iter_1", turnId: "turn-abc" },
    });

    // The claim the proxy will verify before it records anything.
    expect(vi.mocked(fetchHarnessProxyTokens).mock.calls[0][0]).toMatchObject({
      evalScope: { iterationId: "iter_1" },
    });
    // The turn the rows are filed under.
    expect(entryHeaders(result.mcpJson)[HARNESS_EVIDENCE_TURN_HEADER]).toBe(
      "turn-abc",
    );
    expect(result.harnessEvidence).toEqual({
      captureEnabled: true,
      gradingSource: "evidence",
    });
  });
});

describe("an eval turn on a capture-OFF run", () => {
  test("asks for the scope but sends no turn header, so nothing arms", async () => {
    // The run's frozen decision is the authority. Sending a turn id here would
    // change the sandbox's config for a run that decided not to record.
    vi.mocked(fetchHarnessProxyTokens).mockResolvedValue({
      ok: true,
      tokens: { "server-1": "tok" },
      harnessEvidence: { captureEnabled: false, gradingSource: "narration" },
    });

    const result = await buildHarnessProxyMcpJsonFromManager({
      ...baseArgs,
      manager: managerWithServer("server-1"),
      evidenceScope: { iterationId: "iter_1", turnId: "turn-abc" },
    });

    expect(entryHeaders(result.mcpJson)).not.toHaveProperty(
      HARNESS_EVIDENCE_TURN_HEADER,
    );
    expect(result.harnessEvidence).toEqual({
      captureEnabled: false,
      gradingSource: "narration",
    });
  });
});

describe("a playground turn", () => {
  test("mints claimless and produces a byte-identical config", async () => {
    vi.mocked(fetchHarnessProxyTokens).mockResolvedValue({
      ok: true,
      tokens: { "server-1": "tok" },
    });

    const result = await buildHarnessProxyMcpJsonFromManager({
      ...baseArgs,
      manager: managerWithServer("server-1"),
    });

    expect(
      vi.mocked(fetchHarnessProxyTokens).mock.calls[0][0],
    ).not.toHaveProperty("evalScope");
    expect(entryHeaders(result.mcpJson)).not.toHaveProperty(
      HARNESS_EVIDENCE_TURN_HEADER,
    );
    expect(result).not.toHaveProperty("harnessEvidence");
  });
});

describe("a refused scope", () => {
  test("fails the turn instead of running it without evidence", async () => {
    // The all-or-nothing doctrine at the point it costs something: the turn
    // could run perfectly with claimless tokens, and that is exactly what must
    // not happen.
    vi.mocked(fetchHarnessProxyTokens).mockResolvedValue({
      ok: false,
      status: 422,
      error: "Not authorized to mint evidence-scoped tokens",
    });

    await expect(
      buildHarnessProxyMcpJsonFromManager({
        ...baseArgs,
        manager: managerWithServer("server-1"),
        evidenceScope: { iterationId: "iter_1", turnId: "turn-abc" },
      }),
    ).rejects.toThrow(/422/);
  });
});
