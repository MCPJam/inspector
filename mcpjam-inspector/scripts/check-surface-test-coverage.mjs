#!/usr/bin/env node
/**
 * Feature map: which tests exercise each app surface in
 * `shared/app-surfaces.ts`, and a ratchet so a surface cannot ship, or end up,
 * with no test at all.
 *
 * HOW A TEST IS LINKED TO A SURFACE. Derived from the code, so a link moves
 * when the code moves and disappears when the test stops doing the thing:
 *
 *   - E2E (Playwright specs under `e2e/`): the routes the spec navigates to.
 *     Every `goto("…")` literal is normalized (`/p/<project>/`, query and hash
 *     stripped) and matched against each surface's `routePatterns`. A spec
 *     whose `goto` destination is built from data (`goto(path)`,
 *     `` goto(`/p/${id}/${route}`) ``) has its route-shaped string literals
 *     matched instead, since those are the destinations it loops over. A
 *     `goto` of a test-only harness page (`/__e2e/…` in `router.tsx`) counts
 *     for the surfaces whose modules the harness imports.
 *   - Component (Vitest `__tests__/**\/*.test.ts(x)` under `client/` and
 *     `shared/`), and E2E specs that mount client code directly: the modules
 *     the test imports. Each surface's root components are read off the route
 *     table (`router.tsx` → the `*Route` functions in `App.tsx` → the
 *     components they render). A root belongs to the surfaces that render it;
 *     any other module belongs to a surface only when no other surface's
 *     roots reach it. A test of shared plumbing (stores, `ui/`, the logger
 *     both Tracing and Playground render) therefore counts for no surface. A
 *     `vi.mock` of a module is not an import of it.
 *   - Explicit tags, for what the code cannot show (a spec that reaches a
 *     screen only by clicking through the app): a comment line
 *     `// @surface <id>` in the test file. Tags add links, never remove them,
 *     and a tag naming an unknown surface fails the check. Prefer a derived
 *     link: a tag keeps claiming coverage after the test stops providing it.
 *
 * THE RATCHET. `--check` fails when a surface outside the baseline
 * (`scripts/surface-test-coverage-baseline.json`) has no test, when a
 * baselined surface has gained one (shrink the baseline with
 * `--update-baseline`, which only ever removes entries), and when the baseline
 * names a surface that no longer exists. It also fails when the derivation
 * itself finds nothing (no surfaces, specs, tests, or a surface with no root
 * component), so a moved file cannot turn it into a silent pass.
 *
 * Usage:
 *   node scripts/check-surface-test-coverage.mjs [--check] [--update-baseline]
 *     [--markdown <file>] [--json] [--root <inspector dir>] [--baseline <file>]
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  destinationSegments,
  harnessModules,
  importSpecifiers,
  moduleOwners,
  navigatedSurfaces,
  parseSurfaces,
  scanSource,
  surfaceRoots,
  surfaceTags,
} from "./lib/surface-test-map.mjs";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];

/**
 * Builds a resolver for import specifiers, from the inspector root's
 * point of view, matching the client's `@/` and `@/shared/` aliases.
 */
function makeResolver(root) {
  const cache = new Map();
  const tryFile = (base) => {
    if (cache.has(base)) return cache.get(base);
    let hit = null;
    const stem = base.replace(/\.(?:[cm]?js|jsx)$/, "");
    const candidates = [
      base,
      ...SOURCE_EXTENSIONS.map((ext) => stem + ext),
      ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        hit = toRel(root, candidate);
        break;
      }
    }
    cache.set(base, hit);
    return hit;
  };
  return (fromRel, specifier) => {
    if (specifier.startsWith("@/shared/")) {
      return tryFile(join(root, "shared", specifier.slice("@/shared/".length)));
    }
    if (specifier.startsWith("@/")) {
      return tryFile(join(root, "client/src", specifier.slice(2)));
    }
    if (specifier.startsWith(".")) {
      return tryFile(join(root, dirname(fromRel), specifier));
    }
    return null;
  };
}

