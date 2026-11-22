#!/usr/bin/env node
/**
 * Feature map: which tests exercise each app surface in
 * `shared/app-surfaces.ts`, and a ratchet so a surface cannot ship, or end up,
 * with no test at all.
 *
 * HOW A TEST IS LINKED TO A SURFACE. Derived from the code, so a link moves
 * when the code moves and disappears when the test stops doing the thing.
 * The links are heuristic discovery, not proof that a test renders and
 * asserts on the screen: a test can import a surface and assert nothing about
 * it, or navigate there and get redirected away. A file whose every test is
 * skipped (`it.skip`, `describe.skip`) links nothing, an import the file
 * never mentions again is not a link, and `typeof import()` and
 * `import("…").Props` types are not imports. A runtime skip
 * (`test.skip(condition)`) still counts.
 *
 *   - E2E (Playwright specs under `e2e/`): the routes the spec navigates to.
 *     Every `goto("…")` literal is normalized (`/p/<project>/`, query and hash
 *     stripped) and matched against each surface's `routePatterns`. A spec
 *     whose `goto` destination is built from data (`goto(path)`,
 *     `` goto(`/p/${id}/${route}`) ``) has its route-shaped string literals
 *     matched instead, since those are the destinations it loops over,
 *     except a literal passed straight to a call (`toHaveURL("/servers")`,
 *     `getByText("tools")`), which is that call's input. A
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
 * The baseline only shrinks. `--base-ref <rev>` fails when the baseline lists
 * a surface the baseline at `<rev>` did not; CI passes the pull request's
 * base (`.github/workflows/surface-baseline.yml`). A reviewer who accepts an
 * untested surface labels the pull request `surface-baseline-growth`, which
 * sets `SURFACE_BASELINE_GROWTH_REVIEWED=1`.
 *
 * Usage:
 *   node scripts/check-surface-test-coverage.mjs [--check] [--update-baseline]
 *     [--base-ref <git rev>] [--markdown <file>] [--json]
 *     [--root <inspector dir>] [--baseline <file>]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSurfaces } from "./lib/surface-test-map.mjs";
import { scanSurfaceTests } from "./lib/surface-test-scan.mjs";

/** Reads the inspector tree and joins every surface to its tests. */
export function buildFeatureMap(root) {
  const surfaces = parseSurfaces(
    readFileSync(join(root, "shared/app-surfaces.ts"), "utf8"),
  );
  const { roots, e2e, component, scanned, unknownTags } = scanSurfaceTests(
    root,
    surfaces,
  );
  return {
    surfaces: surfaces.map((s) => ({
      id: s.id,
      route: s.canonicalPath,
      roots: [...roots.get(s.id)].sort(),
      e2e: e2e.get(s.id).sort(),
      component: component.get(s.id).sort(),
    })),
    scanned,
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

/** Surfaces the baseline lists that the base revision's baseline did not. */
export function baselineGrowth(baseline, baseBaseline) {
  const before = new Set(baseBaseline);
  return baseline.filter((id) => !before.has(id));
}

/**
 * The baseline as committed at git revision `ref`, or null when that
 * revision has no baseline file: the change that adds the file is where its
 * first entries are reviewed.
 */
function readBaseBaseline(root, baselinePath, ref) {
  const rel = relative(root, baselinePath).split(sep).join("/");
  try {
    const text = execFileSync("git", ["show", `${ref}:./${rel}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(text).uncovered;
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    if (/does not exist in|exists on disk, but not in/.test(stderr)) return null;
    throw new Error(
      `cannot read the baseline at ${ref}: ${stderr.trim() || error.message}`,
    );
  }
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

  const baseRef = argValue(argv, "--base-ref");
  if (baseRef) {
    const before = readBaseBaseline(root, baselinePath, baseRef);
    const added = before ? baselineGrowth(baseline, before) : [];
    if (added.length && process.env.SURFACE_BASELINE_GROWTH_REVIEWED === "1") {
      log(
        `surface-test-coverage: baseline adds ${added.join(", ")} over ${baseRef}; ` +
          "allowed by the surface-baseline-growth label",
      );
    } else if (added.length) {
      console.error(
        `
surface-test-coverage: the baseline adds ${added.join(", ")}, which ` +
          `${baseRef} did not list. The baseline only shrinks: add a test for ` +
          "the surface. If a reviewer accepts shipping it untested, label the " +
          "pull request surface-baseline-growth.",
      );
      process.exit(1);
    }
  }

  if (argv.includes("--update-baseline")) {
    // Shrink only. Adding a surface takes a hand edit and a reviewer's
    // surface-baseline-growth label, never a flag.
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
