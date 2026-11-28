/**
 * MCP tool names on harness turns, in both directions.
 *
 * MCP allows tool names such as `cad.tray`; model providers accept only
 * `[a-zA-Z0-9_-]`. On a harness turn either the runtime or MCPJam renames them:
 *
 *  - Claude Code's own MCP client names every tool
 *    `mcp__<server>__<tool>` with each character outside `[a-zA-Z0-9_-]`
 *    replaced by `_` (2.1.290, the pinned CLI), and still calls the server
 *    with the original name. `cad.tray` reaches the model as `…__cad_tray`.
 *  - For host-executed tools (OpenCode, Codex, and Claude Code when MCPJam's
 *    MCP client serves the turn) MCPJam picks the name itself.
 *
 * Either way MCPJam has to record the call under the server's real tool, so
 * widgets, evals and tool policies find it. This module owns the rename rule,
 * the names MCPJam registers, and the way back.
 */
import { createToolNameAliases } from "@mcpjam/sdk";
import type { Harness } from "@mcpjam/sdk/host-config/internal";
import { hostChannelToolName } from "./mcp-config.js";

/** What Claude Code shows the model for one tool-name segment. */
export function runtimeToolNameSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Runtimes whose own MCP client renames tools with {@link runtimeToolNameSegment}. */
const RENAMING_RUNTIMES: ReadonlySet<Harness> = new Set<Harness>([
  "claude-code",
]);

export interface HarnessToolNameCollision {
  serverId: string;
  /** Distinct server tool names that the runtime shows under one name. */
  toolNames: string[];
}

/**
 * Two model-visible tools on one server that the runtime would show under the
 * same name. MCPJam could not tell which one a call meant, so the turn is
 * refused before the runtime starts.
 */
export class HarnessToolNameCollisionError extends Error {
  readonly collisions: HarnessToolNameCollision[];

  constructor(collisions: HarnessToolNameCollision[]) {
    const groups = collisions
      .map(({ toolNames }) => listNames(toolNames.map((name) => `\`${name}\``)))
      .join(", or ");
    super(
      `Claude Code can't run ${groups} in one turn because it gives them the same name. Rename one of them on its server, or run this client on MCPJam Harness.`,
    );
    this.name = "HarnessToolNameCollisionError";
    this.collisions = collisions;
  }
}

/** `a`, `a and b`, `a, b and c`. */
function listNames(names: string[]): string {
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Groups of tools, per server, that `harness`'s own MCP client would merge.
 * Empty for runtimes that don't rename tools themselves.
 */
export function findHarnessToolNameCollisions(
  harness: Harness,
  toolNamesByServer: ReadonlyMap<string, readonly string[]>,
): HarnessToolNameCollision[] {
  if (!RENAMING_RUNTIMES.has(harness)) return [];
  const collisions: HarnessToolNameCollision[] = [];
  for (const [serverId, names] of toolNamesByServer) {
    const groups = new Map<string, Set<string>>();
    for (const name of names) {
      const segment = runtimeToolNameSegment(name);
      const group = groups.get(segment) ?? new Set<string>();
      group.add(name);
      groups.set(segment, group);
    }
    for (const group of groups.values()) {
      if (group.size > 1)
        collisions.push({ serverId, toolNames: [...group].sort() });
    }
  }
  return collisions;
}

/** Server and tool behind a name MCPJam registered with a runtime. */
export interface HarnessToolIdentity {
  serverId: string;
  toolName: string;
}

/**
 * Names for host-executed tools: valid for every provider, unique within the
 * turn, and recorded so a call maps back to its server and tool without
 * parsing the name (the alias may be truncated or carry a `_2` suffix).
 */
export function registerHostToolNames(
  entries: ReadonlyArray<HarnessToolIdentity & { baseName: string }>,
): {
  wireName(serverId: string, toolName: string): string;
  registry: ReadonlyMap<string, HarnessToolIdentity>;
} {
  const aliases = createToolNameAliases(entries.map((entry) => entry.baseName));
  const byIdentity = new Map<string, string>();
  const registry = new Map<string, HarnessToolIdentity>();
  for (const { serverId, toolName, baseName } of entries) {
    const wire = aliases.toWire(baseName);
    byIdentity.set(identityKey(serverId, toolName), wire);
    registry.set(wire, { serverId, toolName });
  }
  return {
    wireName: (serverId, toolName) => {
      const wire = byIdentity.get(identityKey(serverId, toolName));
      if (!wire) {
        throw new Error(
          `No registered harness tool name for ${serverId}/${toolName}`,
        );
      }
      return wire;
    },
    registry,
  };
}

function identityKey(serverId: string, toolName: string): string {
  return JSON.stringify([serverId, toolName]);
}

/**
 * The server and real tool name for a call a runtime reported.
 *
 * In order: a name MCPJam registered for a host-executed tool (the raw name,
 * or the one Cursor wraps in the call's input); otherwise the
 * adapter's attribution, with its tool name matched to the server's tool list
 * exactly, or to the one tool the runtime renames to it (collisions are
 * refused up front, so there is at most one); otherwise the attribution as is.
 */
export function identifyHarnessTool(args: {
  rawToolName: string;
  /**
   * The call's input, only for a runtime that wraps the registered name in
   * it (Cursor). Any other runtime's input is the tool's own arguments.
   */
  input?: unknown;
  attributed: { serverId?: string; toolName: string };
  hostToolRegistry: ReadonlyMap<string, HarnessToolIdentity>;
  serverToolNames: (serverId: string) => readonly string[];
}): { serverId?: string; toolName: string } {
  const hostToolName = hostChannelToolName(args.input);
  const registered =
    args.hostToolRegistry.get(args.rawToolName) ??
    (hostToolName ? args.hostToolRegistry.get(hostToolName) : undefined);
  if (registered) return { ...registered };
  const { serverId, toolName } = args.attributed;
  if (!serverId) return args.attributed;
  const names = args.serverToolNames(serverId);
  if (names.includes(toolName)) return args.attributed;
  const renamed = names.filter(
    (name) => runtimeToolNameSegment(name) === toolName,
  );
  return renamed.length === 1
    ? { serverId, toolName: renamed[0]! }
    : args.attributed;
}
