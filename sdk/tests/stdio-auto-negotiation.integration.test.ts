import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import type { NegotiationOutcomeEvent } from "../src/mcp-client-manager/index.js";

/**
 * Phase 5 activation checklist — stdio: "silent legacy stdio behavior is
 * understood and BOUNDED" and the beta.4 "double-spawn (sibling process)"
 * concern, plus honest probe attribution.
 *
 * These drive the real `MCPClientManager` against a spawnable stdio "server"
 * that records every spawn of its binary and never speaks MCP, so the
 * connection never completes and the ONLY observable is the spawn count. That
 * makes the double-spawn side-effect measurable without a flaky
 * connection-timing assertion.
 *
 * MEASURED (beta.4): against a silent / legacy stdio server the auto-probe
 * does NOT produce an observable second spawn — activation OFF and ON both
 * spawn the binary exactly once. The extra sibling-process spawn documented in
 * the migration guide manifests on the MODERN-connect path (probe discovers
 * modern → a second process hosts the modern session), which needs a modern
 * stdio server fixture; that is deliberately out of scope here (modern stdio
 * server support is not exposed by the beta server package). The upper bound is
 * asserted so a future beta that DOES double-spawn the probe stays bounded and
 * flagged rather than silently regressing into unbounded spawning.
 */

const SCRIPT = fileURLToPath(
  new URL("./support/stdio-spawn-counter.mjs", import.meta.url)
);

function countSpawns(logPath: string): number {
  if (!existsSync(logPath)) return 0;
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean).length;
}

async function connectSilentStdio(opts: {
  activation: boolean;
}): Promise<{ spawns: number; events: NegotiationOutcomeEvent[] }> {
  const dir = mkdtempSync(join(tmpdir(), "mcpjam-spawn-"));
  const logPath = join(dir, "spawns.log");
  const events: NegotiationOutcomeEvent[] = [];
  const manager = new MCPClientManager(
    {},
    {
      negotiationOutcomeLogger: (e) => events.push(e),
      ...(opts.activation
        ? { versionNegotiationActivation: { enabled: true } }
        : {}),
    }
  );
  try {
    await manager.connectToServer("silent", {
      command: process.execPath,
      args: [SCRIPT],
      env: { SPAWN_LOG: logPath },
      timeout: 1500,
    });
  } catch {
    // Expected: the silent server never completes the handshake.
  }
  await manager.disconnectAllServers().catch(() => {});
  // Let any lingering probe child flush its spawn line.
  await new Promise((r) => setTimeout(r, 300));
  return { spawns: countSpawns(logPath), events };
}

describe("stdio auto-negotiation activation (double-spawn / probe attribution)", () => {
  it("activation OFF: an unconfigured stdio connect spawns the binary exactly once (byte-identical legacy)", async () => {
    const { spawns, events } = await connectSilentStdio({ activation: false });
    expect(spawns).toBe(1);
    // Attribution: OFF stdio is the legacy handshake, never auto/modern.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      transport: "stdio",
      activationEnabled: false,
      configuredMode: "legacy",
      outcome: "failed",
    });
    expect(events[0].negotiatedEra).toBeUndefined();
  }, 20000);

  it("activation ON: the auto-probe spawn stays BOUNDED (≤2) and is not mislabeled as a modern session", async () => {
    const { spawns, events } = await connectSilentStdio({ activation: true });
    // Bounded: at most the connection process + one sibling probe process.
    expect(spawns).toBeGreaterThanOrEqual(1);
    expect(spawns).toBeLessThanOrEqual(2);
    // Honest attribution: the probe is an `auto` attempt on stdio, and against
    // a non-modern server it is NEVER reported as a negotiated modern session.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      transport: "stdio",
      activationEnabled: true,
      configuredMode: "auto",
      outcome: "failed",
    });
    expect(events[0].negotiatedEra).not.toBe("modern");
  }, 20000);
});
