/**
 * Everything a mock can change on this server, ranked: where to change it, its
 * current value, which clients read it, the failed runs that point at it, and
 * what was tried. It joins what the real server lists, what a definition can
 * state, the table of what each client reads, the baseline's failures by eval
 * stage, and the rounds so far. An entry no client of the climb reads sorts
 * last and says so, because a round that changes only that is refused.
 */
import type { PlatformClimbVerdict } from "../platform/climb-types.js";
import { readersOf, type ReadField } from "./client-reads.js";
import { pickFailedRuns } from "./failed-runs.js";
import type { ChangeEntry, ClimbClient, ClimbEvidence, RealServerView, TriedChange } from "./types.js";

type Field = { field: string; read: ReadField; value: (tool: RealServerView["tools"][number]) => unknown };

const TOOL_FIELDS: readonly Field[] = [
  { field: "description", read: "toolDescription", value: (tool) => tool.description },
  { field: "inputSchema", read: "toolInputSchema", value: (tool) => tool.inputSchema },
  { field: "title", read: "toolTitle", value: (tool) => tool.title },
  { field: "outputSchema", read: "toolOutputSchema", value: (tool) => tool.outputSchema },
  { field: "annotations", read: "toolAnnotations", value: (tool) => tool.annotations },
];

/** Which failure categories point at which field of a tool. */
const FAILURES_BY_FIELD: Readonly<Record<string, readonly string[]>> = {
  description: ["metadata", "selection"],
  inputSchema: ["arguments"],
  "params.description": ["arguments"],
};

const READ_WEIGHT = { reads: 2, unconfirmed: 1, ignores: 0 } as const;

type Draft = Omit<ChangeEntry, "rank"> & { score: number };

export function whatCanChange(input: {
  server: RealServerView;
  clients: readonly ClimbClient[];
  evidence?: readonly ClimbEvidence[];
  tried?: readonly TriedChange[];
}): ChangeEntry[] {
  const { server, clients } = input;
  const evidence = input.evidence ?? [];
  const failed = evidence.filter((item) => item.outcome === "failed");
  const drafts: Draft[] = [];

  const add = (
    where: ChangeEntry["where"],
    current: unknown,
    read: ReadField,
    pointing: readonly ClimbEvidence[],
  ) => {
    const readBy = readersOf(read, clients);
    const readByAnyClient = readBy.length === 0 || readBy.some((reader) => reader.reads !== "ignores");
    const score =
      Math.max(0, ...readBy.map((reader) => READ_WEIGHT[reader.reads])) * 10 +
      pointing.length * 100 +
      (typeof current === "string" && current.length > 0 ? 1 : 0);
    drafts.push({
      where,
      current,
      readBy,
      readByAnyClient,
      failedIterations: pointing.length,
      failedRuns: pickFailedRuns(pointing),
      tried: triedFor(input.tried ?? [], where.mockPath),
      score: readByAnyClient ? score : score - 10_000,
    });
  };

  if (server.instructions !== undefined) {
    add({ kind: "server", field: "instructions", mockPath: "instructions" }, server.instructions, "instructions",
      failed.filter((item) => item.failureCategory === "selection" || item.failureCategory === "userValue"));
  }
  if (server.serverInfo?.name !== undefined) {
    add({ kind: "server", field: "serverInfo.name", mockPath: "serverInfo.name" }, server.serverInfo.name, "serverName", []);
  }
  for (const tool of server.tools) {
    const pointingAt = (field: string) =>
      failed.filter(
        (item) => item.tool === tool.name && FAILURES_BY_FIELD[field]?.includes(item.failureCategory ?? "") === true,
      );
    for (const { field, read, value } of TOOL_FIELDS) {
      add({ kind: "tool", tool: tool.name, field, mockPath: `tools.${tool.name}.${field}` }, value(tool), read, pointingAt(field));
    }
    const properties = propertiesOf(tool.inputSchema);
    for (const [param, schema] of Object.entries(properties)) {
      const description = (schema as { description?: unknown } | null)?.description;
      add(
        { kind: "param", tool: tool.name, param, field: "params.description", mockPath: `tools.${tool.name}.params.${param}.description` },
        description,
        "toolInputSchema",
        pointingAt("params.description"),
      );
    }
    add({ kind: "tool", tool: tool.name, field: "hidden", mockPath: `tools.${tool.name}.hidden` }, false, "toolListing", []);
  }

  return drafts
    .map((draft, index) => ({ draft, index }))
    .sort((a, b) => b.draft.score - a.draft.score || a.index - b.index)
    .map(({ draft: { score: _score, ...entry } }, position) => ({ ...entry, rank: position + 1 }));
}

function propertiesOf(schema: unknown): Record<string, unknown> {
  const properties = (schema as { properties?: unknown } | null)?.properties;
  return typeof properties === "object" && properties !== null && !Array.isArray(properties)
    ? Object.fromEntries(Object.entries(properties))
    : {};
}

/** The rounds whose change list touched this path (or a path under it), and how they came out. */
function triedFor(tried: readonly TriedChange[], mockPath: string): Array<{ round: number; verdict: PlatformClimbVerdict }> {
  return tried
    .filter((round) =>
      round.changes.some((change) =>
        change.details.some((detail) => {
          const path = change.target === "server" ? detail.path : `tools.${change.name}.${detail.path}`;
          return path === mockPath || path.startsWith(`${mockPath}.`) || mockPath.startsWith(`${path}.`);
        }),
      ),
    )
    .map(({ round, verdict }) => ({ round, verdict }));
}
