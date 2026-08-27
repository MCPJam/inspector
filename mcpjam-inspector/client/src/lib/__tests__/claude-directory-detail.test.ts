import { describe, it, expect } from "vitest";
import { parseDirectoryServerDetail } from "../claude-directory-detail";

/**
 * The parser reads a `.passthrough()` capture of Anthropic's directory BFF:
 * only four fields are contractual upstream, so these tests exercise the two
 * postures that matter — a rich real-shaped row parses fully, and every
 * malformed or hostile variant degrades to omission, never to a throw or a
 * dangerous value.
 */

/** A trimmed copy of the real Asana row's shape (2026-08 snapshot). */
const richRow = {
  id: "41aefcf3-a829-45eb-8cee-d90b93912f57",
  type: "remote",
  name: "Asana",
  display_name: "Asana",
  description: "Access Asana's Work Graph directly from Claude.",
  one_liner: "Connect to Asana to coordinate tasks, projects, and goals",
  author: { name: "Asana", url: "https://asana.com" },
  categories: ["productivity", "communication"],
  tool_names: ["get_task", "search_tasks_preview", "update_task"],
  prompt_names: ["weekly_report"],
  permissions: "Read and write",
  sensitive_data_types: ["tasks", "comments"],
  documentation: "https://developers.asana.com/docs/mcp-server",
  support: "https://help.asana.com/",
  privacy_policy: "https://asana.com/terms",
  directory_url: "https://claude.ai/directory/41aefcf3",
  html_content: "<p>rich text</p>",
  remote: {
    url: "https://mcp.asana.com/v2/mcp",
    transport: "streamable-http",
    is_authless: false,
    auth_posture: "auth_required",
    required_fields: [
      { field: "api_key", source_url: "https://asana.com/settings" },
    ],
  },
};

describe("parseDirectoryServerDetail", () => {
  it("parses a real-shaped row completely", () => {
    const detail = parseDirectoryServerDetail(JSON.stringify(richRow));
    expect(detail).toEqual({
      description: "Access Asana's Work Graph directly from Claude.",
      authorName: "Asana",
      authorUrl: "https://asana.com",
      categories: ["productivity", "communication"],
      toolNames: ["get_task", "search_tasks_preview", "update_task"],
      promptNames: ["weekly_report"],
      permissions: "Read and write",
      sensitiveDataTypes: ["tasks", "comments"],
      links: [
        {
          label: "Documentation",
          url: "https://developers.asana.com/docs/mcp-server",
        },
        { label: "Support", url: "https://help.asana.com/" },
        { label: "Privacy policy", url: "https://asana.com/terms" },
        {
          label: "View in Claude directory",
          url: "https://claude.ai/directory/41aefcf3",
        },
      ],
      authPosture: "auth_required",
      requiredFields: [
        { field: "api_key", sourceUrl: "https://asana.com/settings" },
      ],
    });
  });

  it("returns empty collections and no strings for a minimal row", () => {
    const detail = parseDirectoryServerDetail(
      JSON.stringify({ id: "x", type: "remote", name: "Bare" })
    );
    expect(detail).toEqual({
      description: undefined,
      authorName: undefined,
      authorUrl: undefined,
      categories: [],
      toolNames: [],
      promptNames: [],
      permissions: undefined,
      sensitiveDataTypes: [],
      links: [],
      authPosture: undefined,
      requiredFields: [],
    });
  });

  it("drops non-https link values instead of rendering them", () => {
    const detail = parseDirectoryServerDetail(
      JSON.stringify({
        documentation: "http://insecure.example/docs",
        support: "javascript:alert(1)",
        privacy_policy: "not a url",
        author: { name: "Acme", url: "ftp://acme.example" },
      })
    );
    expect(detail?.links).toEqual([]);
    expect(detail?.authorName).toBe("Acme");
    expect(detail?.authorUrl).toBeUndefined();
  });

  it("keeps only string entries of upstream arrays", () => {
    const detail = parseDirectoryServerDetail(
      JSON.stringify({
        tool_names: ["real_tool", 42, null, { name: "nope" }, ""],
        categories: "productivity",
      })
    );
    expect(detail?.toolNames).toEqual(["real_tool"]);
    expect(detail?.categories).toEqual([]);
  });

  it("skips required_fields entries without a field name", () => {
    const detail = parseDirectoryServerDetail(
      JSON.stringify({
        remote: {
          required_fields: [
            { source_url: "https://acme.example" },
            "api_key",
            { field: "workspace_id", source_url: "http://insecure.example" },
          ],
        },
      })
    );
    expect(detail?.requiredFields).toEqual([
      { field: "workspace_id", sourceUrl: undefined },
    ]);
  });

  it.each([
    ["null input", null],
    ["undefined input", undefined],
    ["empty string", ""],
    ["broken JSON", "{not json"],
    ["a JSON array", "[1,2]"],
    ["a JSON scalar", '"just text"'],
  ])("returns null for %s", (_label, input) => {
    expect(parseDirectoryServerDetail(input as string | null)).toBeNull();
  });

  it("tolerates non-object author and remote", () => {
    const detail = parseDirectoryServerDetail(
      JSON.stringify({ author: "Asana", remote: "https://mcp.example" })
    );
    expect(detail?.authorName).toBeUndefined();
    expect(detail?.authPosture).toBeUndefined();
    expect(detail?.requiredFields).toEqual([]);
  });
});
