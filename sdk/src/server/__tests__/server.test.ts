import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkStructuredOutput,
  compileOutputSchema,
  pageOf,
  skillManifestEntry,
  skillNotFoundError,
  skillsCapability,
  SKILLS_EXTENSION_ID,
} from "../index.js";
import type { CompileOutputSchema } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The code of every module the entry loads, found by following its relative
 * imports, so a helper it borrows from elsewhere in the SDK is checked too.
 * Type-only imports load nothing at runtime and are not followed.
 */
function loadedSources(): Map<string, string> {
  const sources = new Map<string, string>();
  const visit = (file: string) => {
    if (sources.has(file)) return;
    // The code only: a comment may name what the code avoids.
    const code = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    sources.set(file, code);
    for (const [, path] of code.matchAll(/(?:import|export)\s+(?!type\b)[^;]*?from "(\.[^"]*)\.js"/g)) {
      visit(join(dirname(file), `${path}.ts`));
    }
  };
  visit(join(here, "..", "index.ts"));
  return sources;
}

describe("@mcpjam/sdk/server", () => {
  it("uses no Node API and no code-compiling validator, so it runs on Workers", () => {
    const sources = loadedSources();
    // The entry's own modules and the skills helpers it borrows.
    expect(sources.size).toBeGreaterThan(6);
    for (const [file, code] of sources) {
      expect(code, file).not.toMatch(/from "node:/);
      expect(code, file).not.toMatch(/\bBuffer\b/);
      expect(code, file).not.toMatch(/from "ajv/);
      expect(code, file).not.toMatch(/dialect-aware-json-schema-validator/);
    }
  });
});

describe("pageOf", () => {
  const items = ["a", "b", "c", "d", "e"];

  it("pages with cursors it issued, and returns the whole list without a page size", () => {
    const first = pageOf(items, undefined, 2);
    expect(first.items).toEqual(["a", "b"]);
    const second = pageOf(items, first.nextCursor, 2);
    expect(second.items).toEqual(["c", "d"]);
    const last = pageOf(items, second.nextCursor, 2);
    expect(last).toEqual({ items: ["e"] });
    expect(pageOf(items, undefined, undefined)).toEqual({ items });
  });

  it("refuses a cursor it did not issue, with the caller's error when given one", () => {
    expect(() => pageOf(items, "not-a-cursor!", 2)).toThrow(
      /not valid for this list/
    );
    expect(() => pageOf(items, btoa("other:1"), 2)).toThrow(
      /not valid for this list/
    );
    const own = new Error("own refusal");
    expect(() =>
      pageOf(items, "not-a-cursor!", 2, { invalidCursor: () => own })
    ).toThrow(own);
  });

  it("refuses any cursor when the list does not page, even one a paged list issued", () => {
    const issued = pageOf(items, undefined, 2).nextCursor;
    expect(() => pageOf(items, issued, undefined)).toThrow(/not valid for this list/);
    const own = new Error("own refusal");
    expect(() => pageOf(items, issued, undefined, { invalidCursor: () => own })).toThrow(own);
  });

  it("refuses a page size that is not a whole number from 1", () => {
    for (const size of [0, -1, 0.5, Number.NaN]) {
      expect(() => pageOf(items, undefined, size)).toThrow(RangeError);
    }
  });
});

describe("checkStructuredOutput", () => {
  const schema = { type: "object", required: ["n"] };
  const requiresN: CompileOutputSchema = () => (value) =>
    typeof value === "object" && value !== null && "n" in value
      ? { valid: true }
      : { valid: false, errorMessage: "must have required property 'n'" };

  it("judges a result with the validator it is given", () => {
    expect(
      checkStructuredOutput(schema, { structuredContent: { n: 1 } }, requiresN)
    ).toEqual({ ok: true });
    expect(
      checkStructuredOutput(schema, { structuredContent: {} }, requiresN)
    ).toEqual({ ok: false, message: "must have required property 'n'" });
  });

  it("asks for structuredContent, exempts an error result, and passes a schema it cannot judge", () => {
    expect(checkStructuredOutput(schema, {}, requiresN)).toMatchObject({
      ok: false,
      message: expect.stringContaining("must include structuredContent"),
    });
    expect(checkStructuredOutput(schema, { isError: true }, requiresN)).toEqual(
      { ok: true }
    );
    expect(
      checkStructuredOutput(schema, { structuredContent: {} }, () => undefined)
    ).toEqual({ ok: true });
  });

  it("reports a schema that does not compile, and leaves a root $async unchecked", () => {
    const throws: CompileOutputSchema = () => {
      throw new Error("bad schema");
    };
    expect(compileOutputSchema(schema, throws)).toEqual({
      status: "broken",
      reason: "bad schema",
    });
    expect(compileOutputSchema({ $async: true }, requiresN)).toEqual({
      status: "unchecked",
    });
  });
});

describe("skills", () => {
  it("declares the extension as an object, not true", () => {
    expect(skillsCapability()).toEqual({ [SKILLS_EXTENSION_ID]: {} });
  });

  it("lists a file with the SHA-256 and size of the bytes served", async () => {
    const bytes = new TextEncoder().encode("hello");
    expect(await skillManifestEntry("skill://a/SKILL.md", bytes)).toEqual({
      uri: "skill://a/SKILL.md",
      digest:
        "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      size: 5,
    });
  });

  it("answers an unknown skill with -32602 and the URI", () => {
    const error = skillNotFoundError("skill://x/SKILL.md", { reason: "gone" });
    expect(error.code).toBe(-32602);
    expect(error.data).toEqual({ reason: "gone", uri: "skill://x/SKILL.md" });
  });
});
