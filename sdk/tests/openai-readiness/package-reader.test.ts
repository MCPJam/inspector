/**
 * The OpenAI package reader.
 *
 * The load-bearing case in this file is the raw-name one. `normalizeBundlePath`
 * REPAIRS a backslash separator, a doubled separator and a `.` segment — which
 * are three of the things the portal rejects — so a reader that checked
 * normalised paths would report a clean package for an archive the portal is
 * about to bounce. Those tests fail loudly if the raw-name pass is ever moved
 * behind normalisation.
 */

import { describe, expect, it } from "vitest";

import { readOpenAIPluginPackage } from "../../src/openai-readiness/package/reader.js";
import { xmldomParseXml } from "../../src/openai-readiness/package/svg-xml-node.js";
import { OPENAI_HOST_PROFILE } from "../../src/openai-readiness/profile.js";
import {
  CANONICAL_MANIFEST_PATH,
  InMemoryOpenAIPackageSource,
  archiveObservations,
  cleanSkillsPackage,
  manifestJson,
  nonSquarePng,
  openaiYaml,
  skillMarkdown,
  squarePng,
} from "./package-fixtures.js";

// Node has no `DOMParser`; without the parser an SVG is recorded as a gap
// rather than graded, which is honest but not what these tests are about.
const read = (
  files: Record<string, string | Uint8Array>,
  archive?: Parameters<typeof readOpenAIPluginPackage>[1],
) =>
  readOpenAIPluginPackage(new InMemoryOpenAIPackageSource(files), {
    ...archive,
    parseXml: xmldomParseXml,
  });

const codes = (evidence: { issues: { id: string }[] }): string[] =>
  evidence.issues.map((issue) => issue.id);

