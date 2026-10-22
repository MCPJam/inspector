/**
 * Compatibility-profile fixtures: OpenAI/Codex and Claude package layouts.
 *
 * The Bits & Bolts manifest is copied verbatim from
 * openai/mcp-extensions@0d606217705e0e71eb21fff009619b67b80611dc
 * (plugins/bits-and-bolts/.codex-plugin/plugin.json), the pinned source the
 * extension qualification runs against.
 */

import { encode, manifestJson } from "./fixtures.js";

export const SVG_BYTES = encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M0 0h20v20H0z"/></svg>'
);

export const BITS_AND_BOLTS_CODEX_MANIFEST = {
  name: "bits-and-bolts",
  version: "0.1.11",
  description: "Browse, import, inspect, and pick reusable CAD parts in Codex.",
  author: { name: "OpenAI" },
  skills: "./skills/",
  extensions: {
    "com.openai": { onboardingSkill: "./skills/onboarding/SKILL.md" },
  },
  mcpServers: "./.mcp.json",
  interface: {
    displayName: "Bits & Bolts",
    shortDescription: "Browse, inspect, and pick CAD parts",
    longDescription:
      "Import reusable CAD parts, inspect STL, 3MF, STEP, and STP files in an interactive Three.js viewer, reorient printable STL models, and explicitly pick a model from rendered previews.",
    developerName: "OpenAI",
    category: "Developer Tools",
    capabilities: ["Interactive", "Read", "Write"],
    composerIcon: "./assets/icon.svg",
    logo: "./assets/icon.svg",
    defaultPrompt: ["@Bits & Bolts open the Parts Library."],
    logoDark: "./assets/icon-dark.svg",
  },
};

/** The pinned local (stdio) Bits & Bolts package, as Codex installs it. */
export function bitsAndBoltsCodexFiles(): Record<string, string | Uint8Array> {
  return {
    ".codex-plugin/plugin.json": JSON.stringify(BITS_AND_BOLTS_CODEX_MANIFEST),
    ".mcp.json": JSON.stringify({
      mcpServers: {
        "bits-and-bolts": {
          command: "node",
          args: ["./dist/server.js"],
          cwd: ".",
        },
      },
    }),
    "assets/icon.svg": SVG_BYTES,
    "assets/icon-dark.svg": SVG_BYTES,
    "skills/bits-and-bolts/SKILL.md":
      "---\nname: bits-and-bolts\ndescription: Browse and pick CAD parts.\n---\n\nUse the parts library.\n",
    "skills/onboarding/SKILL.md":
      "---\nname: onboarding\ndescription: Set up Bits & Bolts.\n---\n\nWalk the user through setup.\n",
    "dist/server.js": "console.log('server');\n",
  };
}

/** A Claude Code plugin: `.claude-plugin/plugin.json` and root `.mcp.json`. */
export function claudePluginFiles(): Record<string, string | Uint8Array> {
  return {
    ".claude-plugin/plugin.json": JSON.stringify({
      name: "db-tools",
      version: "2.0.0",
      description: "Database helpers.",
      author: { name: "Example" },
      commands: "./commands/",
      hooks: "./hooks/hooks.json",
    }),
    "skills/query/SKILL.md":
      "---\nname: query\ndescription: Query the database.\n---\n\nRun queries.\n",
  };
}

/** A portable package that keeps a Codex overlay beside its root manifest. */
export function portableWithOverlayFiles(
  rootOverrides: Record<string, unknown> = {}
): Record<string, string | Uint8Array> {
  return {
    "plugin.json": manifestJson({ name: "bits-and-bolts", ...rootOverrides }),
    ".codex-plugin/plugin.json": JSON.stringify(BITS_AND_BOLTS_CODEX_MANIFEST),
    "assets/icon.svg": SVG_BYTES,
    "assets/icon-dark.svg": SVG_BYTES,
    "skills/onboarding/SKILL.md":
      "---\nname: onboarding\ndescription: Set up Bits & Bolts.\n---\n\nWalk the user through setup.\n",
  };
}

/**
 * A remote Codex package in the shape the installed Bits & Bolts Remote uses:
 * an `http` server with OpenAI auth and a keyed `.app.json`. Constructed from
 * OpenAI's documented formats, not copied from the installed package bytes.
 */
export function bitsAndBoltsRemoteFiles(
  auth: Record<string, unknown> = { type: "oauth" }
): Record<string, string | Uint8Array> {
  const { mcpServers: _local, ...manifest } = BITS_AND_BOLTS_CODEX_MANIFEST;
  return {
    ".codex-plugin/plugin.json": JSON.stringify({
      ...manifest,
      version: "1.0.23",
      mcpServers: "./.mcp.json",
      apps: "./.app.json",
    }),
    ".mcp.json": JSON.stringify({
      mcpServers: {
        "bits-and-bolts": {
          type: "http",
          url: "https://bits-and-bolts.example.com/bits-and-bolts/mcp",
          extensions: { "com.openai": { auth } },
        },
      },
    }),
    ".app.json": JSON.stringify({
      apps: { "bits-and-bolts": { id: "plugin_asdk_app_bitsandbolts" } },
    }),
    "assets/icon.svg": SVG_BYTES,
    "assets/icon-dark.svg": SVG_BYTES,
    "skills/onboarding/SKILL.md":
      "---\nname: onboarding\ndescription: Set up Bits & Bolts.\n---\n\nWalk the user through setup.\n",
  };
}
