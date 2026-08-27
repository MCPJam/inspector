import { describe, expect, it } from "vitest";
import {
  makeOverrideResolver,
  MCPJAM_YAML_MAX_BYTES,
  parseMcpjamYaml,
  RecipeResolutionError,
  resolveOverrideRecipe,
  resolveRecipe,
} from "../resolver";
import { listRecipeRepos, type CheckRecipe } from "../recipes";

// The resolver decides whose configuration ran and, when it fails, whose
// fault that is. The tests pin the two properties that matter:
//
//   1. authoritative rungs (override, declared yaml) fail HONESTLY — an
//      invalid mcpjam.yaml throws instead of falling through to "no recipe",
//      because falling through would mask an author's real regression;
//   2. evidence strings never carry untrusted file content, because they are
//      rendered into GitHub check output.

// Override behaviour is tested against a SYNTHETIC table, never the production
// one. The production table is empty on purpose (an entry masks that repo's own
// mcpjam.yaml — see ../recipes), and a rung whose coverage disappears the moment
// production config is emptied was never really covered.
const OVERRIDE_REPO = "synthetic/override-repo";
const OVERRIDE_RECIPE: CheckRecipe = {
  build: "make override-build",
  start: "./override-start",
  port: 4321,
  mcpPath: "/override-mcp",
};
const resolveSyntheticOverride = makeOverrideResolver({
  [OVERRIDE_REPO]: OVERRIDE_RECIPE,
});

const VALID_YAML = `
version: 1
checks:
  transport: streamable-http
  build: npm ci && npm run build
  start: npm start
  port: 3001
  path: /mcp
`;

function expectResolutionError(fn: () => unknown): RecipeResolutionError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RecipeResolutionError);
    return err as RecipeResolutionError;
  }
  throw new Error("expected RecipeResolutionError, nothing was thrown");
}

describe("parseMcpjamYaml (declared rung)", () => {
  it("parses a full valid file", () => {
    const resolved = parseMcpjamYaml(VALID_YAML);
    expect(resolved).toEqual({
      build: "npm ci && npm run build",
      start: "npm start",
      port: 3001,
      mcpPath: "/mcp",
      rung: "declared",
      ownershipProof: "verified",
      evidence: ["mcpjam.yaml at repo root (version 1)"],
    });
  });

  it("parses a minimal file (transport omitted defaults to streamable-http)", () => {
    const resolved = parseMcpjamYaml(
      "version: 1\nchecks:\n  build: make\n  start: ./run\n  port: 8080\n  path: /\n",
    );
    expect(resolved?.rung).toBe("declared");
    expect(resolved?.port).toBe(8080);
    expect(resolved?.mcpPath).toBe("/");
  });

  it("returns null (rung inapplicable, not an error) when the file is absent", () => {
    expect(parseMcpjamYaml(null)).toBeNull();
  });

  it("ignores unknown TOP-LEVEL keys (forward compat: the file will grow)", () => {
    const resolved = parseMcpjamYaml(
      `${VALID_YAML}\nfutureSection:\n  anything: goes\n`,
    );
    expect(resolved?.rung).toBe("declared");
  });

  it("rejects unknown keys under checks:, naming the offender", () => {
    const err = expectResolutionError(() =>
      parseMcpjamYaml(VALID_YAML.replace("port: 3001", "port: 3001\n  prot: 1")),
    );
    expect(err.reason).toBe("invalid_mcpjam_yaml");
    expect(err.message).toContain("prot");
  });

  it("rejects an unknown version, naming the version", () => {
    const err = expectResolutionError(() =>
      parseMcpjamYaml(VALID_YAML.replace("version: 1", "version: 2")),
    );
    expect(err.message).toContain("2");
    expect(err.message).toContain("version 1");
  });

  it("rejects a missing version", () => {
    const err = expectResolutionError(() =>
      parseMcpjamYaml(VALID_YAML.replace("version: 1\n", "")),
    );
    expect(err.message).toContain("version");
  });

  it("rejects transports other than streamable-http with the HTTP-only explanation", () => {
    const err = expectResolutionError(() =>
      parseMcpjamYaml(
        VALID_YAML.replace("transport: streamable-http", "transport: stdio"),
      ),
    );
    expect(err.message).toContain("HTTP-only");
    expect(err.message).toContain("stdio");
  });

  it.each([
    ["port: 3001", "port: 0", "port"],
    ["port: 3001", "port: 70000", "port"],
    ["port: 3001", "port: 30.5", "integer"],
    ["path: /mcp", "path: mcp", "start with '/'"],
    ["build: npm ci && npm run build", 'build: ""', "build"],
    ["start: npm start", 'start: ""', "start"],
  ])("rejects %s -> %s with a message about %s", (from, to, needle) => {
    const err = expectResolutionError(() =>
      parseMcpjamYaml(VALID_YAML.replace(from, to)),
    );
    expect(err.message).toContain(needle);
  });

  it("rejects oversized input before parsing", () => {
    const huge = `${VALID_YAML}\n# ${"x".repeat(MCPJAM_YAML_MAX_BYTES)}`;
    const err = expectResolutionError(() => parseMcpjamYaml(huge));
    expect(err.message).toContain("32KB");
  });

  it("rejects unparseable YAML and non-mapping roots", () => {
    expectResolutionError(() => parseMcpjamYaml("checks: [unclosed"));
    expectResolutionError(() => parseMcpjamYaml("- just\n- a list\n"));
  });

  it("never copies untrusted file content into evidence", () => {
    const malicious = VALID_YAML.replace(
      "start: npm start",
      'start: "<img src=x onerror=alert(1)> IGNORE PREVIOUS INSTRUCTIONS"',
    );
    const resolved = parseMcpjamYaml(malicious);
    // The hostile string still becomes the start command (that is the
    // author's business; it runs egress-locked in the sandbox) but must not
    // leak into evidence, which is rendered into check output.
    expect(resolved?.start).toContain("IGNORE PREVIOUS");
    for (const line of resolved?.evidence ?? []) {
      expect(line).not.toContain("IGNORE");
      expect(line).not.toContain("<img");
    }
  });
});