describe("a clean package", () => {
  it("reads with no portal issues", async () => {
    const evidence = await read(cleanSkillsPackage(), {
      archive: archiveObservations(),
    });
    expect(codes(evidence)).toEqual([]);
  });

  it("reports the manifest, skills and assets it found", async () => {
    const evidence = await read(cleanSkillsPackage(), {
      archive: archiveObservations(),
    });
    expect(evidence.manifest?.name).toBe("weather");
    expect(evidence.manifest?.location.canonical).toBe(true);
    expect(evidence.skills).toHaveLength(1);
    expect(evidence.skills[0]).toMatchObject({
      directory: "skills/forecast",
      name: "forecast",
      description: "Look up a forecast for a city",
    });
    expect(evidence.assets[0]).toMatchObject({
      path: "assets/icon.png",
      dimensions: { widthPx: 512, heightPx: 512, format: "png" },
    });
    expect(evidence.assets[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records no gaps when the archive reported everything", async () => {
    const evidence = await read(cleanSkillsPackage(), {
      archive: archiveObservations(),
    });
    expect(evidence.gaps).toEqual([]);
  });
});

describe("raw entry names are checked before normalization", () => {
  const withRawNames = (rawEntryNames: string[]) =>
    read(cleanSkillsPackage(), {
      archive: archiveObservations({ rawEntryNames }),
    });

  it("catches a backslash separator that normalization would repair", async () => {
    // `normalizeBundlePath` maps `\` to `/`. Checking the normalised path finds
    // nothing wrong with an archive the portal rejects outright.
    const evidence = await withRawNames(["skills\\forecast\\SKILL.md"]);
    expect(codes(evidence)).toContain("archive-backslash-path");
  });

  it("catches a doubled separator that normalization would collapse", async () => {
    const evidence = await withRawNames(["skills//forecast/SKILL.md"]);
    expect(codes(evidence)).toContain("archive-empty-path-segment");
  });

  it("catches a `.` segment that normalization would drop", async () => {
    const evidence = await withRawNames(["./skills/forecast/SKILL.md"]);
    expect(codes(evidence)).toContain("archive-empty-path-segment");
  });

  it("catches outer whitespace on a segment", async () => {
    const evidence = await withRawNames(["skills/ forecast/SKILL.md"]);
    expect(codes(evidence)).toContain("archive-path-whitespace");
  });

  it("catches traversal and absolute paths", async () => {
    expect(codes(await withRawNames(["../escape.md"]))).toContain(
      "archive-path-traversal",
    );
    expect(codes(await withRawNames(["/etc/passwd"]))).toContain(
      "archive-absolute-path",
    );
    expect(codes(await withRawNames(["C:\\Windows\\system32"]))).toContain(
      "archive-absolute-path",
    );
  });

  it("catches a control character in a path", async () => {
    const evidence = await withRawNames(["skills/fore\u0001cast/SKILL.md"]);
    expect(codes(evidence)).toContain("archive-path-control-character");
  });

  it("does not flag an ordinary directory marker entry", async () => {
    // A trailing empty segment is just `skills/`; only an empty segment in the
    // MIDDLE is the doubled separator the portal rejects.
    const evidence = await withRawNames([
      "skills/",
      "skills/forecast/SKILL.md",
    ]);
    expect(codes(evidence)).not.toContain("archive-empty-path-segment");
  });

  it("falls back to the source's own paths and says so", async () => {
    const evidence = await read(cleanSkillsPackage());
    expect(evidence.gaps.map((gap) => gap.subject)).toContain("rawEntryNames");
    expect(
      evidence.gaps.find((gap) => gap.subject === "rawEntryNames")?.reason,
    ).toContain("folder source");
  });
});

describe("archive limits", () => {
  it("reports a compressed size over the ceiling", async () => {
    const evidence = await read(cleanSkillsPackage(), {
      archive: archiveObservations({
        compressedBytes:
          OPENAI_HOST_PROFILE.archiveLimits.maxCompressedBytes + 1,
      }),
    });
    expect(codes(evidence)).toContain("archive-too-large");
  });

  it("reports encrypted entries by path", async () => {
    const evidence = await read(cleanSkillsPackage(), {
      archive: archiveObservations({ encryptedEntryPaths: ["secret.bin"] }),
    });
    expect(
      evidence.issues.find((issue) => issue.id === "archive-encrypted-entry")
        ?.subject,
    ).toBe("secret.bin");
  });

  it("does not pass a limit it never measured", async () => {
    // A folder source has no compressed size. Reporting the limit as satisfied
    // would be claiming a measurement that never happened.
    const evidence = await read(cleanSkillsPackage());
    expect(codes(evidence)).not.toContain("archive-too-large");
    expect(evidence.gaps.map((gap) => gap.subject)).toContain(
      "compressedBytes",
    );
    expect(evidence.gaps.map((gap) => gap.subject)).toContain(
      "encryptedEntryPaths",
    );
  });

  it("rejects link entries", async () => {
    const files = cleanSkillsPackage();
    const source = new InMemoryOpenAIPackageSource(files, {
      entries: [
        ...Object.keys(files).map((path) => ({ path, size: 10 })),
        { path: "evil", size: 0, kind: "symlink" as const },
      ],
    });
    const evidence = await readOpenAIPluginPackage(source);
    expect(codes(evidence)).toContain("archive-symlink-entry");
  });

  it("reports a case-fold collision", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "assets/Icon.png": squarePng(512),
    });
    // Two entries differing only by case extract over each other on macOS and
    // Windows, so the package the reviewer sees is not the one uploaded.
    expect(codes(evidence)).toContain("archive-duplicate-path");
  });
});

describe("manifest locations", () => {
  it("accepts the canonical `.codex-plugin/` location", async () => {
    const evidence = await read(cleanSkillsPackage());
    expect(evidence.manifest?.location).toMatchObject({
      path: ".codex-plugin/plugin.json",
      canonical: true,
    });
    expect(evidence.manifest?.location.normalizedFrom).toBeUndefined();
  });

  for (const location of [
    ".agent-plugin/plugin.json",
    ".claude-plugin/plugin.json",
  ]) {
    it(`accepts ${location} and records the normalization`, async () => {
      const files = cleanSkillsPackage();
      delete files[CANONICAL_MANIFEST_PATH];
      files[location] = manifestJson();
      const evidence = await read(files);
      // Recorded, not silently accepted: a package that works only because we
      // normalised it has not been told the truth about itself.
      expect(evidence.manifest?.location).toMatchObject({
        path: location,
        canonical: false,
        normalizedFrom: location,
      });
      expect(codes(evidence)).not.toContain("manifest-missing");
    });
  }

  it("reports a package with no manifest at all", async () => {
    const evidence = await read({
      "skills/forecast/SKILL.md": skillMarkdown(),
    });
    expect(codes(evidence)).toContain("manifest-missing");
  });

  it("reports malformed manifest JSON", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      [CANONICAL_MANIFEST_PATH]: "{ not json",
    });
    expect(codes(evidence)).toContain("manifest-invalid-json");
  });

  it("reports a JSON array as an invalid manifest", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      [CANONICAL_MANIFEST_PATH]: "[]",
    });
    expect(codes(evidence)).toContain("manifest-invalid-json");
  });

  it("reports an over-long name and a non-semver version", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      [CANONICAL_MANIFEST_PATH]: manifestJson({
        name: "x".repeat(200),
        version: "1.0",
      }),
    });
    expect(codes(evidence)).toContain("manifest-name-too-long");
    expect(codes(evidence)).toContain("manifest-version-invalid");
  });

  it("collects MCP server names from the manifest and .mcp.json", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      [CANONICAL_MANIFEST_PATH]: manifestJson({
        mcpServers: { fromManifest: {} },
      }),
      ".mcp.json": JSON.stringify({ mcpServers: { fromConfig: {} } }),
    });
    expect(evidence.manifest?.mcpServerNames).toEqual([
      "fromConfig",
      "fromManifest",
    ]);
  });
});

