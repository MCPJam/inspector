/**
 * The generic validators the portal's code table drives: each rule kind, the
 * stage limits, and the order in which one problem hides the next.
 */

import { describe, expect, it } from "vitest";

import { portalPluginNameRefusals } from "../../src/plugin-bundle/plugin-name.js";
import { validateOpenAIPortalDocument } from "../../src/openai-readiness/portal-codes/validate.js";

/** A Codex manifest the portal accepts, with sample names. */
const manifest = (
  overrides: Record<string, unknown> = {},
  listing: Record<string, unknown> = {}
) => ({
  name: "sample-notes",
  version: "1.0.0",
  description: "Find and summarize notes.",
  author: {
    name: "Sample Person",
    email: "review@example.com",
    url: "https://example.com",
  },
  homepage: "https://example.com",
  skills: "./skills/",
  mcpServers: "./.mcp.json",
  interface: {
    displayName: "Sample Notes",
    shortDescription: "Find notes",
    longDescription: "Find and summarize notes.\nLine breaks are allowed.",
    developerName: "Sample Developer",
    category: "Productivity",
    capabilities: ["Find notes", "Summarize notes"],
    websiteURL: "https://example.com",
    supportURL: "https://example.com/support",
    privacyPolicyURL: "https://example.com/privacy",
    termsOfServiceURL: "https://example.com/terms",
    defaultPrompt: ["Find my notes about planning"],
    brandColor: "#1A5FB4",
    brandColorDark: "#62A0EA",
    logo: "./assets/icon.svg",
    composerIcon: "./assets/icon.svg",
    ...listing,
  },
  ...overrides,
});

const upload = (value: unknown) =>
  validateOpenAIPortalDocument("plugin-manifest", value);
const submission = (value: unknown) =>
  validateOpenAIPortalDocument("plugin-manifest", value, {
    stage: "submission",
  });
const codes = (violations: { code: string }[]) =>
  violations.map((violation) => violation.code);

describe("a complete manifest", () => {
  it("breaks no code at upload or at submission", () => {
    expect(upload(manifest())).toEqual([]);
    expect(submission(manifest())).toEqual([]);
  });
});

describe("presence", () => {
  it("reports each required field that is missing, in the page's order", () => {
    expect(upload({})).toEqual([
      { code: "plugin_name_missing", field: "name" },
      { code: "plugin_version_missing", field: "version" },
      { code: "plugin_description_missing", field: "description" },
      { code: "plugin_developer_missing", field: "author.name" },
      { code: "plugin_display_name_empty", field: "interface.displayName" },
      {
        code: "plugin_short_description_missing",
        field: "interface.shortDescription",
      },
      {
        code: "plugin_long_description_empty",
        field: "interface.longDescription",
      },
      {
        code: "plugin_developer_name_empty",
        field: "interface.developerName",
      },
    ]);
  });

  it("reports a missing field once, without its length or format", () => {
    expect(codes(upload(manifest({ name: undefined })))).toEqual([
      "plugin_name_missing",
    ]);
  });
});

describe("type", () => {
  it("names the type found and the one wanted", () => {
    expect(upload(manifest({ name: 7 }))).toEqual([
      {
        code: "plugin_name_wrong_type",
        field: "name",
        observed: "number",
        expected: "string",
      },
    ]);
    expect(upload(manifest({}, { defaultPrompt: { first: "x" } }))).toEqual([
      {
        code: "plugin_default_prompt_wrong_type",
        field: "interface.defaultPrompt",
        observed: "object",
        expected: "string or array",
      },
    ]);
  });

  it("stops at a container of the wrong type", () => {
    expect(codes(upload(manifest({ interface: "Sample Notes" })))).toEqual([
      "plugin_interface_wrong_type",
    ]);
    expect(codes(upload(manifest({}, { capabilities: "Find notes" })))).toEqual(
      ["plugin_capabilities_wrong_type"]
    );
    expect(codes(upload(manifest({ author: "Sample Person" })))).toEqual([
      "plugin_developer_missing",
      "plugin_author_wrong_type",
    ]);
  });

  it("checks each entry of a list by its index", () => {
    expect(
      upload(manifest({}, { defaultPrompt: ["Find my notes", 7] }))
    ).toEqual([
      {
        code: "plugin_default_prompt_entry_wrong_type",
        field: "interface.defaultPrompt[1]",
        observed: "number",
        expected: "string",
      },
    ]);
  });
});

