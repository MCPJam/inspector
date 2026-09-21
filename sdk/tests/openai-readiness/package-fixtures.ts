/**
 * In-memory package fixtures for the OpenAI plugin-package reader.
 *
 * Mirrors `tests/plugin-bundle/fixtures.ts` in shape, and differs from it in
 * the one way that matters here: this source can be handed RAW entry names that
 * differ from the paths it stores content under. That is not a curiosity — it
 * is the whole point of the reader's raw-name pass. A ZIP's central directory
 * can record `skills\weather\SKILL.md` while the extracted file lives at
 * `skills/weather/SKILL.md`, and a fixture that could not express the
 * difference could not test the rule.
 */

import type {
  PluginFileEntry,
  PluginFileSource,
} from "../../src/plugin-bundle/types.js";
import type { OpenAIArchiveObservations } from "../../src/openai-readiness/package/reader.js";

const encoder = new TextEncoder();

export function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

export class InMemoryOpenAIPackageSource implements PluginFileSource {
  /** Paths handed to `readBytes`, in order. */
  readonly reads: string[] = [];

  private readonly files = new Map<string, Uint8Array>();
  private readonly entryOverrides?: PluginFileEntry[];

  constructor(
    files: Record<string, string | Uint8Array>,
    options?: { entries?: PluginFileEntry[] },
  ) {
    for (const [path, content] of Object.entries(files)) {
      this.files.set(
        path,
        typeof content === "string" ? encode(content) : content,
      );
    }
    this.entryOverrides = options?.entries;
  }

  async list(): Promise<PluginFileEntry[]> {
    if (this.entryOverrides !== undefined) return [...this.entryOverrides];
    return [...this.files.entries()].map(([path, bytes]) => ({
      path,
      size: bytes.byteLength,
    }));
  }

  async readBytes(path: string, _maxBytes: number): Promise<Uint8Array> {
    this.reads.push(path);
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`no such entry: ${path}`);
    return bytes;
  }
}

export const CANONICAL_MANIFEST_PATH = ".codex-plugin/plugin.json";

export function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    { name: "weather", version: "1.0.0", description: "Weather", ...overrides },
    null,
    2,
  );
}

export function skillMarkdown(
  frontmatter: Record<string, string> = {},
  body = "Steps to follow.",
): string {
  const fields = {
    name: "forecast",
    description: "Look up a forecast for a city",
    ...frontmatter,
  };
  const lines = Object.entries(fields).map(
    ([key, value]) => `${key}: ${value}`,
  );
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

export function openaiYaml(
  overrides: { interface?: Record<string, string> } = {},
): string {
  const fields = {
    display_name: "Weather",
    short_description: "Forecasts for any city",
    brand_color: '"#767676"',
    ...overrides.interface,
  };
  return [
    "interface:",
    ...Object.entries(fields).map(([key, value]) => `  ${key}: ${value}`),
    "policy:",
    "  products:",
    "    - chatgpt",
  ].join("\n");
}

/** A minimal square PNG, built byte-by-byte so no binary is checked in. */
export function squarePng(edge: number): Uint8Array {
  const out = new Uint8Array(24);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(out.buffer);
  view.setUint32(8, 13);
  out.set(encode("IHDR"), 12);
  view.setUint32(16, edge);
  view.setUint32(20, edge);
  return out;
}

export function nonSquarePng(width: number, height: number): Uint8Array {
  const out = squarePng(width);
  new DataView(out.buffer).setUint32(20, height);
  return out;
}

/** A well-formed skills-only package that should read cleanly. */
export function cleanSkillsPackage(): Record<string, string | Uint8Array> {
  return {
    [CANONICAL_MANIFEST_PATH]: manifestJson(),
    "agents/openai.yaml": openaiYaml(),
    "skills/forecast/SKILL.md": skillMarkdown(),
    "assets/icon.png": squarePng(512),
  };
}

/** Archive observations for a source that really was a ZIP. */
export function archiveObservations(
  overrides: Partial<OpenAIArchiveObservations> = {},
): OpenAIArchiveObservations {
  return {
    compressedBytes: 4_096,
    encryptedEntryPaths: [],
    rawEntryNames: Object.keys(cleanSkillsPackage()),
    ...overrides,
  };
}
