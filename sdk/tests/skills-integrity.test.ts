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
  verifySize,
  verifySkillMarkdown,
  isSkillIntegrityError,
  checkManifestLimits,
  enumeratedResources,
  isDynamicResources,
} from "../src/mcp-client-manager/skills-integrity.js";
import {
  DYNAMIC_SKILL_RESOURCES,
  MAX_SKILL_RESOURCE_ENTRIES,
  MAX_SKILL_TOTAL_BYTES,
} from "../src/mcp-client-manager/skills-ext-types.js";
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

describe("verifySize", () => {
  it("passes and records that it checked when the length matches", () => {
    expect(verifySize(12, { size: 12 })).toEqual({ ok: true, checked: true });
  });

  it("fails with both numbers when the length differs", () => {
    // Off by ONE, which is what a truncated read actually looks like. A wildly
    // wrong number would pass a sloppier implementation that only sniffs for
    // implausible values.
    expect(verifySize(11, { size: 12 })).toEqual({
      ok: false,
      expected: 12,
      actual: 11,
    });
  });

  it("passes but reports NOT checked when the server sent no size", () => {
    // The draft requires `size`, but it is unratified and pre-`size` servers
    // exist. Tolerating absence is deliberate; silently claiming to have
    // checked would not be.
    expect(verifySize(12, {})).toEqual({ ok: true, checked: false });
  });

  it("treats a zero-byte file as a real length, not a missing one", () => {
    expect(verifySize(0, { size: 0 })).toEqual({ ok: true, checked: true });
    expect(verifySize(1, { size: 0 })).toEqual({
      ok: false,
      expected: 0,
      actual: 1,
    });
  });
});

describe("checkManifestLimits", () => {
  const ref = (i: number, size?: number) => ({
    uri: `skill://a/b/${i}`,
    digest: "sha256:x",
    ...(size === undefined ? {} : { size }),
  });

  it("accepts a manifest inside both limits and reports the budget", () => {
    expect(checkManifestLimits([ref(0, 10), ref(1, 20)])).toEqual({
      ok: true,
      entryCount: 2,
      totalBytes: 30,
    });
  });

  it("rejects more entries than the draft requires hosts to support", () => {
    const oversized = Array.from(
      { length: MAX_SKILL_RESOURCE_ENTRIES + 1 },
      (_, i) => ref(i, 1)
    );
    expect(checkManifestLimits(oversized)).toEqual({
      ok: false,
      reason: "too_many_resources",
      expected: MAX_SKILL_RESOURCE_ENTRIES,
      actual: MAX_SKILL_RESOURCE_ENTRIES + 1,
    });
  });

  it("accepts exactly the limit — the draft says up to AND INCLUDING", () => {
    const atLimit = Array.from({ length: MAX_SKILL_RESOURCE_ENTRIES }, (_, i) =>
      ref(i, 1)
    );
    expect(checkManifestLimits(atLimit).ok).toBe(true);
    expect(checkManifestLimits([ref(0, MAX_SKILL_TOTAL_BYTES)]).ok).toBe(true);
  });

  it("rejects a total over the per-skill byte budget", () => {
    expect(checkManifestLimits([ref(0, MAX_SKILL_TOTAL_BYTES + 1)])).toEqual({
      ok: false,
      reason: "too_large",
      expected: MAX_SKILL_TOTAL_BYTES,
      actual: MAX_SKILL_TOTAL_BYTES + 1,
    });
  });

  it("reports an UNDEFINED budget when any entry omitted its size", () => {
    // A partial sum is not a budget. Reporting one would invite a caller to
    // enforce a limit against a number that undercounts by an unknown amount.
    expect(checkManifestLimits([ref(0, 10), ref(1)])).toEqual({
      ok: true,
      entryCount: 2,
      totalBytes: undefined,
    });
  });

  it("still refuses when the MEASURED bytes alone exceed the budget", () => {
    // A partial sum is a floor. Requiring every entry to carry `size` before
    // enforcing the total made the budget inert for the servers that are the
    // norm today, and let one unmeasured entry among 512 switch it off.
    const check = checkManifestLimits([
      ref(0, MAX_SKILL_TOTAL_BYTES + 1),
      ref(1),
    ]);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toBe("too_large");
  });

  it("accepts a partial sum that is within the budget", () => {
    // Under the limit, an unmeasured entry proves nothing either way, so the
    // skill loads and the reported budget stays `undefined`.
    const check = checkManifestLimits([ref(0, MAX_SKILL_TOTAL_BYTES), ref(1)]);
    expect(check.ok).toBe(true);
    expect(check.ok === true && check.totalBytes).toBeUndefined();
  });
});

