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