function toRel(root, file) {
  return relative(root, file).split(sep).join("/");
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    // A missing scan root yields nothing; the empty-scan checks report it.
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const isSource = (rel) =>
  SOURCE_EXTENSIONS.some((ext) => rel.endsWith(ext)) && !rel.endsWith(".d.ts");
const isComponentTest = (rel) =>
  rel.split("/").includes("__tests__") && /\.test\.tsx?$/.test(rel);
const isE2ESpec = (rel) => /\.(?:spec|browser)\.ts$/.test(rel);

/** Reads the inspector tree and joins every surface to its tests. */
export function buildFeatureMap(root) {
  const surfaces = parseSurfaces(
    readFileSync(join(root, "shared/app-surfaces.ts"), "utf8"),
  );
  const ids = new Set(surfaces.map((s) => s.id));
  const res = makeResolver(root);
  const read = (rel) => readFileSync(join(root, rel), "utf8");

  const graph = new Map();
  for (const dir of ["client/src", "shared"]) {
    for (const file of walk(join(root, dir))) {
      const rel = toRel(root, file);
      if (!isSource(rel) || isComponentTest(rel)) continue;
      const deps = new Set();
      for (const spec of importSpecifiers(read(rel))) {
        const target = res(rel, spec);
        if (target) deps.add(target);
      }
      graph.set(rel, deps);
    }
  }

  const routerSource = read("client/src/router.tsx");
  const roots = surfaceRoots({
    surfaces,
    routerSource,
    appSource: read("client/src/App.tsx"),
    resolve: res,
  });
  const owners = moduleOwners(graph, roots);
  const harnesses = harnessModules(routerSource);

  const unknownTags = [];
  const linkImports = (rel, source, into) => {
    for (const spec of importSpecifiers(source)) {
      for (const owner of owners.get(res(rel, spec) ?? "") ?? [])
        into.add(owner);
    }
  };
  const linkHarnesses = (source, into) => {
    for (const literal of scanSource(source).literals) {
      const segments = destinationSegments(literal.value);
      const specifier = segments && harnesses.get(segments.join("/"));
      const harness = specifier && res("client/src/router.tsx", specifier);
      if (harness) linkImports(harness, read(harness), into);
    }
  };
  const linkByImports = (rel, source, into) => {
    linkImports(rel, source, into);
    for (const tag of surfaceTags(source)) {
      if (ids.has(tag)) into.add(tag);
      else unknownTags.push(`${rel}: @surface ${tag}`);
    }
  };

  const e2e = new Map(surfaces.map((s) => [s.id, []]));
  let e2eFiles = 0;
  for (const file of walk(join(root, "e2e"))) {
    const rel = toRel(root, file);
    if (!isE2ESpec(rel)) continue;
    e2eFiles += 1;
    const source = read(rel);
    const linked = navigatedSurfaces(source, surfaces);
    linkHarnesses(source, linked);
    linkByImports(rel, source, linked);
    for (const id of linked) e2e.get(id).push(rel);
  }

  const component = new Map(surfaces.map((s) => [s.id, []]));
  let componentFiles = 0;
  for (const dir of ["client", "shared"]) {
    for (const file of walk(join(root, dir))) {
      const rel = toRel(root, file);
      if (!isComponentTest(rel)) continue;
      componentFiles += 1;
      const linked = new Set();
      linkByImports(rel, read(rel), linked);
      for (const id of linked) component.get(id).push(rel);
    }
  }

  return {
    surfaces: surfaces.map((s) => ({
      id: s.id,
      route: s.canonicalPath,
      roots: [...roots.get(s.id)].sort(),
      e2e: e2e.get(s.id).sort(),
      component: component.get(s.id).sort(),
    })),
    scanned: { e2eFiles, componentFiles, modules: graph.size },
    unknownTags,
  };
}

/** Problems `--check` reports, empty when the map is within the baseline. */
export function checkFeatureMap(map, baseline) {
  const problems = [];
  const ids = new Set(map.surfaces.map((s) => s.id));
  const baselined = new Set(baseline);
  if (map.surfaces.length === 0) problems.push("parsed 0 surfaces");
  if (map.scanned.e2eFiles === 0) problems.push("found 0 E2E specs under e2e/");
  if (map.scanned.componentFiles === 0)
    problems.push("found 0 component tests");
  for (const surface of map.surfaces) {
    const count = surface.e2e.length + surface.component.length;
    if (surface.roots.length === 0) {
      problems.push(
        `${surface.id}: no root component found from router.tsx; the route ` +
          "table or App.tsx changed shape, so fix the derivation",
      );
    }
    if (count === 0 && !baselined.has(surface.id)) {
      problems.push(
        `${surface.id} (${surface.route}) has no test. Add a Playwright spec that ` +
          `navigates to ${surface.route}, a component test that imports one of ` +
          `its modules (${surface.roots.join(", ") || "none found"}), or a ` +
          `\`// @surface ${surface.id}\` line in a test that exercises it`,
      );
    }
    if (count > 0 && baselined.has(surface.id)) {
      problems.push(
        `${surface.id} now has ${count} test(s) and is still in the baseline. ` +
          "Remove it: npm run check:surface-tests -- --update-baseline",
      );
    }
  }
  for (const id of baselined) {
    if (!ids.has(id))
      problems.push(`baseline names unknown surface "${id}"; remove it`);
  }
  for (const tag of map.unknownTags)
    problems.push(`unknown surface tag: ${tag}`);
  return problems;
}

const short = (rel) => rel.replace(/^e2e\//, "");

export function formatTable(map) {
  const rows = map.surfaces.map((s) => [
    s.id,
    s.route,
    s.e2e.map(short).join(", ") || "-",
    String(s.component.length),
    String(s.e2e.length + s.component.length),
  ]);
  const header = ["surface", "route", "e2e specs", "component tests", "count"];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (cells) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return [
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
  ].join("\n");
}

export function formatMarkdown(map) {
  const out = [
    "| Surface | Route | E2E specs | Component tests | Count |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const s of map.surfaces) {
    const list = (files) => files.map((f) => `\`${f}\``).join("<br>") || "none";
    out.push(
      `| ${s.id} | \`${s.route}\` | ${list(s.e2e)} | ${list(s.component)} | ${
        s.e2e.length + s.component.length
      } |`,
    );
  }
  return `${out.join("\n")}\n`;
}

export function summarize(map) {
  const withE2E = map.surfaces.filter((s) => s.e2e.length).length;
  const withComponent = map.surfaces.filter((s) => s.component.length).length;
  const none = map.surfaces.filter((s) => !s.e2e.length && !s.component.length);
  return {
    total: map.surfaces.length,
    withE2E,
    withComponent,
    none: none.map((s) => s.id),
  };
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index !== -1 ? argv[index + 1] : undefined;
}

function main(argv) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const root = resolve(argValue(argv, "--root") ?? join(scriptDir, ".."));
  const baselinePath = resolve(
    argValue(argv, "--baseline") ??
      join(root, "scripts/surface-test-coverage-baseline.json"),
  );
  const map = buildFeatureMap(root);

  if (argv.includes("--json")) {
    console.log(JSON.stringify(map, null, 2));
  } else {
    console.log(formatTable(map));
  }
  const markdownPath = argValue(argv, "--markdown");
  if (markdownPath) writeFileSync(resolve(markdownPath), formatMarkdown(map));

  const summary = summarize(map);
  const log = argv.includes("--json") ? console.error : console.log;
  log(
    `\nsurface-test-coverage: ${summary.total} surfaces, ${summary.withE2E} with ` +
      `E2E, ${summary.withComponent} with component tests, ${summary.none.length} ` +
      `with none${summary.none.length ? ` (${summary.none.join(", ")})` : ""}`,
  );

  // A missing baseline is an empty one: every untested surface fails.
  let baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, "utf8")).uncovered
    : [];

  if (argv.includes("--update-baseline")) {
    // Shrink only. Adding a surface to the baseline is a reviewed hand edit,
    // never something a flag does for you.
    const still = baseline.filter((id) => summary.none.includes(id));
    writeFileSync(
      baselinePath,
      `${JSON.stringify({ uncovered: still }, null, 2)}\n`,
    );
    log(
      `surface-test-coverage: baseline now ${still.length} surface(s); ` +
        `removed ${baseline.length - still.length}`,
    );
    baseline = still;
  }

  if (argv.includes("--check")) {
    const problems = checkFeatureMap(map, baseline);
    if (problems.length) {
      console.error(`\nsurface-test-coverage: ${problems.length} problem(s)\n`);
      for (const problem of problems) console.error(`  - ${problem}`);
      process.exit(1);
    }
    log(`surface-test-coverage: ok (${baseline.length} baselined surface(s))`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2));
}