describe("dynamic resources", () => {
  it("separates a dynamic manifest from an absent one", () => {
    expect(isDynamicResources({ resources: DYNAMIC_SKILL_RESOURCES })).toBe(
      true
    );
    expect(isDynamicResources({ resources: [] })).toBe(false);
    expect(isDynamicResources({})).toBe(false);
  });

  it("never lets a dynamic manifest be indexed as an array", () => {
    expect(
      enumeratedResources({ resources: DYNAMIC_SKILL_RESOURCES })
    ).toBeUndefined();
    expect(enumeratedResources({})).toBeUndefined();
    expect(enumeratedResources({ resources: [] })).toEqual([]);
  });

  it("resolves no listed resource for a dynamic skill", () => {
    // The read allowlist must be EMPTY, not "everything": a dynamic skill has
    // no manifest, so no URI is authorized by it.
    expect(
      findListedResource(
        { resources: DYNAMIC_SKILL_RESOURCES },
        "skill://a/b/SKILL.md"
      )
    ).toBeUndefined();
    expect(
      isListedResource(
        { resources: DYNAMIC_SKILL_RESOURCES },
        "skill://a/b/SKILL.md"
      )
    ).toBe(false);
  });
});

describe("verifySkillMarkdown size enforcement", () => {
  const markdown = "---\nname: greeting\ndescription: Say hi\n---\n\nBody\n";
  const uri = "skill://acme/greeting/SKILL.md";

  async function entryWith(size: number | undefined) {
    return {
      uri,
      frontmatter: { name: "greeting", description: "Say hi" },
      resources: [
        {
          uri,
          digest: `sha256:${await sha256HexOfText(markdown)}`,
          ...(size === undefined ? {} : { size }),
        },
      ],
    };
  }

  it("rejects a length mismatch even when the digest would pass", async () => {
    // The digest here is CORRECT. Only the advertised size is wrong, which is
    // exactly the case the draft calls out: a verification failure "whether or
    // not the host goes on to compute the digest".
    const entry = await entryWith(Buffer.byteLength(markdown, "utf8") + 1);
    await expect(verifySkillMarkdown({ entry, markdown })).rejects.toSatisfy(
      (error: unknown) =>
        isSkillIntegrityError(error) && error.kind === "size_mismatch"
    );
  });

  it("reports the advertised and actual lengths", async () => {
    const actual = Buffer.byteLength(markdown, "utf8");
    const entry = await entryWith(actual + 1);
    await verifySkillMarkdown({ entry, markdown }).then(
      () => {
        throw new Error("expected a refusal");
      },
      (error: unknown) => {
        if (!isSkillIntegrityError(error)) throw error;
        expect(error.expected).toBe(String(actual + 1));
        expect(error.actual).toBe(String(actual));
      }
    );
  });

  it("accepts a matching length", async () => {
    const entry = await entryWith(Buffer.byteLength(markdown, "utf8"));
    await expect(
      verifySkillMarkdown({ entry, markdown })
    ).resolves.toMatchObject({ body: "\nBody\n" });
  });

  it("still loads when the server omitted size entirely", async () => {
    const entry = await entryWith(undefined);
    await expect(
      verifySkillMarkdown({ entry, markdown })
    ).resolves.toMatchObject({ body: "\nBody\n" });
  });
});
