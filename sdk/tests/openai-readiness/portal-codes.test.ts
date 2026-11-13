/**
 * The portal's code table: every code on its submission-errors page, once,
 * with the page's words, and with limits, fields and files that agree with
 * those words.
 */

import { describe, expect, it } from "vitest";

import { PLUGIN_PORTAL_RULES } from "../../src/plugin-bundle/portal-rules.js";
import {
  OPENAI_PORTAL_CODE_TABLES,
  OPENAI_PORTAL_CODES_SOURCE,
} from "../../src/openai-readiness/portal-codes/define.js";
import { OPENAI_PORTAL_LISTING_CATEGORIES } from "../../src/openai-readiness/portal-codes/listing.js";
import {
  OPENAI_PORTAL_CODES,
  OPENAI_PORTAL_CODES_BY_CODE,
  isOpenAIPortalCode,
} from "../../src/openai-readiness/portal-codes/table.js";
import { OPENAI_PORTAL_ERRORS_BY_ID } from "../../src/openai-readiness/portal-errors.js";

/** Rows per table, counted on the captured page. */
const PAGE_COUNTS = {
  "Final metadata errors": 15,
  "MCP and review errors": 5,
  "ZIP upload errors and warnings": 7,
  "ZIP structure and limit errors": 19,
  "Plugin root errors": 4,
  "Plugin manifest errors": 40,
  "Listing and interface errors": 62,
  "Plugin content errors": 16,
  "MCP manifest errors": 7,
  "Skill errors": 23,
  "Skill agent metadata errors": 26,
  "Asset path errors": 9,
  "Image errors": 17,
  "MCP server reference errors": 12,
  "Package warnings": 7,
};

