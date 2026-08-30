/**
 * The CLI's SEP-2640 surface, verified with MCPJam's own host as the oracle.
 *
 * Same contract as `mcp/tests/skillsWire.test.ts`: the assertions do not
 * re-implement the spec, they run `verifySkillMarkdown` from `@mcpjam/sdk` —
 * the function the Inspector uses against a third-party server — over the
 * bytes this server would serve. A digest, size, or frontmatter bug fails here
 * rather than being discovered by our own debugger pointed at our own CLI.
 *
 * Every skill and every file is checked, not a sample.
 *
 * PIN: modelcontextprotocol/modelcontextprotocol @ a3e147ca27 (branch `sep/skills-extension`, `seps/2640-skills-extension.md`).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  enumeratedResources,
  findListedResource,
  verifyDigest,
  verifySize,
  verifySkillMarkdown,
} from "@mcpjam/sdk";
import {
  SKILLS_BUNDLE_CONTENTS,
  SKILLS_BUNDLE_ENTRIES,
} from "../src/generated/SkillsBundle.generated.js";
import {
  SKILLS_EXTENSION_CAPABILITY,
  SKILLS_EXTENSION_ID,
  SKILLS_LIST_CACHE_SCOPE,
  mimeTypeFor,
  registerSkillsSurface,
} from "../src/lib/skills-surface.js";
// @ts-expect-error Local build helper is implemented as plain ESM.
import { buildCliSkillsBundle, CLI_SKILL_ROOTS } from "../scripts/generate-skills-bundle.mjs";

test("the CLI serves the skills that teach its own surface", () => {
  const names = SKILLS_BUNDLE_ENTRIES.map((entry) =>
    entry.uri.split("/").at(-2)
  ).sort();
  assert.deepEqual(names, ["mcp-inspector", "mcpjam-eval-import"]);
  // `mcp-inspector` is the load-bearing one: it interprets the probe/doctor
  // output of the tools this server registers.
  assert.ok(names.includes("mcp-inspector"));
});

test("the declared capability is an object, never a boolean", async () => {
  // A host reads the VALUE as the settings object; `true` does not count as a
  // declaration and would leave the extension silently inactive.
  const declared = (SKILLS_EXTENSION_CAPABILITY as Record<string, unknown>)[
    SKILLS_EXTENSION_ID
  ];
  assert.equal(typeof declared, "object");
  assert.deepEqual(declared, {});
});

test("does not advertise directoryRead, which it cannot answer", () => {
  const declared = (
    SKILLS_EXTENSION_CAPABILITY as Record<string, Record<string, unknown>>
  )[SKILLS_EXTENSION_ID]!;
  assert.equal(declared.directoryRead, undefined);
});

test("uses a valid public cache scope for the static catalog", () => {
  assert.equal(SKILLS_LIST_CACHE_SCOPE, "public");
});

/**
 * Registers the surface against a stub and returns the captured handlers.
 *
 * Exercising the real handler rather than asserting on the constants: a
 * constant can be correct while the response still carries the wrong field.
 */
function capture() {
  const handlers = new Map<string, (params: any) => Promise<any>>();
  const resources: { uri: string; mimeType?: string }[] = [];
  const stub = {
    server: {
      setRequestHandler: (
        method: string,
        _schemas: unknown,
        handler: (params: any) => Promise<any>
      ) => {
        handlers.set(method, handler);
      },
    },
    registerResource: (
      _name: string,
      uri: string,
      config: { mimeType?: string }
    ) => {
      resources.push({ uri, mimeType: config.mimeType });
    },
  };
  registerSkillsSurface(stub as never);
  return { handlers, resources };
}

test("issues NO freshness licence, because `npx @latest` can change the bytes", async () => {
  // The worker's hour-long ttlMs is safe because its catalog changes only on
  // deploy. Here the stdio command is the natural cache key and it does NOT
  // change across a release, so a cached manifest could be paired with newer
  // bytes and refuse our own skill as `digest_mismatch`.
  const { handlers } = capture();
  const listed = await handlers.get("skills/list")!({});
  assert.equal(
    listed.ttlMs,
    undefined,
    "ttlMs must be absent for the CLI venue"
  );
  assert.equal(listed.cacheScope, "public");
  assert.equal(listed.skills.length, 2);
});

