import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import type { NegotiationOutcomeEvent } from "../src/mcp-client-manager/index.js";

/**
 * Auto-negotiation on stdio: this PR extends the always-on automatic era
 * negotiation (which main already applies to HTTP) to stdio connections, and
 * covers the "silent legacy stdio bounded + sibling-process probe" concern.
 *
 * The test drives the real `MCPClientManager` against a spawnable stdio
 * "server" that records every spawn of its binary and never speaks MCP, so the
 * connection never completes and the ONLY observable is the spawn count. That
 * makes the double-spawn side-effect measurable without a flaky
 * connection-timing assertion.
 *
 * MEASURED (beta.4): against a silent / legacy stdio server the auto-probe
 * does NOT produce an observable second spawn — the connect spawns the binary
 * exactly once. The extra sibling-process spawn documented in the migration
 * guide manifests on the MODERN-connect path (probe discovers modern → a
 * second process hosts the modern session), which needs a modern stdio server
 * fixture; that is out of scope here. The upper bound is asserted so a future
 * beta that DOES double-spawn the probe stays bounded rather than silently
 * regressing into unbounded spawning.
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

describe("stdio auto-negotiation (always on)", () => {
  it("auto-negotiates an unconfigured stdio connection: bounded spawn, probe attributed honestly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcpjam-spawn-"));
    const logPath = join(dir, "spawns.log");
    const events: NegotiationOutcomeEvent[] = [];
    const manager = new MCPClientManager(
      {},
      { negotiationOutcomeLogger: (e) => events.push(e) }
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

    // Bounded: at most the connection process + one sibling probe process.
    const spawns = countSpawns(logPath);
    expect(spawns).toBeGreaterThanOrEqual(1);
    expect(spawns).toBeLessThanOrEqual(2);

    // Honest attribution: an unconfigured stdio connection is an `auto`
    // attempt on stdio, and against a non-modern server it is NEVER reported
    // as a negotiated modern session (the probe is not mislabeled).
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      transport: "stdio",
      configuredMode: "auto",
      outcome: "failed",
    });
    expect(events[0].negotiatedEra).not.toBe("modern");
  }, 20000);
});