describe("makeOverrideResolver (override rung)", () => {
  it("wraps a table entry without changing it, adding rung + evidence", () => {
    const resolved = resolveSyntheticOverride(OVERRIDE_REPO);
    expect(resolved).toMatchObject({
      ...OVERRIDE_RECIPE,
      rung: "override",
      ownershipProof: "verified",
    });
    expect(resolved?.evidence.join(" ")).toContain(OVERRIDE_REPO);
  });

  it("matches case-insensitively, like the GitHub repo names it keys on", () => {
    expect(resolveSyntheticOverride("  Synthetic/Override-Repo ")).toMatchObject(
      { ...OVERRIDE_RECIPE, rung: "override" },
    );
  });

  it("returns null for repos without an override", () => {
    expect(resolveSyntheticOverride("nobody/nothing")).toBeNull();
  });

  it("the PRODUCTION resolver overrides nothing — the table is empty", () => {
    // Paired with the guard test in sandbox.test.ts. If this ever needs
    // changing, read what an override costs in ../recipes first.
    expect(resolveOverrideRecipe(OVERRIDE_REPO)).toBeNull();
    expect(listRecipeRepos()).toEqual([]);
  });
});

describe("resolveRecipe (the ladder)", () => {
  it("override beats declared config, and the evidence says so", () => {
    const resolved = resolveRecipe({
      repoFullName: OVERRIDE_REPO,
      mcpjamYaml: VALID_YAML.replace("port: 3001", "port: 9999"),
      resolveOverride: resolveSyntheticOverride,
    });
    expect(resolved.rung).toBe("override");
    expect(resolved.port).toBe(OVERRIDE_RECIPE.port);
    expect(resolved.evidence.join(" ")).toContain("outranked");
  });

  it("without an override the SAME repo resolves at the declared rung", () => {
    // The control for the case above: it is the injected override doing the
    // outranking, not anything about the repo name.
    const resolved = resolveRecipe({
      repoFullName: OVERRIDE_REPO,
      mcpjamYaml: VALID_YAML,
    });
    expect(resolved.rung).toBe("declared");
  });

  it("uses the declared config when there is no override", () => {
    const resolved = resolveRecipe({
      repoFullName: "someone/some-server",
      mcpjamYaml: VALID_YAML,
    });
    expect(resolved.rung).toBe("declared");
  });

  it("an invalid declared config FAILS — it does not fall through to no_recipe", () => {
    const err = expectResolutionError(() =>
      resolveRecipe({
        repoFullName: "someone/some-server",
        mcpjamYaml: VALID_YAML.replace("version: 1", "version: 99"),
      }),
    );
    // Authoritative-rung contract: the author's broken file is the outcome,
    // never silently ignored.
    expect(err.reason).toBe("invalid_mcpjam_yaml");
    expect(err.reason).not.toBe("no_recipe");
  });

  it("no override and no yaml -> no_recipe", () => {
    const err = expectResolutionError(() =>
      resolveRecipe({ repoFullName: "someone/some-server", mcpjamYaml: null }),
    );
    expect(err.reason).toBe("no_recipe");
  });
});

