import { describe, expect, it } from "vitest";
import {
  MCPJAM_YAML_MAX_LENGTH,
  parseMcpjamYaml,
  RecipeResolutionError,
  resolveOverrideRecipe,
  resolveRecipe,
} from "../resolver";
import { listRecipeRepos, resolveCheckRecipe } from "../recipes";

// The resolver decides whose configuration ran and, when it fails, whose
// fault that is. The tests pin the two properties that matter:
//
//   1. authoritative rungs (override, declared yaml) fail HONESTLY — an
//      invalid mcpjam.yaml throws instead of falling through to "no recipe",
//      because falling through would mask an author's real regression;
//   2. evidence strings never carry untrusted file content, because they are
//      rendered into GitHub check output.

/** A repo that exists in the operator override table. */
const OVERRIDE_REPO = listRecipeRepos()[0];

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
    const huge = `${VALID_YAML}\n# ${"x".repeat(MCPJAM_YAML_MAX_LENGTH)}`;
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

describe("resolveOverrideRecipe (override rung)", () => {
  it("wraps the existing RECIPES table without changing it", () => {
    const raw = resolveCheckRecipe(OVERRIDE_REPO);
    const resolved = resolveOverrideRecipe(OVERRIDE_REPO);
    expect(raw).not.toBeNull();
    expect(resolved).toMatchObject({ ...raw, rung: "override" });
    expect(resolved?.evidence.join(" ")).toContain(OVERRIDE_REPO);
  });

  it("returns null for repos without an override", () => {
    expect(resolveOverrideRecipe("nobody/nothing")).toBeNull();
  });
});

describe("resolveRecipe (the ladder)", () => {
  it("override beats declared config, and the evidence says so", () => {
    const resolved = resolveRecipe({
      repoFullName: OVERRIDE_REPO,
      mcpjamYaml: VALID_YAML.replace("port: 3001", "port: 9999"),
    });
    expect(resolved.rung).toBe("override");
    expect(resolved.port).toBe(resolveCheckRecipe(OVERRIDE_REPO)!.port);
    expect(resolved.evidence.join(" ")).toContain("outranked");
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
