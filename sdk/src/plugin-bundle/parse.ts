/**
 * `parsePluginBundle` — the source-adapter-independent plugin parser.
 *
 * Phase order is a security contract, not a convenience: entry paths are
 * validated against the archive reject-list and limits FIRST, and any
 * violation throws before a single byte of content is read or any component
 * (manifest/skill/MCP/app) is normalized.
 */

import { parsePluginAppConfig, type ParsedPluginApp } from "./app-config.js";
import {
  computeAggregateHash,
  hashCanonicalJson,
  sha256HexBytes,
} from "./hashes.js";
import {
  normalizePluginManifest,
  PLUGIN_MANIFEST_PATH,
  type NormalizedPluginManifest,
} from "./manifest.js";
import {
  normalizePluginMcpConfig,
  type ParsedPluginServer,
} from "./mcp-config.js";
import {
  isPathInside,
  validateBundleEntries,
  type NormalizedBundleEntry,
} from "./paths.js";
import {
  parsePluginSkill,
  SKILL_FILE_NAME,
  SKILL_OPENAI_METADATA_PATH,
  SKILLS_DIR,
  type ParsedPluginSkill,
} from "./skill.js";
import {
  DEFAULT_PLUGIN_BUNDLE_LIMITS,
  type ParsedPluginAsset,
  type ParsedPluginBundle,
  type ParsedUnsupportedComponent,
  type ParsePluginBundleOptions,
  type PluginAssetKind,
  type PluginBundleLimits,
  type PluginFileSource,
  type PluginSetupRequirement,
  type PluginUnsupportedComponentKind,
} from "./types.js";
import { PluginBundleError, PluginIssueCollector } from "./validation.js";

export const MCP_CONFIG_PATH = ".mcp.json";
export const APP_CONFIG_SUFFIX = ".app.json";
export const ASSETS_DIR = "assets";

/** Top-level directories preserved but not executable in V1. */
const UNSUPPORTED_DIRS: Record<string, PluginUnsupportedComponentKind> = {
  hooks: "hooks",
  extensions: "browser-extension",
  "browser-extensions": "browser-extension",
  tasks: "scheduled-task",
};

const UNSUPPORTED_MANIFEST_FIELD_KINDS: Record<
  string,
  PluginUnsupportedComponentKind
> = {
  hooks: "hooks",
  extensions: "browser-extension",
  browser_extensions: "browser-extension",
  scheduled_tasks: "scheduled-task",
  tasks: "scheduled-task",
  commands: "other",
};

const ASSET_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  ico: "image/x-icon",
  bmp: "image/bmp",
  pdf: "application/pdf",
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  yaml: "application/x-yaml",
  yml: "application/x-yaml",
};

interface LoadedFile extends NormalizedBundleEntry {
  bytes: Uint8Array;
  contentHash: string;
}

function fileExtension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function contentTypeForPath(path: string): string {
  return ASSET_CONTENT_TYPES[fileExtension(path)] ?? "application/octet-stream";
}

/** Magic-byte sniff for the image formats we accept as presentation assets. */
function sniffImageFormat(
  bytes: Uint8Array
): "png" | "jpeg" | "gif" | "webp" | "svg" | null {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "jpeg";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "webp";
  }
  try {
    const head = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.slice(0, 512)
    );
    if (head.includes("<svg")) return "svg";
  } catch {
    // Not text — fall through.
  }
  return null;
}

const IMAGE_EXTENSION_FORMAT: Record<string, string> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  gif: "gif",
  webp: "webp",
  svg: "svg",
};

function decodeUtf8(
  file: LoadedFile,
  issues: PluginIssueCollector
): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    issues.error("FILE_INVALID_UTF8", "file is not valid UTF-8 text", {
      path: file.path,
    });
    return null;
  }
}

function parseJsonFile(
  file: LoadedFile,
  issues: PluginIssueCollector,
  invalidJsonCode:
    | "MANIFEST_INVALID_JSON"
    | "MCP_INVALID_CONFIG"
    | "APP_INVALID_CONFIG"
): unknown | null {
  const text = decodeUtf8(file, issues);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    issues.error(invalidJsonCode, "file is not valid JSON", {
      path: file.path,
    });
    return null;
  }
  if (parsed === null) {
    issues.error(invalidJsonCode, "file must contain a JSON object", {
      path: file.path,
    });
    return null;
  }
  return parsed;
}