describe("skills", () => {
  it("reports a skill directory with no SKILL.md", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "skills/broken/notes.md": "# notes",
    });
    expect(codes(evidence)).toContain("skill-metadata-missing");
  });

  it("reports missing frontmatter", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "skills/forecast/SKILL.md": "no frontmatter here",
    });
    expect(codes(evidence)).toContain("skill-frontmatter-invalid");
  });

  it("reports a missing name and description", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "skills/forecast/SKILL.md": "---\nother: value\n---\n\nBody\n",
    });
    expect(codes(evidence)).toContain("skill-name-missing");
    expect(codes(evidence)).toContain("skill-description-missing");
  });

  it("reports two skills declaring the same name", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "skills/second/SKILL.md": skillMarkdown({ name: "forecast" }),
    });
    expect(codes(evidence)).toContain("skill-name-collision");
  });

  it("reports an over-long skill name", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "skills/forecast/SKILL.md": skillMarkdown({ name: "x".repeat(100) }),
    });
    expect(codes(evidence)).toContain("skill-name-too-long");
  });

  it("totals every byte under a skill directory", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "skills/forecast/reference.md": "x".repeat(100),
    });
    expect(evidence.skills[0].fileCount).toBe(2);
    expect(evidence.skills[0].totalBytes).toBeGreaterThan(100);
  });

  it("parses a per-skill agents/openai.yaml", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "skills/forecast/agents/openai.yaml": openaiYaml({
        interface: { display_name: "Forecast" },
      }),
    });
    expect(
      evidence.skills[0].agentMetadata?.metadata?.interface.displayName,
    ).toBe("Forecast");
  });
});

describe("a loose file under skills/ is not a skill", () => {
  it("does not read skills/README.md as a skill directory", async () => {
    // `skill-metadata-missing` is BLOCKING, so a two-segment reading of
    // `skills/README.md` registers a skill directory named `README.md`, looks
    // for `skills/README.md/SKILL.md`, and blocks a submission whose only sin
    // is a readme. A skill is a directory; the shortest path that establishes
    // one is `skills/<name>/<file>`.
    const evidence = await read({
      ...cleanSkillsPackage(),
      "skills/README.md": "# skills in this bundle",
    });
    expect(codes(evidence)).not.toContain("skill-metadata-missing");
    expect(evidence.skills.map((skill) => skill.directoryName)).not.toContain(
      "README.md",
    );
  });

  it("still reports a real directory that is missing its SKILL.md", async () => {
    // The narrowing above must not cost the case the check exists for.
    const evidence = await read({
      ...cleanSkillsPackage(),
      "skills/broken/notes.md": "# notes",
    });
    expect(codes(evidence)).toContain("skill-metadata-missing");
  });
});

describe("assets", () => {
  it("reports a non-square image", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "assets/icon.png": nonSquarePng(512, 256),
    });
    expect(codes(evidence)).toContain("asset-not-square");
  });

  it("reports images below and above the edge limits", async () => {
    expect(
      codes(
        await read({
          ...cleanSkillsPackage(),
          "assets/icon.png": squarePng(16),
        }),
      ),
    ).toContain("asset-too-small");
    expect(
      codes(
        await read({
          ...cleanSkillsPackage(),
          "assets/icon.png": squarePng(8_192),
        }),
      ),
    ).toContain("asset-too-big-dimensions");
  });

  it("reports an undecodable raster image", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "assets/icon.png": squarePng(512).subarray(0, 16),
    });
    expect(codes(evidence)).toContain("asset-undecodable");
  });

  it("separates a malformed SVG from one with no dimensions", async () => {
    // Different mistakes, different remediations — "could not decode" would
    // tell the submitter neither.
    expect(
      codes(
        await read({
          ...cleanSkillsPackage(),
          "assets/logo.svg": "<html><svg/></html>",
        }),
      ),
    ).toContain("asset-svg-malformed");
    expect(
      codes(
        await read({
          ...cleanSkillsPackage(),
          "assets/logo.svg": "<svg></svg>",
        }),
      ),
    ).toContain("asset-svg-no-dimensions");
  });

  it("reports an interface icon the package does not ship", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "agents/openai.yaml": openaiYaml({
        interface: { icon_small: "assets/missing.png" },
      }),
    });
    expect(
      evidence.issues.find((issue) => issue.id === "asset-missing")?.observed,
    ).toBe("assets/missing.png");
  });

  it("sniffs the real type rather than trusting the extension", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "assets/icon.png": squarePng(512),
    });
    expect(evidence.assets[0].declaredMimeType).toBe("image/png");
    expect(evidence.assets[0].sniffedMimeType).toBe("image/png");
  });
});

