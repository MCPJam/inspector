/**
 * The byte budget for one server of the v3 snapshot, applied last by
 * `buildSnapshotServerV3`.
 *
 * The connect write sends the snapshot whole to
 * `serverInspections:recordFromConnect`. The backend keeps at most 64 KB of a
 * server inline (`redactForInlineStorage`) and the rest only in its raw
 * archive, in 64 KB chunk rows. Every byte past that costs the mutation
 * normalizing, hashing and redaction passes and chunk writes inside Convex's
 * 1 s and 16 MiB per-mutation limits, and an archive in its overflow form is
 * refused past 8 MiB, so an unbounded server can fail the whole write.
 * {@link SNAPSHOT_SERVER_MAX_BYTES} keeps a server to 16 archive chunks, a
 * small part of each limit, and still 16 times the inline row, so the backend
 * picks what stays inline from full evidence.
 *
 * Over the budget, evidence goes in the order the backend gives it up: `*Json`
 * strings first, largest first, since each repeats a stripped field that stays
 * readable; then `meta` and schema objects, largest first. Each drop marks its
 * part's coverage `partial`. What is left past that (names, descriptions,
 * icons, capabilities) is the backend's cascade to trim.
 */
import type { CoverageKey, ServerFeatureSnapshotServerV3 } from "@mcpjam/sdk";

export const SNAPSHOT_SERVER_MAX_BYTES = 1024 * 1024;

interface Evidence {
  /** What dropping it saves, never more than the property's real size. */
  bytes: number;
  coverage: CoverageKey;
  drop: () => void;
}

/** The descriptor fields `*Json` and `meta` evidence can live in. */
type MetaHolder = { meta?: Record<string, unknown>; metaJson?: string };

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * `keys` of `holder` that are present. A property's size is its key, value
 * and colon; the comma beside it is not counted, so the running total can
 * only overstate what is left.
 */
function present<T extends object>(
  holder: T,
  keys: readonly (keyof T & string)[],
  coverage: CoverageKey,
): Evidence[] {
  return keys.flatMap((key) => {
    const value = holder[key];
    if (value === undefined) return [];
    return [
      {
        bytes: jsonBytes(key) + jsonBytes(value) + 1,
        coverage,
        drop: () => {
          Reflect.deleteProperty(holder, key);
        },
      },
    ];
  });
}

/** `meta` or `metaJson` on resources, templates and prompts. */
function descriptorEvidence(
  server: ServerFeatureSnapshotServerV3,
  keys: readonly (keyof MetaHolder)[],
): Evidence[] {
  const lists: Array<[CoverageKey, MetaHolder[] | undefined]> = [
    ["resources", server.resources],
    ["resourceTemplates", server.resourceTemplates],
    ["prompts", server.prompts],
  ];
  return lists.flatMap(([coverage, items]) =>
    (items ?? []).flatMap((item) => present(item, keys, coverage)),
  );
}

function jsonEvidence(server: ServerFeatureSnapshotServerV3): Evidence[] {
  const { discovery } = server;
  return [
    ...server.tools.flatMap((tool) => [
      ...present(tool, ["metaJson"], "toolMeta"),
      ...present(tool, ["inputSchemaJson", "outputSchemaJson"], "toolSchemas"),
    ]),
    ...descriptorEvidence(server, ["metaJson"]),
    ...(discovery
      ? [
          ...present(discovery, ["capabilitiesJson"], "capabilities"),
          ...present(discovery, ["metaJson"], "serverInfo"),
        ]
      : []),
  ];
}

function objectEvidence(server: ServerFeatureSnapshotServerV3): Evidence[] {
  return [
    ...server.tools.flatMap((tool) => [
      ...present(tool, ["meta"], "toolMeta"),
      ...present(tool, ["inputSchema", "outputSchema"], "toolSchemas"),
    ]),
    ...descriptorEvidence(server, ["meta"]),
    ...(server.discovery ? present(server.discovery, ["meta"], "serverInfo") : []),
  ];
}

/**
 * Fits `server` in `maxBytes`, in place, by the order in the module comment.
 * A part already not captured stays so; a complete one becomes partial.
 */
export function fitSnapshotServer(
  server: ServerFeatureSnapshotServerV3,
  maxBytes = SNAPSHOT_SERVER_MAX_BYTES,
): ServerFeatureSnapshotServerV3 {
  let excess = jsonBytes(server) - maxBytes;
  for (const collect of [jsonEvidence, objectEvidence]) {
    if (excess <= 0) break;
    // `sort` is stable: equal sizes keep the snapshot's own order.
    const evidence = collect(server).sort((left, right) => right.bytes - left.bytes);
    for (const field of evidence) {
      if (excess <= 0) break;
      field.drop();
      excess -= field.bytes;
      if (server.coverage?.[field.coverage] === "complete") {
        server.coverage[field.coverage] = "partial";
      }
    }
  }
  return server;
}