/**
 * Parse and validate a plugin bundle from an abstract file source.
 *
 * Throws `PluginBundleError` (carrying every collected issue) on any
 * error-severity finding; warning-severity issues are returned on the result.
 */
export async function parsePluginBundle(
  source: PluginFileSource,
  options?: ParsePluginBundleOptions
): Promise<ParsedPluginBundle> {
  const limits: PluginBundleLimits = {
    ...DEFAULT_PLUGIN_BUNDLE_LIMITS,
    ...options?.limits,
  };
  const issues = new PluginIssueCollector();

  // Phase 1 — archive/path safety. Must fail before any content read.
  const entries = await source.list();
  const validated = validateBundleEntries(entries, limits, issues);
  issues.throwIfErrors();
  if (validated.length === 0) {
    issues.error("BUNDLE_EMPTY", "bundle contains no files");
    issues.throwIfErrors();
  }

  // Phase 2 — load content and compute deterministic hashes.
  const files: LoadedFile[] = [];
  const byPath = new Map<string, LoadedFile>();
  for (const entry of validated) {
    let bytes: Uint8Array;
    try {
      bytes = await source.readBytes(entry.sourcePath, limits.maxFileBytes);
    } catch (error) {
      issues.error(
        "FILE_UNREADABLE",
        `file could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { path: entry.path }
      );
      continue;
    }
    if (bytes.byteLength > limits.maxFileBytes) {
      issues.error(
        "FILE_TOO_LARGE",
        `file exceeds the per-file limit of ${limits.maxFileBytes} bytes`,
        { path: entry.path }
      );
      continue;
    }
    if (bytes.byteLength !== entry.size) {
      issues.error(
        "FILE_SIZE_MISMATCH",
        `declared size ${entry.size} does not match actual size ${bytes.byteLength}`,
        { path: entry.path }
      );
      continue;
    }
    const loaded: LoadedFile = {
      ...entry,
      bytes,
      contentHash: await sha256HexBytes(bytes),
    };
    files.push(loaded);
    byPath.set(loaded.path, loaded);
  }
  issues.throwIfErrors();

  const bundleHash = await computeAggregateHash(
    files.map((file) => ({ path: file.path, contentHash: file.contentHash }))
  );

  // Phase 3 — manifest: `.codex-plugin/plugin.json` exists exactly once.
  const manifestFile = byPath.get(PLUGIN_MANIFEST_PATH);
  const strayManifests = files.filter(
    (file) =>
      file.path !== PLUGIN_MANIFEST_PATH &&
      file.path.endsWith(`/${PLUGIN_MANIFEST_PATH}`)
  );
  if (manifestFile === undefined) {
    issues.error(
      "MANIFEST_MISSING",
      `bundle is missing "${PLUGIN_MANIFEST_PATH}" at its root`
    );
    throw new PluginBundleError(issues.issues());
  }
  for (const stray of strayManifests) {
    issues.error(
      "MANIFEST_DUPLICATE",
      `"${PLUGIN_MANIFEST_PATH}" must exist exactly once; found another at "${stray.path}"`,
      { path: stray.path }
    );
  }
  const manifestHash = manifestFile.contentHash;
  const manifestRaw = parseJsonFile(
    manifestFile,
    issues,
    "MANIFEST_INVALID_JSON"
  );
  const filePaths: ReadonlySet<string> = new Set(byPath.keys());
  const { manifest, unsupportedFields } =
    manifestRaw === null
      ? { manifest: null, unsupportedFields: [] as string[] }
      : normalizePluginManifest(manifestRaw, { filePaths, issues });
  if (manifest === null) {
    throw new PluginBundleError(issues.issues());
  }
  issues.throwIfErrors();

  // Phase 4 — skills.
  const skillDirNames: string[] = [];
  for (const file of files) {
    if (!file.path.startsWith(`${SKILLS_DIR}/`)) continue;
    const segments = file.path.slice(SKILLS_DIR.length + 1).split("/");
    if (
      segments.length === 2 &&
      segments[1] === SKILL_FILE_NAME &&
      !skillDirNames.includes(segments[0])
    ) {
      skillDirNames.push(segments[0]);
    }
  }
  skillDirNames.sort();
  if (skillDirNames.length > limits.maxSkills) {
    issues.error(
      "SKILL_TOO_MANY",
      `bundle declares ${skillDirNames.length} skills; the limit is ${limits.maxSkills}`
    );
    issues.throwIfErrors();
  }

  const skills: ParsedPluginSkill[] = [];
  const seenSkillNames = new Map<string, string>();
  for (const directoryName of skillDirNames) {
    const directory = `${SKILLS_DIR}/${directoryName}`;
    const skillFilePath = `${directory}/${SKILL_FILE_NAME}`;
    const skillFile = byPath.get(skillFilePath);
    if (skillFile === undefined) continue; // unreachable; discovery found it
    const skillText = decodeUtf8(skillFile, issues);
    if (skillText === null) continue;

    const directoryFiles = files.filter((file) =>
      isPathInside(directory, file.path)
    );
    const openaiYamlPath = `${directory}/${SKILL_OPENAI_METADATA_PATH}`;
    const openaiYamlFile = byPath.get(openaiYamlPath);
    let openaiYaml: { path: string; text: string } | undefined;
    if (openaiYamlFile !== undefined) {
      const text = decodeUtf8(openaiYamlFile, issues);
      if (text !== null) openaiYaml = { path: openaiYamlPath, text };
    }

    const skill = await parsePluginSkill({
      pluginName: manifest.name,
      directory,
      directoryName,
      skillFilePath,
      skillText,
      skillContentHash: skillFile.contentHash,
      files: directoryFiles.map((file) => ({
        path: file.path,
        size: file.size,
        contentHash: file.contentHash,
      })),
      openaiYaml,
      issues,
    });
    if (skill === null) continue;

    const duplicateOf = seenSkillNames.get(skill.name);
    if (duplicateOf !== undefined) {
      issues.error(
        "SKILL_DUPLICATE_NAME",
        `skill name "${skill.name}" is declared by both "${duplicateOf}" and "${skill.directory}"`,
        { path: skill.skillFilePath, componentKey: skill.componentKey }
      );
      continue;
    }
    seenSkillNames.set(skill.name, skill.directory);
    skills.push(skill);
  }

  // Phase 5 — MCP servers.
  const mcpServers: ParsedPluginServer[] = [];
  const mcpFile = byPath.get(MCP_CONFIG_PATH);
  for (const file of files) {
    if (
      file.path !== MCP_CONFIG_PATH &&
      file.path.endsWith(`/${MCP_CONFIG_PATH}`) &&
      !isPathInside(SKILLS_DIR, file.path)
    ) {
      issues.warn(
        "MCP_CONFIG_IGNORED",
        `only the bundle root "${MCP_CONFIG_PATH}" is used; "${file.path}" is ignored`,
        { path: file.path }
      );
    }
  }
  if (mcpFile !== undefined) {
    const mcpRaw = parseJsonFile(mcpFile, issues, "MCP_INVALID_CONFIG");
    if (mcpRaw !== null) {
      const normalized = normalizePluginMcpConfig(mcpRaw, {
        sourcePath: MCP_CONFIG_PATH,
        issues,
      });
      if (normalized.length > limits.maxMcpServers) {
        issues.error(
          "MCP_TOO_MANY_SERVERS",
          `bundle declares ${normalized.length} MCP servers; the limit is ${limits.maxMcpServers}`,
          { path: MCP_CONFIG_PATH }
        );
      } else {
        for (const server of normalized) {
          mcpServers.push({
            ...server,
            configHash: await hashCanonicalJson(server.config),
          });
        }
      }
    }
  }

  // Phase 6 — app mappings.
  const apps: ParsedPluginApp[] = [];
  const serverKeys = mcpServers.map((server) => server.key);
  for (const file of files) {
    if (!file.path.endsWith(APP_CONFIG_SUFFIX)) continue;
    if (isPathInside(SKILLS_DIR, file.path)) continue; // skill supporting file
    const appRaw = parseJsonFile(file, issues, "APP_INVALID_CONFIG");
    if (appRaw === null) continue;
    const app = parsePluginAppConfig({
      sourcePath: file.path,
      raw: appRaw,
      serverKeys,
      contentHash: file.contentHash,
      issues,
    });
    if (app !== null) apps.push(app);
  }

  // Phase 7 — presentation assets.
  const assets: ParsedPluginAsset[] = [];
  const assetPaths = new Set<string>();
  const addAsset = (
    file: LoadedFile,
    kind: PluginAssetKind,
    declaredBy?: "icon" | "logo"
  ): void => {
    if (assetPaths.has(file.path)) return;
    assetPaths.add(file.path);
    const extension = fileExtension(file.path);
    const expectedFormat = IMAGE_EXTENSION_FORMAT[extension];
    if (declaredBy !== undefined && expectedFormat === undefined) {
      issues.error(
        "ASSET_UNSUPPORTED_TYPE",
        `manifest "${declaredBy}" must reference an image file`,
        { path: file.path }
      );
      return;
    }
    if (expectedFormat !== undefined) {
      const sniffed = sniffImageFormat(file.bytes);
      if (sniffed !== expectedFormat) {
        const message = `file extension ".${extension}" does not match its content`;
        if (declaredBy !== undefined) {
          issues.error("ASSET_CONTENT_MISMATCH", message, { path: file.path });
          return;
        }
        issues.warn("ASSET_CONTENT_MISMATCH", message, { path: file.path });
      }
    }
    assets.push({
      path: file.path,
      kind,
      size: file.size,
      contentHash: file.contentHash,
      contentType: contentTypeForPath(file.path),
    });
  };

  if (manifest.icon !== undefined) {
    const iconFile = byPath.get(manifest.icon);
    if (iconFile !== undefined) addAsset(iconFile, "icon", "icon");
  }
  if (manifest.logo !== undefined) {
    const logoFile = byPath.get(manifest.logo);
    if (logoFile !== undefined) addAsset(logoFile, "logo", "logo");
  }
  for (const file of files) {
    if (!isPathInside(ASSETS_DIR, file.path)) continue;
    const kind: PluginAssetKind = file.path.toLowerCase().includes("screenshot")
      ? "screenshot"
      : "other";
    addAsset(file, kind);
  }

  // Phase 8 — preserved-but-unsupported components.
  const unsupported: ParsedUnsupportedComponent[] = [];
  for (const [dir, kind] of Object.entries(UNSUPPORTED_DIRS)) {
    const paths = files
      .filter((file) => isPathInside(dir, file.path))
      .map((file) => file.path);
    if (paths.length === 0) continue;
    unsupported.push({
      kind,
      key: dir,
      paths,
      reason: `"${dir}/" components are preserved in the source bundle but not executed by MCPJam V1`,
    });
    issues.warn(
      "UNSUPPORTED_COMPONENT",
      `"${dir}/" is preserved but not executable in this MCPJam version`,
      { path: paths[0] }
    );
  }
  for (const field of unsupportedFields) {
    unsupported.push({
      kind: UNSUPPORTED_MANIFEST_FIELD_KINDS[field] ?? "manifest-field",
      key: field,
      paths: [],
      reason: `manifest field "${field}" is preserved in the source bundle but not executed by MCPJam V1`,
    });
    issues.warn(
      "UNSUPPORTED_COMPONENT",
      `manifest field "${field}" is preserved but not executable in this MCPJam version`
    );
  }

  // Phase 9 — setup requirements (names only; never credential values).
  const setupRequirements: PluginSetupRequirement[] = [];
  for (const server of mcpServers) {
    if (server.config.transport === "stdio") {
      for (const env of server.config.envRequirements) {
        if (env.valueTemplate !== undefined) continue; // runtime-provided
        setupRequirements.push({
          kind: "env",
          componentKey: server.componentKey,
          serverKey: server.key,
          name: env.name,
          required: env.required,
        });
      }
      continue;
    }
    for (const header of server.config.headerRequirements) {
      setupRequirements.push({
        kind: "header",
        componentKey: server.componentKey,
        serverKey: server.key,
        name: header.name,
        secret: header.secret,
      });
    }
    if (server.config.oauth !== undefined) {
      setupRequirements.push({
        kind: "oauth",
        componentKey: server.componentKey,
        serverKey: server.key,
        ...(server.config.oauth.timing !== undefined
          ? { timing: server.config.oauth.timing }
          : {}),
      });
    }
  }

  issues.throwIfErrors();

  return {
    manifest,
    bundleHash,
    manifestHash,
    skills,
    mcpServers,
    apps,
    assets,
    unsupported,
    setupRequirements,
    warnings: issues.warnings(),
  };
}

export type { NormalizedPluginManifest };
