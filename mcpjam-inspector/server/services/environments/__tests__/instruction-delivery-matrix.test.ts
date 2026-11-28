/**
 * What each run type hands MCPJam's harness of a server's instructions,
 * read off the prompt `prepareChatV2` builds with the options that run type
 * passes. Rows for vendor harnesses read what the harness turn is handed, in
 * `utils/harness/__tests__`.
 */
import { describe, expect, it } from "vitest";
import {
  prepareChatV2,
  type PrepareChatV2Options,
} from "../../../utils/chat-v2-orchestration";

const MARKER = "MARKER-K7Q2: call search before you answer.";
const SERVER = "srv_docs";

/**
 * A manager with one connected server that sent `instructions`. A server in
 * `failing` completes its handshake but fails to list its tools.
 */
function manager({
  instructions = MARKER,
  failing = [] as string[],
}: { instructions?: string; failing?: string[] } = {}) {
  const servers = [SERVER, ...failing];
  return {
    listServers: () => servers,
    hasServer: (key: string) => servers.includes(key),
    getInitializationInfo: (key: string) =>
      servers.includes(key) ? { instructions } : undefined,
    getToolsForAiSdk: async () => ({}),
    getToolsForAiSdkByServer: async (keys: string[] | undefined) => {
      if (keys?.some((key) => failing.includes(key))) {
        throw new Error("tools/list timed out");
      }
      return {};
    },
    getAllToolAnnotations: () => ({}),
    getAllToolsMetadata: () => ({}),
  };
}

const MODEL = { id: "gpt-4.1", provider: "openai" };

function prepare(
  options: Partial<PrepareChatV2Options>,
  source = manager(),
) {
  return prepareChatV2({
    mcpClientManager: source as never,
    modelDefinition: MODEL as never,
    systemPrompt: "Base prompt.",
    ...options,
  });
}

const count = (text: string) => text.split(MARKER).length - 1;

/** Each run type's options, as its `prepareChatV2` call passes them. */
const RUN_TYPES: Array<{
  name: string;
  options: Partial<PrepareChatV2Options>;
  heading: string;
}> = [
  {
    name: "Playground chat (web)",
    options: {
      selectedServers: [SERVER],
      isolatedServers: [SERVER],
      serverNames: { [SERVER]: "Docs" },
    },
    heading: "## Docs",
  },
  {
    name: "Playground chat (v1 chat session)",
    options: {
      selectedServers: [SERVER],
      isolatedServers: [SERVER],
      serverLabels: { [SERVER]: "Docs" },
      progressiveToolDiscovery: { enabled: false },
    },
    heading: "## Docs",
  },
  {
    name: "v1 agent API",
    options: {
      selectedServers: [SERVER],
      progressiveToolDiscovery: { enabled: false },
    },
    heading: `## ${SERVER}`,
  },
  {
    name: "eval",
    options: { selectedServers: [SERVER], serverNames: { [SERVER]: "Docs" } },
    heading: "## Docs",
  },
  {
    name: "goal run",
    options: { selectedServers: [SERVER], serverNames: { [SERVER]: "Docs" } },
    heading: "## Docs",
  },
  {
    name: "swarm setup",
    options: { selectedServers: [SERVER], requireToolApproval: false },
    heading: `## ${SERVER}`,
  },
  {
    name: "event turn",
    options: {
      selectedServers: [SERVER],
      serverNames: { [SERVER]: "Docs" },
      systemPrompt: "Reply to every new comment with 'thanks'.",
    },
    heading: "## Docs",
  },
];

describe("server instructions on MCPJam's harness", () => {
  for (const { name, options, heading } of RUN_TYPES) {
    it(`reach the ${name} prompt once, under the server's heading`, async () => {
      const prepared = await prepare(options);
      expect(count(prepared.enhancedSystemPrompt)).toBe(1);
      expect(prepared.enhancedSystemPrompt).toContain(`${heading}\n${MARKER}`);
      expect(
        prepared.enhancedSystemPrompt.startsWith(
          options.systemPrompt ?? "Base prompt.",
        ),
      ).toBe(true);
      expect(prepared.serverInstructions).toContain(MARKER);
    });
  }

  it("come after the account note", async () => {
    const source = manager();
    const prepared = await prepare(
      {
        selectedServers: [SERVER],
        connectionsByServerId: {
          [SERVER]: [
            { serverId: SERVER, connectionId: "c1", key: SERVER, label: "work" },
            { serverId: SERVER, connectionId: "c2", key: SERVER, label: "home" },
          ],
        },
      },
      source,
    );
    const prompt = prepared.enhancedSystemPrompt;
    const note = prompt.indexOf("When the account is ambiguous");
    expect(note).toBeGreaterThan(0);
    expect(prompt.indexOf("# MCP Server Instructions")).toBeGreaterThan(note);
    expect(count(prompt)).toBe(1);
  });

  it("leave the prompt byte-identical when no server sent any", async () => {
    const prepared = await prepare(
      { selectedServers: [SERVER] },
      manager({ instructions: "" }),
    );
    expect(prepared.enhancedSystemPrompt).toBe("Base prompt.");
    expect(prepared.serverInstructions).toBe("");
  });

  it("leave out a server the turn runs without after its handshake", async () => {
    const prepared = await prepare(
      {
        selectedServers: ["srv_flaky"],
        isolatedServers: ["srv_flaky"],
      },
      manager({ failing: ["srv_flaky"] }),
    );
    expect(prepared.unavailableServers?.has("srv_flaky")).toBe(true);
    expect(count(prepared.enhancedSystemPrompt)).toBe(0);
    expect(prepared.serverInstructions).toBe("");
  });

  it("leave out a server the turn did not select", async () => {
    const prepared = await prepare({ selectedServers: [] });
    expect(count(prepared.enhancedSystemPrompt)).toBe(0);
  });
});

describe("server instructions on a harness turn", () => {
  it("stay out of the prepared prompt and travel in the result instead", async () => {
    const prepared = await prepare({
      selectedServers: [SERVER],
      serverNames: { [SERVER]: "Docs" },
      harness: "codex",
    });
    expect(count(prepared.enhancedSystemPrompt)).toBe(0);
    expect(count(prepared.serverInstructions)).toBe(1);
    expect(prepared.serverInstructions).toContain(`## Docs\n${MARKER}`);
  });
});