describe("emptiness", () => {
  it("reads a whitespace-only value as empty and stops there", () => {
    expect(codes(upload(manifest({ name: "  " })))).toEqual([
      "plugin_name_empty",
    ]);
    expect(codes(upload(manifest({}, { displayName: " " })))).toEqual([
      "plugin_display_name_empty",
    ]);
    expect(codes(upload(manifest({}, { category: "" })))).toEqual([
      "plugin_category_empty",
    ]);
  });
});

describe("length", () => {
  it("counts characters, not UTF-16 units", () => {
    expect(upload(manifest({ description: "a".repeat(1025) }))).toEqual([
      {
        code: "plugin_description_too_long",
        field: "description",
        observed: 1025,
        expected: 1024,
      },
    ]);
    expect(upload(manifest({ description: "📝".repeat(1024) }))).toEqual([]);
  });

  it("uses the final-submission limits the page gives for submission", () => {
    const longUrl = `https://example.com/${"a".repeat(1100)}`;
    const listing = { websiteURL: longUrl, displayName: "A".repeat(31) };
    expect(upload(manifest({}, listing))).toEqual([]);
    expect(submission(manifest({}, listing))).toEqual([
      {
        code: "submission_display_name_too_long",
        field: "interface.displayName",
        observed: 31,
        expected: 30,
      },
      {
        code: "plugin_website_url_too_long",
        field: "interface.websiteURL",
        observed: longUrl.length,
        expected: 1024,
      },
    ]);
  });

  it("applies a single prompt's limit to the prompt itself", () => {
    expect(upload(manifest({}, { defaultPrompt: "a".repeat(513) }))).toEqual([
      {
        code: "plugin_default_prompt_too_long",
        field: "interface.defaultPrompt",
        observed: 513,
        expected: 512,
      },
    ]);
  });
});

describe("pattern", () => {
  it("refuses a value outside the code's pattern", () => {
    expect(codes(upload(manifest({ name: "com.example.notes" })))).toEqual([
      "plugin_name_format",
    ]);
    expect(codes(upload(manifest({ version: "1.0" })))).toEqual([
      "plugin_version_not_semver",
    ]);
    expect(codes(upload(manifest({}, { brandColor: "#12345" })))).toEqual([
      "plugin_brand_color_format",
    ]);
    expect(codes(upload(manifest({ skills: "./other/" })))).toEqual([
      "plugin_skills_path_unsupported",
    ]);
  });

  it("refuses a URL that is not HTTPS or carries credentials", () => {
    const author = (url: string) =>
      manifest({ author: { name: "Sample Person", url } });
    expect(codes(upload(author("http://example.com")))).toEqual([
      "plugin_author_url_not_https",
    ]);
    expect(codes(upload(author("https://user:secret@example.com")))).toEqual([
      "plugin_author_url_has_credentials",
    ]);
    expect(
      codes(upload(manifest({}, { supportURL: "https://user@example.com" })))
    ).toEqual(["plugin_support_url_format"]);
  });

  it("refuses an MCP server mention in a starter prompt at submission", () => {
    const prompts = (defaultPrompt: string[]) =>
      submission(manifest({}, { defaultPrompt }));
    expect(prompts(["@Sample find my notes"])).toEqual([
      {
        code: "plugin_default_prompt_mention",
        field: "interface.defaultPrompt[0]",
        observed: "@Sample find my notes",
      },
    ]);
    expect(prompts(["Email review@example.com my notes"])).toEqual([]);
  });
});

describe("values", () => {
  it("accepts only the page's categories", () => {
    expect(upload(manifest({}, { category: "Games" }))).toEqual([
      {
        code: "plugin_category_unknown",
        field: "interface.category",
        observed: "Games",
      },
    ]);
    expect(upload(manifest({}, { category: "Developer Tools" }))).toEqual([]);
  });
});