describe("review hardening (cyclic values, fence escape, byte cap)", () => {
  it("reports a cyclic version value gracefully instead of throwing a TypeError", () => {
    const yaml = "version: &v\n  self: *v\nchecks:\n  build: npm ci\n  start: npm start\n  port: 3001\n  path: /mcp\n";
    expect(() => resolveRecipe({ repoFullName: "x/none", mcpjamYaml: yaml })).toThrowError(
      RecipeResolutionError,
    );
  });

  it("neutralizes backticks and newlines in echoed error text", () => {
    // A parse error whose message would carry the offending line, including backticks.
    const yaml = "version: 1\nchecks: ```\ninjected: [";
    try {
      resolveRecipe({ repoFullName: "x/none", mcpjamYaml: yaml });
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as RecipeResolutionError;
      const surfaces = `${e.message}\n${e.detailsMarkdown ?? ""}`;
      // The fenced detail block itself is allowed; the ECHOED text must not
      // carry a backtick run that could close it.
      const inner = (e.detailsMarkdown ?? "").replace(/^```\n|\n```$/g, "");
      expect(inner).not.toContain("`");
      expect(surfaces).toBeTruthy();
    }
  });

  it("enforces the cap in UTF-8 bytes, not UTF-16 code units", () => {
    // ~22k three-byte chars ≈ 66KB utf-8 but only ~22k code units.
    const pad = "€".repeat(22 * 1024);
    const yaml = `${VALID_YAML}\n# ${pad}`;
    expect(() => resolveRecipe({ repoFullName: "x/none", mcpjamYaml: yaml })).toThrowError(
      /exceeds the 32KB limit/,
    );
  });

  it("does not double the checks.<field> prefix in schema messages", () => {
    const yaml = "version: 1\nchecks:\n  build: ''\n  start: npm start\n  port: 3001\n  path: /mcp\n";
    try {
      resolveRecipe({ repoFullName: "x/none", mcpjamYaml: yaml });
      expect.unreachable("should have thrown");
    } catch (err) {
      const message = (err as RecipeResolutionError).message;
      expect(message).toContain("checks.build:");
      expect(message.match(/checks\.build/g)?.length).toBe(1);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// `checks.env` — the declared environment channel
// ═══════════════════════════════════════════════════════════════════════════
//
// The bounds below are the BACKEND's, mirrored here on purpose: the plan route
// rejects an out-of-bounds `env` with a message about a file the author cannot
// see from a 400, so the parser has to fail first, at the field, in the file's
// own vocabulary. If the two ever disagree, this is the side that finds out.
//
// The other property under test is that VALUES never surface in an error.
// Keys do (the author needs to see their typo, and they are length-clamped);
// values are the one part of the file this module refuses to echo.

describe("parseMcpjamYaml — checks.env", () => {
  const withEnv = (envBlock: string) =>
    `${VALID_YAML.trimEnd()}\n  env:\n${envBlock}\n`;

  it("round-trips a valid map onto the declared recipe", () => {
    const resolved = parseMcpjamYaml(
      withEnv("    LOG_LEVEL: debug\n    FIXTURE_MODE: strict"),
    );
    expect(resolved?.env).toEqual({
      LOG_LEVEL: "debug",
      FIXTURE_MODE: "strict",
    });
    expect(resolved?.rung).toBe("declared");
    // The rest of the recipe is untouched by the new field.
    expect(resolved?.build).toBe("npm ci && npm run build");
    expect(resolved?.port).toBe(3001);
  });

  it("keeps shell-significant characters as literal values", () => {
    // These reach E2B's `envs` option, never a shell script, so nothing here is
    // expanded, substituted, or split. The parser's job is to hand them over
    // byte-for-byte.
    const resolved = parseMcpjamYaml(
      withEnv(
        [
          `    SHELLY: "$(whoami) \`id\` $HOME"`,
          `    QUOTED: "a 'b' \\"c\\" d"`,
          `    SEMIS: "x; rm -rf /; y && z | w"`,
          `    NEWLINEY: "first\\nsecond"`,
        ].join("\n"),
      ),
    );
    expect(resolved?.env).toEqual({
      SHELLY: "$(whoami) `id` $HOME",
      QUOTED: `a 'b' "c" d`,
      SEMIS: "x; rm -rf /; y && z | w",
      NEWLINEY: "first\nsecond",
    });
  });

  it("treats an absent map and an empty map identically — no env at all", () => {
    // Same runtime behaviour AND the same wire shape: `env: {}` must not travel
    // to the backend as an empty object, because an empty object is a value and
    // "no environment" is the absence of one.
    expect(parseMcpjamYaml(VALID_YAML)?.env).toBeUndefined();
    expect("env" in (parseMcpjamYaml(VALID_YAML) ?? {})).toBe(false);
    const empty = parseMcpjamYaml(`${VALID_YAML.trimEnd()}\n  env: {}\n`);
    expect(empty?.env).toBeUndefined();
    expect("env" in (empty ?? {})).toBe(false);
  });

  it("accepts exactly 20 keys and rejects 21", () => {
    const lines = (count: number) =>
      Array.from({ length: count }, (_, i) => `    K${i}: v`).join("\n");
    expect(Object.keys(parseMcpjamYaml(withEnv(lines(20)))?.env ?? {})).toHaveLength(
      20,
    );
    const err = expectResolutionError(() => parseMcpjamYaml(withEnv(lines(21))));
    expect(err.reason).toBe("invalid_mcpjam_yaml");
    expect(err.message).toContain("checks.env");
    expect(err.message).toContain("20");
  });

  it("accepts a 64-character key and rejects a 65-character one", () => {
    const key = (length: number) => `K${"A".repeat(length - 1)}`;
    expect(parseMcpjamYaml(withEnv(`    ${key(64)}: v`))?.env).toEqual({
      [key(64)]: "v",
    });
    const err = expectResolutionError(() =>
      parseMcpjamYaml(withEnv(`    ${key(65)}: v`)),
    );
    expect(err.message).toContain("64");
  });

  it("accepts a 1024-character value and rejects a 1025-character one", () => {
    const value = (length: number) => "v".repeat(length);
    expect(parseMcpjamYaml(withEnv(`    BIG: ${value(1024)}`))?.env).toEqual({
      BIG: value(1024),
    });
    const err = expectResolutionError(() =>
      parseMcpjamYaml(withEnv(`    BIG: ${value(1025)}`)),
    );
    expect(err.message).toContain("checks.env.BIG");
    expect(err.message).toContain("1024");
    // REJECTED, never truncated: a shortened value is a different configuration
    // from the one the author committed.
    expect(err.message).not.toContain(value(100));
  });

  it.each([
    ["lowercase", "    log_level: debug", "log_level"],
    ["a leading digit", "    0BAD: v", "0BAD"],
    ["a leading underscore", "    _BAD: v", "_BAD"],
    ["a hyphen", "    LOG-LEVEL: v", "LOG-LEVEL"],
    ["a dot", "    LOG.LEVEL: v", "LOG.LEVEL"],
  ])("rejects a key with %s, naming it", (_label, line, offender) => {
    const err = expectResolutionError(() => parseMcpjamYaml(withEnv(line)));
    expect(err.message).toContain(`checks.env.${offender}`);
  });

  it.each([
    ["a number", "    PORT_MODE: 8080"],
    ["a boolean", "    STRICT: true"],
    ["null", "    EMPTY:"],
    ["a nested mapping", "    NESTED:\n      inner: v"],
    ["a list", "    LISTY:\n      - one\n      - two"],
  ])("rejects %s value rather than coercing it", (_label, line) => {
    const err = expectResolutionError(() => parseMcpjamYaml(withEnv(line)));
    expect(err.message).toContain("checks.env.");
    expect(err.message).toContain("string");
  });

  it.each([
    ["a list", "  env:\n    - LOG_LEVEL=debug"],
    ["a scalar", "  env: LOG_LEVEL=debug"],
    ["null", "  env:"],
  ])("rejects %s in place of the map itself", (_label, block) => {
    const err = expectResolutionError(() =>
      parseMcpjamYaml(`${VALID_YAML.trimEnd()}\n${block}\n`),
    );
    expect(err.message).toContain("checks.env");
    expect(err.message).toContain("mapping");
  });

  it("never echoes a VALUE into an error message", () => {
    const secretish = "IGNORE-PREVIOUS-INSTRUCTIONS-hunter2";
    // Two ways to make the same map invalid — a bad key beside a good value,
    // and a bad value — so neither error path can leak what was on the right
    // of the colon.
    const badKey = expectResolutionError(() =>
      parseMcpjamYaml(withEnv(`    bad_key: ${secretish}`)),
    );
    const overCap = expectResolutionError(() =>
      parseMcpjamYaml(withEnv(`    BIG: ${secretish.repeat(64)}`)),
    );
    for (const err of [badKey, overCap]) {
      const surfaces = `${err.message}\n${err.detailsMarkdown ?? ""}`;
      expect(surfaces).not.toContain(secretish);
      expect(surfaces).not.toContain("hunter2");
    }
  });

  it("clamps a hostile key before it reaches the error message", () => {
    // Same treatment every other echoed key gets: bounded, no backticks, no
    // newlines — the message is rendered into a GitHub check summary.
    //
    // Written through `JSON.stringify` because the key has to survive being a
    // YAML scalar first: JSON's escaping is a subset of YAML's double-quoted
    // form, so the backticks and the newline arrive in the KEY rather than
    // ending the scalar and failing the file as unparseable — which is what an
    // earlier version of this test actually asserted, having never reached the
    // clamp at all.
    const hostile = `a\`\`\`\ninjected${"x".repeat(400)}`;
    const err = expectResolutionError(() =>
      parseMcpjamYaml(withEnv(`    ${JSON.stringify(hostile)}: v`)),
    );
    // It got as far as the env field, so the clamp is what produced this.
    expect(err.message).toContain("checks.env.");
    expect(err.message).not.toContain("```");
    expect(err.message).not.toContain("\n");
    expect(err.message.length).toBeLessThan(300);
  });

  it("still rejects unknown siblings of env under checks:", () => {
    const err = expectResolutionError(() =>
      parseMcpjamYaml(
        `${withEnv("    LOG_LEVEL: debug").trimEnd()}\n  envs: nope\n`,
      ),
    );
    expect(err.message).toContain("envs");
  });

  it("an invalid env FAILS the ladder — it does not fall through", () => {
    // The authoritative-rung contract, applied to the new field: a broken env
    // map is the author's, and running a heuristic guess instead would start a
    // server without the configuration they declared.
    const err = expectResolutionError(() =>
      resolveRecipe({
        repoFullName: "someone/some-server",
        mcpjamYaml: withEnv("    log_level: debug"),
      }),
    );
    expect(err.reason).toBe("invalid_mcpjam_yaml");
    expect(err.reason).not.toBe("no_recipe");
  });

  it("carries env through the ladder onto the declared recipe", () => {
    const resolved = resolveRecipe({
      repoFullName: "someone/some-server",
      mcpjamYaml: withEnv("    LOG_LEVEL: debug"),
    });
    expect(resolved.rung).toBe("declared");
    expect(resolved.env).toEqual({ LOG_LEVEL: "debug" });
  });
});
