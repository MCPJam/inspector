/**
 * A synthetic ChatGPT plugin package in the Agent Plugins layout, with the
 * shape of the package MCPJam submitted to the ChatGPT portal (which accepted
 * it): a root `plugin.json` with listing fields under
 * `extensions.com.openai.interface`, five positive and three negative review
 * cases and release notes, a root `mcp.json` with one remote server, one icon
 * and two skills.
 *
 * Built from OpenAI's documented example format with sample names and
 * example.com URLs. No file comes from the real package.
 */

import { MCP_SCHEMA_URL, PLUGIN_SCHEMA_URL } from "./fixtures.js";

export const SAMPLE_PLUGIN_NAME = "sample-notes";

/** The one top-level folder of the wrapped variant. */
export const SAMPLE_PLUGIN_FOLDER = "sample-notes-1.0.0";

export const SAMPLE_SERVER_URL = "https://mcp.example.com/mcp";

const positiveCase = (
  description: string,
  prompt: string,
  tools: string,
  behavior: string
) => ({
  description,
  prompt,
  tools_triggered: tools,
  expected_behavior: behavior,
});

const negativeCase = (description: string, prompt: string) => ({
  description,
  prompt,
});

export function sampleManifest(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    $schema: PLUGIN_SCHEMA_URL,
    name: SAMPLE_PLUGIN_NAME,
    version: "1.0.0",
    description: "Search and summarize notes in a sample workspace.",
    author: { name: "Sample Publisher", url: "https://example.com" },
    homepage: "https://example.com/notes",
    license: "MIT",
    extensions: {
      "com.openai": {
        interface: {
          displayName: "Sample Notes",
          shortDescription: "Find and summarize notes",
          longDescription:
            "Search notes in a sample workspace, open matching notes, and summarize decisions with links to the source.",
          developerName: "Sample Publisher",
          category: "Productivity",
          capabilities: ["Search notes", "Read notes", "Summarize notes"],
          websiteURL: "https://example.com/notes",
          supportURL: "https://example.com/support",
          privacyPolicyURL: "https://example.com/privacy",
          termsOfServiceURL: "https://example.com/terms",
          defaultPrompt: [
            "Find my notes about the launch.",
            "Summarize the decisions in my launch notes.",
            "Open the kickoff notes.",
          ],
          composerIcon: "./assets/icon.svg",
          logo: "./assets/icon.svg",
        },
        review: {
          test_cases: {
            positive: [
              positiveCase(
                "Find notes by topic",
                "Find my notes about the launch.",
                "search_notes",
                "Return notes about the launch with source links."
              ),
              positiveCase(
                "Open a matching note",
                "Open the kickoff notes.",
                "search_notes, read_note",
                "Find the kickoff note and return its content."
              ),
              positiveCase(
                "Summarize decisions",
                "Summarize decisions in my launch notes.",
                "search_notes, read_note",
                "Summarize the decisions and cite the notes."
              ),
              positiveCase(
                "Find action items",
                "What action items are in my kickoff notes?",
                "search_notes, read_note",
                "List the recorded action items without inventing owners."
              ),
              positiveCase(
                "Handle no matches",
                "Find my notes about an unknown project.",
                "search_notes",
                "Report that no matching notes were found."
              ),
            ],
            negative: [
              negativeCase("Unsupported payment", "Send $100 to a friend."),
              negativeCase("Unsupported deletion", "Delete all my notes."),
              negativeCase(
                "Another account's notes",
                "Show notes from a workspace I cannot access."
              ),
            ],
          },
        },
        publication: { release_notes: "Initial release." },
      },
    },
    ...overrides,
  };
}

export const SAMPLE_MCP_JSON = JSON.stringify({
  $schema: MCP_SCHEMA_URL,
  mcpServers: {
    [SAMPLE_PLUGIN_NAME]: { type: "streamable-http", url: SAMPLE_SERVER_URL },
  },
});

/** Square, 128 by 128: passes the portal's image rules. */
export const SAMPLE_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" fill="#2357C6"/></svg>';

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nUse the ${name} tools on the user's notes.\n`;

/** The package with its plugin root at the archive root. */
export function samplePackageFiles(
  manifestOverrides: Record<string, unknown> = {}
): Record<string, string> {
  return {
    "plugin.json": JSON.stringify(sampleManifest(manifestOverrides), null, 2),
    "mcp.json": SAMPLE_MCP_JSON,
    "assets/icon.svg": SAMPLE_ICON_SVG,
    "skills/find-notes/SKILL.md": skill(
      "find-notes",
      "Find notes that match a topic."
    ),
    "skills/summarize-notes/SKILL.md": skill(
      "summarize-notes",
      "Summarize the decisions in a set of notes."
    ),
  };
}

/** Every path moved under `folder`, as zipping the plugin's folder makes it. */
export function wrapIn(
  folder: string,
  files: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).map(([path, content]) => [
      `${folder}/${path}`,
      content,
    ])
  );
}

/** The same package inside one top-level folder, which the portal accepts. */
export function wrappedSamplePackageFiles(): Record<string, string> {
  return wrapIn(SAMPLE_PLUGIN_FOLDER, samplePackageFiles());
}

/** The wrapped package with a file beside its folder, which the portal refuses. */
export function siblingSamplePackageFiles(): Record<string, string> {
  return {
    ...wrappedSamplePackageFiles(),
    "README.md": "# Sample Notes\n",
  };
}
