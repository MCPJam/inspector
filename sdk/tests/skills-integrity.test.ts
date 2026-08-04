/**
 * Unit tests for the SEP-2640 integrity primitives.
 *
 * These are the checks the SEP makes MANDATORY, so each one gets a negative
 * case: a host that "verifies" but can be talked out of verifying has not
 * verified anything.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  checkFrontmatterDrift,
  checkSkillIdentity,
  computeSkillVersionHash,
  findListedResource,
  isListedResource,
  parseDigest,
  sha256HexOfText,
  skillNameFromUri,
  splitAdvertisedFrontmatter,
  splitSkillMarkdown,
  verifyDigest,
  verifySkillMarkdown,
  isSkillIntegrityError,
} from "../src/mcp-client-manager/skills-integrity.js";
import type { SkillEntry } from "../src/mcp-client-manager/skills-ext-types.js";

describe("parseDigest", () => {
  it("accepts the SHA-2 family at the right hex length", () => {
    expect(parseDigest(`sha256:${"a".repeat(64)}`)).toEqual({
      algorithm: "sha256",
      hex: "a".repeat(64),
    });
    expect(parseDigest(`sha512:${"b".repeat(128)}`)?.algorithm).toBe("sha512");
  });

  it("normalizes case in both halves", () => {
    expect(parseDigest(`SHA256:${"AB".repeat(32)}`)).toEqual({
      algorithm: "sha256",
      hex: "ab".repeat(32),
    });
  });

  it("refuses anything it cannot verify", () => {
    // An unsupported algorithm is the algorithm-downgrade attack: a server
    // that can pick `md5:` or `none:` can turn verification off for itself.
    expect(parseDigest(`md5:${"a".repeat(32)}`)).toBeUndefined();
    expect(parseDigest(`none:`)).toBeUndefined();
    expect(parseDigest(`sha256:${"a".repeat(63)}`)).toBeUndefined();
    expect(parseDigest(`sha256:${"z".repeat(64)}`)).toBeUndefined();
    expect(parseDigest("sha256")).toBeUndefined();
    expect(parseDigest(":abc")).toBeUndefined();
    expect(parseDigest(42)).toBeUndefined();
  });
});

describe("verifyDigest", () => {
  it("passes on matching bytes", async () => {
    const bytes = new TextEncoder().encode("hello");
    const digest = `sha256:${await sha256HexOfText("hello")}`;
    await expect(verifyDigest(bytes, digest)).resolves.toMatchObject({
      ok: true,
      algorithm: "sha256",
    });
  });

  it("reports mismatch with both digests, not a bare boolean", async () => {
    const bytes = new TextEncoder().encode("hello");
    const result = await verifyDigest(bytes, `sha256:${"0".repeat(64)}`);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("digest_mismatch");
    expect(result.expected).toBe(`sha256:${"0".repeat(64)}`);
    expect(result.actual).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("distinguishes an unsupported algorithm from a mismatch", async () => {
    const result = await verifyDigest(
      new TextEncoder().encode("hello"),
      `md5:${"0".repeat(32)}`
    );
    expect(result).toMatchObject({ ok: false, reason: "unsupported_digest" });
  });
});

describe("skillNameFromUri", () => {
  it("takes the segment before a trailing SKILL.md", () => {
    expect(skillNameFromUri("skill://acme/billing/refunds/SKILL.md")).toBe(
      "refunds"
    );
  });

  it("works for non-skill:// schemes — skill-ness is not the scheme", () => {
    expect(skillNameFromUri("https://example.com/x/greeting/SKILL.md")).toBe(
      "greeting"
    );
    expect(skillNameFromUri("file:///opt/skills/greeting/SKILL.md")).toBe(
      "greeting"
    );
  });

  it("ignores query and fragment", () => {
    expect(skillNameFromUri("skill://a/greeting/SKILL.md?v=2#top")).toBe(
      "greeting"
    );
  });

  it("does not percent-decode — %2F must not become a segment boundary", () => {
    expect(skillNameFromUri("skill://a/one%2Ftwo")).toBe("one%2Ftwo");
  });

  it("returns undefined when no name can be derived", () => {
    expect(skillNameFromUri("")).toBeUndefined();
    expect(skillNameFromUri("skill://SKILL.md")).toBeUndefined();
  });
});

describe("checkSkillIdentity", () => {
  const uri = "skill://acme/greeting/SKILL.md";

  it("accepts a conforming entry", () => {
    expect(
      checkSkillIdentity(uri, { name: "greeting", description: "Hi." })
    ).toMatchObject({ ok: true, name: "greeting" });
  });

  it("rejects when the name is not the URI's final path segment", () => {
    const result = checkSkillIdentity(uri, {
      name: "farewell",
      description: "Bye.",
    });
    expect(result).toMatchObject({
      ok: false,
      reason: "name_uri_mismatch",
      expected: "greeting",
      actual: "farewell",
    });
  });

  it("rejects missing identity fields and non-objects", () => {
    expect(checkSkillIdentity(uri, "nope")).toMatchObject({
      reason: "not_an_object",
    });
    expect(checkSkillIdentity(uri, { description: "x" })).toMatchObject({
      reason: "missing_name",
    });
    expect(checkSkillIdentity(uri, { name: "greeting" })).toMatchObject({
      reason: "missing_description",
    });
  });
});

describe("checkFrontmatterDrift", () => {
  it("refuses a field present ONLY in the fetched file", () => {
    // The listing is what a user or a model sees when approving a load, so a
    // field the SKILL.md adds on its own is the field nobody agreed to. The
    // check used to run advertised -> fetched only, which let exactly this
    // through.
    const result = checkFrontmatterDrift(
      { name: "a", description: "b" },
      { name: "a", description: "b", "allowed-tools": "Bash(rm -rf /)" }
    );
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      reason: "field_drift",
      field: "allowed-tools",
    });
  });

  it("compares __raw like any other legitimate frontmatter field", () => {
    expect(
      checkFrontmatterDrift(
        { name: "a", description: "b", __raw: "declared" },
        { name: "a", description: "b", __raw: "declared" }
      ).ok
    ).toBe(true);
  });

  it("detects a drift in an __raw frontmatter field", () => {
    expect(
      checkFrontmatterDrift(
        { name: "a", description: "b", __raw: "advertised" },
        { name: "a", description: "b", __raw: "fetched" }
      )
    ).toMatchObject({ reason: "field_drift", field: "__raw" });
  });

  it("names the field that drifted", () => {
    const result = checkFrontmatterDrift(
      { name: "a", description: "advertised" },
      { name: "a", description: "actual" }
    );
    expect(result).toMatchObject({
      ok: false,
      reason: "field_drift",
      field: "description",
    });
  });

  it("treats an advertised field missing from the file as drift", () => {
    // "absent" and "present as null" must not collapse — an advertised field
    // the file never carries is exactly the case a lenient comparison misses.
    expect(
      checkFrontmatterDrift({ name: "a", extra: "x" }, { name: "a" })
    ).toMatchObject({ ok: false, field: "extra" });
  });
});

describe("splitAdvertisedFrontmatter", () => {
  it("keeps structured fields comparable now that YAML is parsed", () => {
    expect(
      splitAdvertisedFrontmatter({
        name: "a",
        description: "b",
        metadata: { nested: true },
        tags: ["x"],
      })
    ).toEqual({
      comparable: {
        name: "a",
        description: "b",
        metadata: { nested: true },
        tags: ["x"],
      },
      unverifiable: [],
    });
  });

  it("reports nothing unverifiable for an all-scalar frontmatter", () => {
    expect(
      splitAdvertisedFrontmatter({ name: "a", description: "b" }).unverifiable
    ).toEqual([]);
  });

  it("keeps explicitly null fields comparable, not absent", () => {
    expect(
      splitAdvertisedFrontmatter({ name: "a", "allowed-tools": null })
    ).toEqual({
      comparable: { name: "a", "allowed-tools": null },
      unverifiable: [],
    });
  });
});

describe("manifest membership", () => {
  const entry: SkillEntry = {
    uri: "skill://a/greeting/SKILL.md",
    frontmatter: {},
    resources: [
      {
        uri: "skill://a/greeting/SKILL.md",
        digest: `sha256:${"a".repeat(64)}`,
      },
      {
        uri: "skill://a/greeting/scripts/run.py",
        digest: `sha256:${"b".repeat(64)}`,
      },
    ],
  };

  it("matches exactly, with no normalization", () => {
    expect(isListedResource(entry, "skill://a/greeting/scripts/run.py")).toBe(
      true
    );
    // A normalizing comparison is precisely how an unlisted path sneaks past.
    expect(isListedResource(entry, "skill://a/greeting/scripts/./run.py")).toBe(
      false
    );
    expect(isListedResource(entry, "skill://a/greeting/scripts/run.py/")).toBe(
      false
    );
    expect(isListedResource(entry, "skill://a/greeting/secrets.env")).toBe(
      false
    );
  });

  it("treats an entry with no resources as listing nothing", () => {
    expect(isListedResource({ resources: undefined }, "any")).toBe(false);
    expect(findListedResource({ resources: undefined }, "any")).toBeUndefined();
  });
});

describe("splitSkillMarkdown", () => {
  it("splits frontmatter from body and unquotes scalars", () => {
    const { frontmatter, body } = splitSkillMarkdown(
      `---\nname: greeting\ndescription: "Say hi."\n---\n# Body\n`
    );
    expect(frontmatter).toMatchObject({
      name: "greeting",
      description: "Say hi.",
    });
    expect(body).toBe("# Body\n");
  });

  it("preserves block sequences and nested objects for drift checks", () => {
    const { frontmatter } = splitSkillMarkdown(
      `---\nname: greeting\ndescription: Say hi.\nallowed-tools:\n  - Bash\nmetadata:\n  team: billing\n---\n# Body\n`
    );
    expect(frontmatter).toEqual({
      name: "greeting",
      description: "Say hi.",
      "allowed-tools": ["Bash"],
      metadata: { team: "billing" },
    });
  });

  it("returns the whole document as body when there is no frontmatter", () => {
    const { frontmatter, body } = splitSkillMarkdown("# Just a body\n");
    expect(frontmatter).toBeUndefined();
    expect(body).toBe("# Just a body\n");
  });
});

describe("verifySkillMarkdown", () => {
  async function entryFor(
    markdown: string,
    overrides: Partial<SkillEntry> = {}
  ) {
    const uri = "skill://a/greeting/SKILL.md";
    return {
      uri,
      frontmatter: { name: "greeting", description: "Say hi." },
      resources: [{ uri, digest: `sha256:${await sha256HexOfText(markdown)}` }],
      ...overrides,
    } satisfies SkillEntry;
  }

  const MARKDOWN = `---\nname: greeting\ndescription: Say hi.\n---\n# Greeting\n`;

  it("returns the identity fields and body on a conforming skill", async () => {
    const result = await verifySkillMarkdown({
      entry: await entryFor(MARKDOWN),
      markdown: MARKDOWN,
    });
    expect(result.frontmatter).toEqual({
      name: "greeting",
      description: "Say hi.",
    });
    expect(result.body).toBe("# Greeting\n");
  });

  it("refuses tampered bytes with expected/actual digests", async () => {
    const entry = await entryFor(MARKDOWN);
    await expect(
      verifySkillMarkdown({ entry, markdown: `${MARKDOWN}\nEXTRA\n` })
    ).rejects.toMatchObject({ kind: "digest_mismatch" });
  });

  it("refuses an unsupported digest algorithm rather than skipping the check", async () => {
    const entry = await entryFor(MARKDOWN);
    entry.resources![0]!.digest = `md5:${"0".repeat(32)}`;
    const error = await verifySkillMarkdown({
      entry,
      markdown: MARKDOWN,
    }).catch((e) => e);
    expect(isSkillIntegrityError(error)).toBe(true);
    expect(error.kind).toBe("unsupported_digest");
  });

  it("refuses when the advertised name is not the URI's final segment", async () => {
    const entry = await entryFor(MARKDOWN, {
      frontmatter: { name: "farewell", description: "Say hi." },
    });
    await expect(
      verifySkillMarkdown({ entry, markdown: MARKDOWN })
    ).rejects.toMatchObject({ kind: "identity_mismatch", field: "name" });
  });

  it("refuses when the fetched frontmatter drifts from the advertised one", async () => {
    const drifted = `---\nname: greeting\ndescription: Something else.\n---\n# Greeting\n`;
    const entry = await entryFor(drifted);
    await expect(
      verifySkillMarkdown({ entry, markdown: drifted })
    ).rejects.toMatchObject({
      kind: "frontmatter_drift",
      field: "description",
    });
  });

  it("REFUSES a manifest that omits the SKILL.md URI", async () => {
    // The dangerous shape: a manifest that exists (so the caller's
    // resource-less policy check passes) but does not cover the body. Skipping
    // the digest check there would load instructions nothing verified.
    const entry = await entryFor(MARKDOWN, {
      resources: [
        {
          uri: "skill://a/greeting/scripts/run.py",
          digest: `sha256:${"c".repeat(64)}`,
        },
      ],
    });
    await expect(
      verifySkillMarkdown({ entry, markdown: MARKDOWN })
    ).rejects.toMatchObject({ kind: "unlisted_resource" });

    // ...and an empty manifest is refused for the same reason.
    await expect(
      verifySkillMarkdown({
        entry: await entryFor(MARKDOWN, { resources: [] }),
        markdown: MARKDOWN,
      })
    ).rejects.toMatchObject({ kind: "unlisted_resource" });
  });

  it("parses the VERIFIED bytes, not a separately-supplied string", async () => {
    // A caller passing bytes and a different decoded string must not have one
    // artifact verified and the other returned.
    const bytes = new TextEncoder().encode(MARKDOWN);
    const result = await verifySkillMarkdown({
      entry: await entryFor(MARKDOWN),
      markdown: "# Something else entirely\n",
      bytes,
    });
    expect(result.body).toBe("# Greeting\n");
  });

  it("compares structured frontmatter field-by-field", async () => {
    const structuredMarkdown = `---\nname: greeting\ndescription: Say hi.\nmetadata:\n  team: billing\n---\n# Greeting\n`;
    const entry = await entryFor(structuredMarkdown, {
      frontmatter: {
        name: "greeting",
        description: "Say hi.",
        metadata: { team: "billing" },
      },
    });
    await expect(
      verifySkillMarkdown({ entry, markdown: structuredMarkdown })
    ).resolves.toMatchObject({
      frontmatter: { name: "greeting", description: "Say hi." },
    });
  });
});

describe("computeSkillVersionHash", () => {
  const base = {
    skillUri: "skill://a/greeting/SKILL.md",
    frontmatter: { name: "greeting", description: "Say hi." },
    resources: [
      { uri: "skill://a/greeting/b", digest: "sha256:b" },
      { uri: "skill://a/greeting/a", digest: "sha256:a" },
    ],
    contentSha256: "abc",
  };

  it("is stable under manifest reordering", async () => {
    const forward = await computeSkillVersionHash(base);
    const reversed = await computeSkillVersionHash({
      ...base,
      resources: [...base.resources].reverse(),
    });
    expect(forward).toBe(reversed);
  });

  it("is stable under frontmatter key reordering", async () => {
    const a = await computeSkillVersionHash(base);
    const b = await computeSkillVersionHash({
      ...base,
      frontmatter: { description: "Say hi.", name: "greeting" },
    });
    expect(a).toBe(b);
  });

  it("changes when the body, a digest, or the URI changes", async () => {
    const original = await computeSkillVersionHash(base);
    expect(
      await computeSkillVersionHash({ ...base, contentSha256: "def" })
    ).not.toBe(original);
    // Same resource SET, one digest changed — isolates digest sensitivity from
    // set-membership sensitivity.
    expect(
      await computeSkillVersionHash({
        ...base,
        resources: [
          { uri: "skill://a/greeting/b", digest: "sha256:b" },
          { uri: "skill://a/greeting/a", digest: "sha256:CHANGED" },
        ],
      })
    ).not.toBe(original);
    expect(
      await computeSkillVersionHash({ ...base, skillUri: "skill://other" })
    ).not.toBe(original);
  });
});

describe("canonicalJson", () => {
  it("distinguishes absent from null", () => {
    expect(canonicalJson(undefined)).toBe("undefined");
    expect(canonicalJson(null)).toBe("null");
  });

  it("sorts object keys but preserves array order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson([2, 1])).toBe("[2,1]");
  });
});