const tokensOf = (message: string) =>
  [...message.matchAll(/`([^`]+)`/g)].map((match) => match[1]);

describe("the code table", () => {
  it("holds the page's 269 codes, each once", () => {
    const codes = OPENAI_PORTAL_CODES.map((definition) => definition.code);
    expect(codes).toHaveLength(269);
    expect(new Set(codes).size).toBe(269);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z0-9_]+$/);
      expect(isOpenAIPortalCode(code)).toBe(true);
      expect(OPENAI_PORTAL_CODES_BY_CODE[code].code).toBe(code);
    }
    expect(isOpenAIPortalCode("archive-too-large")).toBe(false);
    expect(isOpenAIPortalCode("toString")).toBe(false);
  });

  it("has each table's row count, in the page's order", () => {
    const counts: Record<string, number> = {};
    for (const { table } of OPENAI_PORTAL_CODES) {
      counts[table] = (counts[table] ?? 0) + 1;
    }
    expect(counts).toEqual(PAGE_COUNTS);
    const order = [...new Set(OPENAI_PORTAL_CODES.map((row) => row.table))];
    expect(order).toEqual([...OPENAI_PORTAL_CODE_TABLES]);
  });

  it("gives every code a severity, a stage, a message and the source", () => {
    for (const definition of OPENAI_PORTAL_CODES) {
      expect(["error", "warning"]).toContain(definition.severity);
      expect(definition.stage).toBe(
        definition.table === "Final metadata errors" ||
          definition.table === "MCP and review errors"
          ? "submission"
          : "upload"
      );
      expect(definition.message.trim()).toBe(definition.message);
      expect(definition.message.endsWith("."), definition.code).toBe(true);
      // The page's links are dropped; its code spans and bold are kept.
      expect(definition.message).not.toMatch(/\]\(/);
      expect(definition.source).toEqual({
        url: "https://developers.openai.com/plugins/deploy/submission-errors",
        capturedOn: "2026-11-13",
      });
    }
    expect(OPENAI_PORTAL_CODES_SOURCE.capturedOn).toBe("2026-11-13");
  });

  it("marks the package warnings and the upload codes that ask for confirmation as warnings", () => {
    const warnings = OPENAI_PORTAL_CODES.filter(
      (definition) => definition.severity === "warning"
    ).map((definition) => definition.code);
    expect(warnings).toEqual([
      "plugin_version_unchanged",
      "mcp_configuration_excluded",
      "claude_format_normalized",
      "manifest_normalized",
      "developer_name_defaulted",
      "duplicate_app_reference",
      "undeclared_app_manifest_ignored",
      "undeclared_mcp_manifest_ignored",
      "skill_file_ignored",
      "skill_symlink_ignored",
      "skill_frontmatter_adjusted",
      "skill_metadata_ignored",
    ]);
  });

  it("copies messages word for word", () => {
    expect(OPENAI_PORTAL_CODES_BY_CODE.developer_name_defaulted.message).toBe(
      "The listing’s developer name is set automatically from your selected verified developer identity, regardless of the name in your ZIP."
    );
    expect(OPENAI_PORTAL_CODES_BY_CODE.mcp_configuration_excluded.message).toBe(
      "MCP configuration is excluded unless your organization is approved for local MCP submissions. For a local MCP plugin, ask your OpenAI representative to confirm the submitting organization is allowlisted. Submit remote MCP servers through **With MCP**."
    );
    expect(
      OPENAI_PORTAL_CODES_BY_CODE.declared_asset_path_has_control_character
        .message
    ).toBe(
      "The named asset field must not contain characters U+0000–U+001F or U+007F."
    );
  });

  it("shares the parser's codes and words rather than restating them", () => {
    for (const [code, rule] of Object.entries(PLUGIN_PORTAL_RULES)) {
      expect(OPENAI_PORTAL_CODES_BY_CODE[code]).toMatchObject({
        table: rule.table,
        message: rule.message,
      });
    }
  });
});

describe("what each code is about", () => {
  // These name their field in words: "Display name", "Starter prompts".
  const NAMED_IN_WORDS = new Set([
    "submission_display_name_required",
    "submission_display_name_too_long",
    "submission_display_name_character_unsupported",
    "submission_subtitle_required",
    "submission_subtitle_too_long",
    "submission_subtitle_character_unsupported",
    "submission_description_required",
    "submission_description_too_long",
    "submission_description_character_unsupported",
    "submission_developer_name_required",
    "submission_developer_name_too_long",
    "submission_developer_name_character_unsupported",
    "plugin_capability_invalid",
    "plugin_default_prompt_mention",
    "plugin_default_prompt_duplicate",
    "plugin_name_mismatch",
    "developer_name_defaulted",
    "mcp_server_name_empty",
    // "Each server entry": a value of `apps`, as the table's note puts it.
    "app_entry_wrong_type",
  ]);

  it("names a field the message names, in a document", () => {
    const withField = OPENAI_PORTAL_CODES.filter((row) => row.field);
    expect(withField.length).toBeGreaterThan(150);
    for (const { code, field = "", document, message } of withField) {
      expect(document, code).toBeDefined();
      if (NAMED_IN_WORDS.has(code)) continue;
      const base = field.replace(/\[\]/g, "").replace(/\.\*/g, "");
      expect(
        tokensOf(message).some(
          (token) =>
            base === token ||
            base.endsWith(`.${token}`) ||
            base.startsWith(`${token}.`) ||
            token.startsWith(`${base}.`)
        ),
        `${code}: ${field}`
      ).toBe(true);
    }
  });

  it("names a file the message names", () => {
    const withPath = OPENAI_PORTAL_CODES.filter((row) => row.path);
    expect(withPath.length).toBeGreaterThan(30);
    for (const { code, path = "", message } of withPath) {
      expect(
        tokensOf(message).some((token) => path.endsWith(token)),
        `${code}: ${path}`
      ).toBe(true);
    }
  });

  it("states every length and count limit its message states", () => {
    // The listing URLs' limits are in the table's note, not their messages.
    const NOTED =
      /^plugin_(website|privacy_policy|terms_of_service|support)_url_too_long$/;
    for (const { code, message, rules = [] } of OPENAI_PORTAL_CODES) {
      for (const rule of rules) {
        if (rule.kind !== "length" && rule.kind !== "count") continue;
        if (NOTED.test(code)) {
          expect(rule).toEqual({
            kind: "length",
            max: 2048,
            submissionMax: 1024,
          });
          continue;
        }
        if (code === "plugin_default_prompt_too_many") {
          expect(message).toContain("at most three prompts");
          expect(rule).toEqual({ kind: "count", max: 3 });
          continue;
        }
        expect(message, code).toContain(rule.max.toLocaleString("en-US"));
        if (rule.kind === "length" && rule.submissionMax !== undefined) {
          expect(message, code).toContain(
            rule.submissionMax.toLocaleString("en-US")
          );
        }
      }
    }
  });

  it("lists the categories plugin_category_unknown names, in its order", () => {
    const message = OPENAI_PORTAL_CODES_BY_CODE.plugin_category_unknown.message;
    expect(tokensOf(message).slice(1)).toEqual([
      ...OPENAI_PORTAL_LISTING_CATEGORIES,
    ]);
  });
});

describe("the codes as catalog entries", () => {
  it("can be raised by code, blocking unless the page says warning", () => {
    for (const definition of OPENAI_PORTAL_CODES) {
      const entry = OPENAI_PORTAL_ERRORS_BY_ID[definition.code];
      expect(entry, definition.code).toBeDefined();
      expect(entry.message).toBe(definition.message);
      expect(entry.severity).toBe(
        definition.severity === "warning" ? "advisory" : "blocking"
      );
      expect(entry.source).toMatchObject({
        page: "deploy/submission-errors",
        section: `§${definition.table}`,
        snapshotDate: "2026-11-13",
      });
    }
  });

  it("groups them under the package lane's findings", () => {
    const category = (code: string) =>
      OPENAI_PORTAL_ERRORS_BY_ID[code].category;
    expect(category("plugin_root_has_siblings")).toBe("package-archive");
    expect(category("archive_member_path_too_deep")).toBe("package-archive");
    expect(category("plugin_manifest_missing")).toBe("package-manifest");
    expect(category("plugin_display_name_too_long")).toBe("package-manifest");
    expect(category("skill_agent_yaml_malformed")).toBe("package-skills");
    expect(category("skill_file_ignored")).toBe("package-skills");
    expect(category("svg_dimensions_not_square")).toBe("package-assets");
    expect(category("app_configuration_excluded")).toBe("exclusions");
    expect(category("submission_subtitle_too_long")).toBe("listing-fields");
    expect(category("scan_required")).toBe("mcp-server");
  });
});
