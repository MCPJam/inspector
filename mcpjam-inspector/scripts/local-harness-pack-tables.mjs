// Read and write the committed, generated pack tables — and read the two
// release-relevant facts out of each harness's compatibility manifest entry —
// without a TypeScript loader.
//
// Shared by `write-pack-digests.mjs` (which rewrites one harness's entries)
// and `check-local-harness-release.mjs` (which reads every harness's), so the
// two cannot disagree about the file's shape. `release-gate.test.ts` pins the
// parse against the real TypeScript exports.
//
// Every harness block is located BY ITS KEY, never by its position or by what
// follows it: the previous reader depended on the literal sequence
// `\n  },\n  codex: {` and broke the moment a second harness had content.

const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "win32-x64"];
export const PACK_TABLE_TARGETS = TARGETS;

function exportBlock(source, name) {
  const match = new RegExp(
    `(export const ${name}[\\s\\S]*?= \\{\\n)([\\s\\S]*?)(^\\};$)`,
    "m",
  ).exec(source);
  if (match === null) {
    throw new Error(`could not find ${name} in the generated file; its shape moved`);
  }
  return { start: match.index, end: match.index + match[0].length, head: match[1], body: match[2], tail: match[3] };
}

/** `"id": { ... },` or `id: { ... },` entries at two-space indentation. */
function harnessEntries(body) {
  const entries = new Map();
  const pattern = /^ {2}"?([a-z][a-z0-9-]*)"?: \{(?:\},$|\n([\s\S]*?)^ {2}\},$)/gm;
  for (const match of body.matchAll(pattern)) {
    entries.set(match[1], match[2] ?? "");
  }
  return entries;
}

/**
 * Every harness's committed pack state:
 * `{ [harnessId]: { version, digests: {target: digest}, records: {target: {packVersion, treeDigest}} } }`.
 */
export function parsePackTables(source) {
  const digestsBlock = exportBlock(source, "PACK_TREE_DIGESTS");
  const recordsBlock = exportBlock(source, "PACK_RECORDS");
  const versionsBlock = exportBlock(source, "EXPECTED_PACK_VERSIONS");
  const state = {};
  const ensure = (id) => (state[id] ??= { version: "", digests: {}, records: {} });

  for (const [id, body] of harnessEntries(digestsBlock.body)) {
    const entry = ensure(id);
    for (const match of body.matchAll(/"([a-z0-9-]+)": "([^"]*)",/g)) {
      entry.digests[match[1]] = match[2];
    }
  }
  for (const [id, body] of harnessEntries(recordsBlock.body)) {
    const entry = ensure(id);
    for (const match of body.matchAll(
      /"([a-z0-9-]+)": \{\s*packVersion: "([^"]*)",\s*treeDigest: "([^"]*)",\s*\},/g,
    )) {
      entry.records[match[1]] = { packVersion: match[2], treeDigest: match[3] };
    }
  }
  for (const match of versionsBlock.body.matchAll(/^ {2}"?([a-z][a-z0-9-]*)"?: "([^"]*)",$/gm)) {
    ensure(match[1]).version = match[2];
  }
  return state;
}

/**
 * Replace ONE harness's entries — digests, records and expected version — and
 * re-render the three blocks canonically. Every other harness is carried over
 * exactly as parsed. Throws if the harness is not already in the tables:
 * which harnesses exist is decided by `SupportedLocalHarnessId`, not here.
 */
export function rewriteHarnessPackTables(source, harnessId, version, digests) {
  const state = parsePackTables(source);
  if (state[harnessId] === undefined) {
    throw new Error(`the generated tables have no ${harnessId} entry to rewrite`);
  }
  const entries = Object.entries(digests).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  state[harnessId] = {
    version,
    digests: Object.fromEntries(entries),
    records: Object.fromEntries(entries.map(([target, treeDigest]) => [target, { packVersion: version, treeDigest }])),
  };
  const ids = Object.keys(state);
  const renderHarness = (id, inner) =>
    inner.length === 0 ? `  ${JSON.stringify(id)}: {},` : `  ${JSON.stringify(id)}: {\n${inner.join("\n")}\n  },`;

  const digestBody = ids
    .map((id) =>
      renderHarness(
        id,
        Object.entries(state[id].digests).map(([t, d]) => `    ${JSON.stringify(t)}: ${JSON.stringify(d)},`),
      ),
    )
    .join("\n");
  const recordBody = ids
    .map((id) =>
      renderHarness(
        id,
        Object.entries(state[id].records).map(
          ([t, r]) =>
            `    ${JSON.stringify(t)}: {\n` +
            `      packVersion: ${JSON.stringify(r.packVersion)},\n` +
            `      treeDigest: ${JSON.stringify(r.treeDigest)},\n` +
            `    },`,
        ),
      ),
    )
    .join("\n");
  const versionBody = ids.map((id) => `  ${JSON.stringify(id)}: ${JSON.stringify(state[id].version)},`).join("\n");

  let next = source;
  for (const [name, body] of [
    ["EXPECTED_PACK_VERSIONS", versionBody],
    ["PACK_RECORDS", recordBody],
    ["PACK_TREE_DIGESTS", digestBody],
  ]) {
    const block = exportBlock(next, name);
    next = next.slice(0, block.start) + block.head + `${body}\n` + block.tail + next.slice(block.end);
  }
  return next;
}

/**
 * The release-relevant fields of every harness's compatibility manifest:
 * `{ [harnessId]: { conformance, nativePlatforms, nativeTargets? } }`, where
 * `nativeTargets` (D8) is present only when the manifest narrows to exact
 * pack targets.
 */
export function parseManifestFacts(compatSource) {
  const start = compatSource.indexOf("export const LOCAL_HARNESS_MANIFEST");
  if (start < 0) throw new Error("could not find LOCAL_HARNESS_MANIFEST in compatibility.ts");
  const open = compatSource.indexOf("= {\n", start);
  const close = compatSource.indexOf("\n};", open);
  const body = `${compatSource.slice(open + 4, close)}\n`;
  const facts = {};
  for (const [id, block] of harnessEntries(body)) {
    const list = (name) => {
      const match = block.match(new RegExp(`\\n {4}${name}: \\[([^\\]]*)\\]`));
      if (!match) return undefined;
      return match[1]
        .split(",")
        .map((token) => token.trim().replace(/^"|"$/g, ""))
        .filter((token) => token.length > 0);
    };
    const nativeTargets = list("nativeTargets");
    facts[id] = {
      conformance: block.match(/lifecycleConformanceVersion: "([^"]*)"/)?.[1] ?? "",
      nativePlatforms: list("nativePlatforms") ?? [],
      ...(nativeTargets !== undefined ? { nativeTargets } : {}),
    };
  }
  return facts;
}