describe("count", () => {
  it("caps capabilities and starter prompts", () => {
    const capabilities = Array.from({ length: 21 }, (_, i) => `Task ${i}`);
    expect(upload(manifest({}, { capabilities }))).toEqual([
      {
        code: "plugin_capabilities_too_many",
        field: "interface.capabilities",
        observed: 21,
        expected: 20,
      },
    ]);
    expect(
      codes(upload(manifest({}, { defaultPrompt: ["a", "b", "c", "d"] })))
    ).toEqual(["plugin_default_prompt_too_many"]);
  });
});

describe("supported text", () => {
  it("names the first unsupported character", () => {
    expect(upload(manifest({ description: "Find\u0007 notes." }))).toEqual([
      {
        code: "plugin_description_character_unsupported",
        field: "description",
        observed: "U+0007",
      },
    ]);
  });

  it("refuses a line break only where the page asks for one line", () => {
    expect(submission(manifest({}, { displayName: "Sample\nNotes" }))).toEqual([
      {
        code: "submission_display_name_character_unsupported",
        field: "interface.displayName",
        observed: "a line break",
      },
    ]);
    expect(submission(manifest({}, { longDescription: "One.\nTwo." }))).toEqual(
      []
    );
    expect(
      codes(submission(manifest({}, { capabilities: ["Find\nnotes"] })))
    ).toEqual(["plugin_capability_invalid"]);
  });
});

describe("the other documents", () => {
  it("checks `.mcp.json` servers", () => {
    expect(validateOpenAIPortalDocument("mcp-config", {})).toEqual([
      { code: "mcp_servers_missing", field: "mcpServers" },
    ]);
    expect(
      validateOpenAIPortalDocument("mcp-config", {
        mcpServers: { notes: { type: "streamable-http" }, broken: "x" },
      })
    ).toEqual([
      {
        code: "mcp_server_wrong_type",
        field: "mcpServers.broken",
        observed: "string",
        expected: "object",
      },
    ]);
  });

  it("checks each `.app.json` entry, and nothing under a broken one", () => {
    expect(
      codes(
        validateOpenAIPortalDocument("app-config", {
          apps: {
            notes: { id: "connector_notes", optional: true },
            other: { id: "other_notes", required: "yes" },
            broken: 3,
          },
        })
      )
    ).toEqual([
      "app_entry_wrong_type",
      "app_id_format",
      "app_entry_required_wrong_type",
    ]);
  });

  it("checks a skill's front matter", () => {
    expect(
      codes(
        validateOpenAIPortalDocument("skill-frontmatter", {
          name: "",
          description: "a".repeat(1025),
        })
      )
    ).toEqual(["skill_name_empty", "skill_description_too_long"]);
  });

  it("checks a skill's `agents/openai.yaml`", () => {
    expect(validateOpenAIPortalDocument("skill-agent", {})).toEqual([
      { code: "skill_agent_interface_missing", field: "interface" },
    ]);
    expect(
      codes(
        validateOpenAIPortalDocument("skill-agent", {
          interface: {
            display_name: "Notes",
            short_description: "Find notes",
            brand_color: "blue",
          },
          policy: { allow_implicit_invocation: "yes" },
        })
      )
    ).toEqual([
      "skill_agent_brand_color_format",
      "skill_agent_allow_implicit_invocation_wrong_type",
    ]);
  });
});

describe("one name rule", () => {
  it("agrees with the import parser's portal name rules", () => {
    for (const name of [
      undefined,
      null,
      7,
      "",
      "  ",
      "sample-notes",
      "Sample_Notes",
      "a-",
      "-notes",
      "com.example.notes",
      "notes!",
      "a".repeat(64),
      "a".repeat(65),
      "é",
    ]) {
      const generic = upload(manifest({ name }))
        .filter((violation) => violation.field === "name")
        .map((violation) => violation.code);
      expect(generic, String(name)).toEqual(portalPluginNameRefusals(name));
    }
  });
});
