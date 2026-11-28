import { describe, expect, it } from "vitest";
import { MCPJAM_EVENTS_EXTENSION_ID } from "@mcpjam/sdk/browser";
import { chatOffersEventAgentTools } from "../agent-tools-gate";

function client(
  hostStyle: string,
  events?: Record<string, boolean>,
  extra: { harness?: string; agentLoop?: string } = {},
) {
  return {
    hostStyle,
    ...extra,
    mcpProfile: events
      ? {
          profileVersion: 1,
          extensions: { [MCPJAM_EVENTS_EXTENSION_ID]: events },
        }
      : undefined,
  };
}

const chat = { configUnresolved: false, study: false };

describe("chatOffersEventAgentTools", () => {
  it("ignores the Apps style: an MCPJam-style client with nothing saved gets no tools", () => {
    expect(
      chatOffersEventAgentTools({
        ...chat,
        config: client("mcpjam"),
        hosted: false,
      }),
    ).toBe(false);
  });

  it("follows the setting: a Claude-style client with Webhook gets tools in hosted MCPJam", () => {
    const claude = client("claude", { webhook: true });
    expect(
      chatOffersEventAgentTools({ ...chat, config: claude, hosted: true }),
    ).toBe(true);
    // Locally a webhook needs the user's consent, which the agent can't give.
    expect(
      chatOffersEventAgentTools({ ...chat, config: claude, hosted: false }),
    ).toBe(false);
  });

  it("gives a vendor harness no tools, whatever is saved", () => {
    for (const extra of [{ harness: "codex" }, { agentLoop: "claude-code" }]) {
      expect(
        chatOffersEventAgentTools({
          ...chat,
          config: client(
            "mcpjam",
            { poll: true, push: true, webhook: true },
            extra,
          ),
          hosted: true,
        }),
      ).toBe(false);
    }
  });

  it("holds the tools back while the selected client's config loads, and in a study", () => {
    const all = client("mcpjam", { poll: true, push: true, webhook: true });
    expect(
      chatOffersEventAgentTools({
        config: all,
        configUnresolved: true,
        study: false,
        hosted: false,
      }),
    ).toBe(false);
    expect(
      chatOffersEventAgentTools({
        config: all,
        configUnresolved: false,
        study: true,
        hosted: false,
      }),
    ).toBe(false);
  });

  it("offers them with no client selected: MCPJam (built-in) receives every mode", () => {
    expect(
      chatOffersEventAgentTools({ ...chat, config: null, hosted: true }),
    ).toBe(true);
    expect(
      chatOffersEventAgentTools({ ...chat, config: null, hosted: false }),
    ).toBe(true);
  });
});