describe("declared asset references are resolved, not string-compared", () => {
  it("finds an icon the interface names as ./icon.png", async () => {
    // `files` is keyed by canonical path and a hand-written reference is not.
    // `./icon.png` and `icon.png` name the same shipped file, so comparing the
    // reference as written invents `asset-missing` on a package that ships it —
    // a fabricated defect on a correct submission, which is worse than the one
    // the check was written to catch.
    const evidence = await read({
      ...cleanSkillsPackage(),
      "agents/openai.yaml": openaiYaml({
        interface: { icon_small: "./assets/icon.png" },
      }),
      "assets/icon.png": squarePng(512),
    });
    expect(codes(evidence)).not.toContain("asset-missing");
  });

  it("still reports an icon the package does not ship", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "agents/openai.yaml": openaiYaml({
        interface: { icon_small: "assets/nope.png" },
      }),
    });
    expect(codes(evidence)).toContain("asset-missing");
  });

  it("treats a reference that escapes the package as missing", async () => {
    // `../` names nothing inside the package however it is spelled, so it is
    // still missing — normalising must not turn an escape into a match.
    const evidence = await read({
      ...cleanSkillsPackage(),
      "agents/openai.yaml": openaiYaml({
        interface: { icon_small: "../assets/icon.png" },
      }),
      "assets/icon.png": squarePng(512),
    });
    expect(codes(evidence)).toContain("asset-missing");
  });
});

describe("unsupported surfaces are recorded, not judged", () => {
  it("lists the surfaces the plugin directory does not run", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      ".app.json": "{}",
      "hooks/on-install.sh": "#!/bin/sh\n",
      "commands/do-thing.md": "# do",
    });
    expect(evidence.surfaces).toEqual([
      { path: ".app.json", surface: "app-config" },
      { path: "commands/do-thing.md", surface: "commands" },
      { path: "hooks/on-install.sh", surface: "hooks" },
    ]);
    // The READER does not decide these are violations — the migration lane
    // does, and it needs the submission mode to say so.
    expect(codes(evidence)).toEqual([]);
  });

  it("does not mistake the interface document for an unsupported agents/ surface", async () => {
    const evidence = await read(cleanSkillsPackage());
    expect(evidence.surfaces).toEqual([]);
  });
});

describe("interface document issues become portal codes", () => {
  it("maps a low-contrast brand colour to its own code", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "agents/openai.yaml": openaiYaml({
        interface: { brand_color: '"#1A1A1A"' },
      }),
    });
    expect(codes(evidence)).toContain("interface-brand-color-low-contrast");
  });

  it("maps an unparseable brand colour to a different code", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "agents/openai.yaml": openaiYaml({ interface: { brand_color: "blue" } }),
    });
    expect(codes(evidence)).toContain("interface-brand-color-invalid");
  });

  it("maps an over-long display name to the length code", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "agents/openai.yaml": openaiYaml({
        interface: { display_name: `"${"x".repeat(200)}"` },
      }),
    });
    expect(codes(evidence)).toContain("interface-display-name-too-long");
  });

  it("reports a missing display name", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "agents/openai.yaml": "policy:\n  products:\n    - chatgpt\n",
    });
    expect(codes(evidence)).toContain("interface-display-name-missing");
  });

  it("maps invalid YAML to the document-level code", async () => {
    const evidence = await read({
      ...cleanSkillsPackage(),
      "agents/openai.yaml": "interface:\n  display_name: [unclosed",
    });
    expect(codes(evidence)).toContain("interface-yaml-invalid");
  });
});
