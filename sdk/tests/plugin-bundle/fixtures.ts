/**
 * In-memory `PluginFileSource` fixtures for the plugin-bundle parser tests.
 * Fixture bundles are plain path→content records; attack fixtures can
 * override the listed entries (link kinds, lying sizes) independently of the
 * stored content, mirroring what a hostile archive can declare.
 */

import { expect } from "vitest";
import {
  PluginBundleError,
  parsePluginBundle,
  type ParsePluginBundleOptions,
  type PluginFileEntry,
  type PluginFileSource,
  type PluginIssueCode,
} from "../../src/plugin-bundle/index.js";

const encoder = new TextEncoder();

export function encode(text: string): Uint8Array {
  return encoder.encode(text);
}

export class InMemoryPluginFileSource implements PluginFileSource {
  /** Paths handed to readText/readBytes, in order — used to assert that
   * malicious bundles fail before any content is read. */
  readonly reads: string[] = [];

  private readonly files = new Map<string, Uint8Array>();
  private readonly entryOverrides?: PluginFileEntry[];

  constructor(
    files: Record<string, string | Uint8Array>,
    options?: { entries?: PluginFileEntry[] }
  ) {
    for (const [path, content] of Object.entries(files)) {
      this.files.set(
        path,
        typeof content === "string" ? encode(content) : content
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

  async readBytes(path: string, maxBytes: number): Promise<Uint8Array> {
    this.reads.push(path);
    const bytes = this.files.get(path);
    if (bytes === undefined) throw new Error(`no such file: ${path}`);
    if (bytes.byteLength > maxBytes) {
      throw new Error(`entry exceeds maxBytes (${maxBytes}): ${path}`);
    }
    return bytes;
  }

  async readText(path: string, maxBytes: number): Promise<string> {
    const bytes = await this.readBytes(path, maxBytes);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
}

export function manifestJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "demo-plugin",
    version: "1.2.3",
    description: "A demo plugin for parser tests.",
    ...overrides,
  });
}

export function bundle(
  files: Record<string, string | Uint8Array>,
  options?: { entries?: PluginFileEntry[] }
): InMemoryPluginFileSource {
  return new InMemoryPluginFileSource(files, options);
}

/** Minimal valid bundle: manifest only, plus any extra files. */
export function minimalBundle(
  extra: Record<string, string | Uint8Array> = {},
  manifestOverrides: Record<string, unknown> = {}
): InMemoryPluginFileSource {
  return bundle({
    ".codex-plugin/plugin.json": manifestJson(manifestOverrides),
    ...extra,
  });
}

export const SKILL_MD = [
  "---",
  "name: demo-skill",
  "description: Does demo things for tests.",
  "---",
  "",
  "Use this skill to demo the parser.",
  "",
].join("\n");

export function skillMd(name: string, description = "A test skill."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\nInstructions for ${name}.\n`;
}

export const MCP_JSON_DIRECT = JSON.stringify({
  "demo-server": {
    url: "https://mcp.example.com/mcp",
    headers: { Authorization: "${DEMO_TOKEN}" },
  },
});

export const MCP_JSON_STDIO = JSON.stringify({
  mcp_servers: {
    "local-server": {
      command: "node",
      args: ["${PLUGIN_ROOT}/server/index.js"],
      env: { DEMO_API_KEY: "${DEMO_API_KEY}" },
    },
  },
});

/** Tiny valid PNG header + filler so magic-byte sniffing sees a real PNG. */
export const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

/** Parse and expect a `PluginBundleError` carrying `code` at error severity. */
export async function expectParseError(
  source: PluginFileSource,
  code: PluginIssueCode,
  options?: ParsePluginBundleOptions
): Promise<PluginBundleError> {
  const outcome = await parsePluginBundle(source, options).then(
    () => null,
    (error: unknown) => error
  );
  expect(outcome).toBeInstanceOf(PluginBundleError);
  const bundleError = outcome as PluginBundleError;
  expect(
    bundleError.issues.map((issue) => `${issue.severity}:${issue.code}`)
  ).toContain(`error:${code}`);
  return bundleError;
}