test("every manifest entry carries a digest and a byte size", () => {
  for (const entry of SKILLS_BUNDLE_ENTRIES) {
    const manifest = enumeratedResources(entry);
    assert.ok(manifest, `${entry.uri} must enumerate its files`);
    assert.ok(manifest.length > 0);
    for (const resource of manifest) {
      assert.match(resource.digest, /^sha256:[0-9a-f]{64}$/);
      assert.ok(Number.isInteger(resource.size));
    }
    // Without its own SKILL.md in the manifest a host refuses the whole skill.
    assert.ok(findListedResource(entry, entry.uri));
  }
});

test("every served file matches the exact size and digest advertised", async () => {
  let checked = 0;
  for (const entry of SKILLS_BUNDLE_ENTRIES) {
    for (const resource of enumeratedResources(entry)!) {
      const text = SKILLS_BUNDLE_CONTENTS[resource.uri];
      assert.ok(text !== undefined, `${resource.uri} has no content`);
      const bytes = new TextEncoder().encode(text);

      const sizing = verifySize(bytes.byteLength, resource);
      assert.ok(sizing.ok, `${resource.uri} size mismatch`);
      // Not merely "not refused" — the check must have actually run.
      assert.ok(sizing.ok && sizing.checked, `${resource.uri} size unchecked`);

      const digest = await verifyDigest(bytes, resource.digest);
      assert.ok(digest.ok, `${resource.uri} digest mismatch`);
      checked++;
    }
  }
  assert.ok(checked >= 13, `expected every file checked, got ${checked}`);
});

test("every SKILL.md passes full host verification", async () => {
  for (const entry of SKILLS_BUNDLE_ENTRIES) {
    const markdown = SKILLS_BUNDLE_CONTENTS[entry.uri]!;
    // Digest, size, URI/name identity, and frontmatter drift in one call.
    const verified = await verifySkillMarkdown({ entry, markdown });
    assert.equal(verified.frontmatter.name, entry.uri.split("/").at(-2));
    assert.ok(verified.frontmatter.description.length > 0);
    assert.ok(verified.body.length > 0);
  }
});

test("skill files are typed, and eval suites are not called text/plain", () => {
  // The same defect the worker had: a reader takes the type from
  // `contents[0]`, so declaring one at registration and omitting it there
  // tells two different stories about one file.
  for (const entry of SKILLS_BUNDLE_ENTRIES) {
    for (const resource of enumeratedResources(entry)!) {
      const expected = resource.uri.endsWith(".md")
        ? "text/markdown"
        : resource.uri.endsWith(".yaml")
          ? "application/yaml"
          : "text/plain";
      assert.equal(mimeTypeFor(resource.uri), expected, resource.uri);
    }
  }
});

test("content and manifest cover exactly the same URIs", () => {
  // A manifest row with no content is a promised read that fails; a content
  // entry with no row is a file no host is permitted to fetch.
  const manifestUris = SKILLS_BUNDLE_ENTRIES.flatMap((entry) =>
    entry.resources.map((resource) => resource.uri)
  ).sort();
  assert.deepEqual(Object.keys(SKILLS_BUNDLE_CONTENTS).sort(), manifestUris);
});

test("the committed bundle matches a fresh regeneration byte for byte", async () => {
  // The bundle is committed because the CLI build does not build the SDK the
  // generator imports, so a build-time hook would read a stale dist. This is
  // what keeps "committed" from drifting into "stale".
  // Regenerate with: npm run bundle:skills -w @mcpjam/cli
  const generatedPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../src/generated/SkillsBundle.generated.ts"
  );
  const committed = await readFile(generatedPath, "utf8");
  const regenerated: string = buildCliSkillsBundle();
  assert.equal(
    regenerated,
    committed,
    "skills bundle is out of date — run: npm run bundle:skills -w @mcpjam/cli"
  );
  assert.equal((CLI_SKILL_ROOTS as string[]).length, 2);
});
