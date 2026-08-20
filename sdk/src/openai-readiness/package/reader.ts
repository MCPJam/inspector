/**
 * Read an OpenAI plugin package into gradeable evidence.
 *
 * WHY NOT `parsePluginBundle`. The Agent Plugins parser next door reads the
 * same directory layout, and reusing it would have been the obvious move. It is
 * the wrong one for two independent reasons. Its issue codes and limits are a
 * PERSISTED backend contract — the Convex import path stores them — so bending
 * them toward OpenAI's rules would change data that is already written down.
 * And it is spec-strict in ways OpenAI is not: it rejects `.codex-plugin/`
 * outright, which is the location OpenAI documents as canonical. So this reader
 * borrows the parser's PRIMITIVES (the file source, path normalisation, the
 * frontmatter splitter, the hashers) and none of its policy.
 *
 * WHY RAW ENTRY NAMES COME FIRST. This is the subtle one. The portal rejects a
 * backslash separator, an empty or `.` path segment, outer whitespace, and any
 * `..` — and `normalizeBundlePath` REPAIRS the first three: it maps `\` to `/`,
 * drops empty and `.` segments, and NFC-folds the result. Running the portal's
 * path rules against normalised paths would therefore pass every archive whose
 * paths the portal is about to reject, because the evidence would no longer
 * contain the thing being rejected. Raw names are checked before anything
 * touches them; normalisation happens afterwards, for identity and reads.
 *
 * WHAT IT DOES NOT DO. Grade. Nothing here produces a finding or decides a
 * lane: it returns observations plus a list of typed portal issues, and the
 * check module turns those into findings. Keeping the two apart is what lets
 * the same evidence be graded under different submission modes.
 *
 * Pure aside from the caller's `PluginFileSource`. Safe from the browser entry.
 */

import { sha256HexBytes } from "../../plugin-bundle/hashes.js";
import {
  caseFoldPath,
  normalizeBundlePath,
} from "../../plugin-bundle/paths.js";
import { parseYamlLite, splitFrontmatter } from "../../plugin-bundle/skill.js";
import type {
  PluginFileEntry,
  PluginFileSource,
} from "../../plugin-bundle/types.js";
import { openaiPortalIssue, type OpenAIPortalIssue } from "../portal-errors.js";
import {
  OPENAI_AGENT_METADATA_PATH,
  OPENAI_ARCHIVE_LIMITS,
  OPENAI_FIELD_LIMITS,
  OPENAI_IMAGE_CONSTRAINTS,
  OPENAI_MANIFEST_LOCATIONS,
  OPENAI_SKILL_METADATA_PATH,
} from "../profile.js";
import {
  NO_XML_PARSER_REASON,
  readImageDimensions,
  sniffImageMimeType,
  type ImageDimensions,
  type XmlParseFn,
} from "./image-dimensions.js";
import {
  parseOpenAIAgentMetadata,
  type OpenAIAgentMetadataIssue,
  type OpenAIAgentMetadataParse,
} from "./openai-agent-metadata.js";

/**
 * Facts about the ARCHIVE that no file source can report.
 *
 * A `PluginFileSource` abstracts over "a ZIP" and "a folder on disk", and the
 * abstraction is exactly right for reading content — but compressed size,
 * encryption flags and the pre-normalisation entry names only exist for an
 * archive. A folder source genuinely has none of them.
 *
 * Every field is optional, and an ABSENT field means "not observed" rather than
 * "fine". The reader records a `notEvaluated` entry for each one it lacks, so a
 * check can report `not-evaluated` with a real reason instead of quietly
 * passing a limit nobody measured.
 */
export interface OpenAIArchiveObservations {
  /** Bytes of the uploaded `.zip`, before expansion. */
  compressedBytes?: number;
  /** Entries the archive marks encrypted; the portal cannot scan them. */
  encryptedEntryPaths?: string[];
  /**
   * Entry names EXACTLY as the central directory records them.
   *
   * The whole reason this field exists — see the module docblock.
   */
  rawEntryNames?: string[];
}

export interface ReadOpenAIPluginPackageOptions {
  archive?: OpenAIArchiveObservations;
  /**
   * How to parse an SVG, for runtimes with no `DOMParser`.
   *
   * A browser has one natively and needs nothing here. Node does not, so a Node
   * caller passes `xmldomParseXml` from the Node entry — kept an argument
   * rather than an import so `@xmldom/xmldom` never enters the browser entry's
   * graph. Without it, SVG assets are recorded as a GAP rather than graded.
   */
  parseXml?: XmlParseFn;
}

/** Where the manifest was found, and whether that required an assumption. */
export interface OpenAIManifestLocation {
  path: string;
  canonical: boolean;
  /**
   * Set when the manifest was read from an accepted-but-not-canonical
   * directory. Recorded rather than silently accepted: a submitter whose
   * package works only because we normalised it has not been told the truth
   * about their package.
   */
  normalizedFrom?: string;
}

export interface OpenAIPackageManifest {
  location: OpenAIManifestLocation;
  /** The parsed document, or `undefined` when it was not valid JSON. */
  raw?: Record<string, unknown>;
  name?: string;
  version?: string;
  description?: string;
  /** Server names declared by the manifest or `.mcp.json`. */
  mcpServerNames: string[];
}

export interface OpenAIPackageSkill {
  /** Canonical bundle-relative directory, e.g. `skills/weather`. */
  directory: string;
  directoryName: string;
  skillFilePath: string;
  name?: string;
  description?: string;
  /** Frontmatter as parsed; flat only, which is all SKILL.md declares. */
  frontmatter: Record<string, unknown>;
  /** SHA-256 of the SKILL.md bytes. */
  contentHash: string;
  /** Every byte under the skill directory. */
  totalBytes: number;
  fileCount: number;
  /** This skill's own `agents/openai.yaml`, when it ships one. */
  agentMetadata?: OpenAIAgentMetadataParse;
}

export interface OpenAIPackageAsset {
  path: string;
  bytes: number;
  contentHash: string;
  /** Inferred from the file extension — what the submitter CLAIMS it is. */
  declaredMimeType?: string;
  /** Inferred from the bytes — what it actually is. */
  sniffedMimeType?: string;
  dimensions?: ImageDimensions;
  /** Why the dimensions could not be read, when they could not. */
  undecodableReason?: string;
}

/** A surface present in the package that the plugin directory does not run. */
export interface OpenAIPackageSurface {
  path: string;
  /** The surface's name as the migration guide refers to it. */
  surface: string;
}

/** Something the reader could not look at, and why. */
export interface OpenAIPackageGap {
  subject: string;
  reason: string;
}

export interface OpenAIPackageEntryStats {
  /** Entries the source listed, directories included — what the limit counts. */
  entryCount: number;
  fileCount: number;
  directoryCount: number;
  totalUncompressedBytes: number;
  /** Absent when the source is not an archive. */
  compressedBytes?: number;
}

export interface OpenAIPluginPackageEvidence {
  manifest?: OpenAIPackageManifest;
  /** The plugin-level `agents/openai.yaml`, when present. */
  agentMetadata?: OpenAIAgentMetadataParse;
  skills: OpenAIPackageSkill[];
  assets: OpenAIPackageAsset[];
  /** Non-directory surfaces the package ships, by canonical path. */
  surfaces: OpenAIPackageSurface[];
  entryStats: OpenAIPackageEntryStats;
  /** Every documented portal code this package trips, in discovery order. */
  issues: OpenAIPortalIssue[];
  /** What could not be examined, so a check can say `not-evaluated` honestly. */
  gaps: OpenAIPackageGap[];
}

const SKILLS_DIRECTORY = "skills";

/** Extensions the portal treats as listing imagery. */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  svg: "image/svg+xml",
};

/**
 * Surfaces an Agent Plugins bundle may carry that the plugin directory does not
 * run. Their PRESENCE is what the migration lane grades; the reader only
 * records it.
 */
const UNSUPPORTED_SURFACES: {
  test: (path: string) => boolean;
  surface: string;
}[] = [
  { test: (path) => path === ".app.json", surface: "app-config" },
  { test: (path) => path.startsWith("hooks/"), surface: "hooks" },
  { test: (path) => path.startsWith("commands/"), surface: "commands" },
  {
    test: (path) =>
      path.startsWith("agents/") && path !== OPENAI_AGENT_METADATA_PATH,
    surface: "agents",
  },
  { test: (path) => path.startsWith("themes/"), surface: "themes" },
  { test: (path) => path.startsWith("monitors/"), surface: "monitors" },
  { test: (path) => path.startsWith("channels/"), surface: "channels" },
];

/**
 * Which documented portal code an `agents/openai.yaml` issue corresponds to.
 *
 * A table rather than a chain of conditionals because the mapping is data: one
 * validation issue maps to one published code, and the reader's job is to
 * translate, not to decide. Anything unrecognised falls back to the
 * document-level code rather than being dropped — a portal issue this reader
 * cannot classify is still a portal issue, and losing it would break the
 * invariant that every documented code survives into `details.portalIssues`.
 */
function interfaceIssueCode(issue: OpenAIAgentMetadataIssue): string {
  if (issue.path === "(root)") return "interface-yaml-invalid";
  if (issue.message.includes("unsupported characters")) {
    return "interface-unsupported-text";
  }
  const tooLong = issue.message.includes("the maximum is");
  switch (issue.path) {
    case "interface.brand_color":
      // "not a hex value" and "does not contrast" are different remediations,
      // and the portal gives them different codes.
      return issue.message.includes("contrasts")
        ? "interface-brand-color-low-contrast"
        : "interface-brand-color-invalid";
    case "interface.display_name":
      return tooLong
        ? "interface-display-name-too-long"
        : "interface-display-name-missing";
    case "interface.short_description":
      return tooLong
        ? "interface-short-description-too-long"
        : "interface-yaml-invalid";
    case "interface.default_prompt":
      return tooLong
        ? "interface-default-prompt-too-long"
        : "interface-yaml-invalid";
    default:
      return "interface-yaml-invalid";
  }
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * The portal's path rules, applied to the name EXACTLY as the archive records
 * it.
 *
 * Every rule here is one that `normalizeBundlePath` would repair or that it
 * reports under a different code. Running them on a normalised path would mean
 * checking for a defect the normaliser has already removed.
 */
function checkRawEntryName(raw: string): OpenAIPortalIssue[] {
  const issues: OpenAIPortalIssue[] = [];
  const at = { subject: raw };

  if (raw.includes("\\")) {
    issues.push(openaiPortalIssue("archive-backslash-path", at));
  }
  if (raw.startsWith("/") || /^[A-Za-z]:[\\/]/.test(raw)) {
    issues.push(openaiPortalIssue("archive-absolute-path", at));
  }

  const segments = raw.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    issues.push(openaiPortalIssue("archive-path-traversal", at));
  }
  // A trailing empty segment is just a directory marker (`skills/`), which is
  // ordinary; an empty segment in the MIDDLE (`a//b`) is the doubled separator
  // the portal rejects, and normalisation collapses it out of existence.
  if (
    segments.slice(0, -1).some((segment) => segment === "") ||
    segments.some((segment) => segment === ".")
  ) {
    issues.push(openaiPortalIssue("archive-empty-path-segment", at));
  }
  if (segments.some((segment) => segment !== segment.trim())) {
    issues.push(openaiPortalIssue("archive-path-whitespace", at));
  }
  // Escapes, not literals: a literal control character in this source is
  // invisible to a reviewer and turns the file into something `grep` treats as
  // binary.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    issues.push(openaiPortalIssue("archive-path-control-character", at));
  }
  return issues;
}

/** Read a file, tolerating a source that refuses or is missing the entry. */
async function readBytesSafely(
  source: PluginFileSource,
  path: string,
  maxBytes: number,
): Promise<{ bytes?: Uint8Array; error?: string }> {
  try {
    return { bytes: await source.readBytes(path, maxBytes) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

const decoder = new TextDecoder("utf-8", { fatal: false });

function readStringField(
  container: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = container?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Server names from a `.mcp.json`-shaped document, in either spelling. */
function readServerNames(document: unknown): string[] {
  if (typeof document !== "object" || document === null) return [];
  const container = document as Record<string, unknown>;
  const map = container.mcpServers ?? container.servers;
  if (typeof map !== "object" || map === null || Array.isArray(map)) return [];
  return Object.keys(map as Record<string, unknown>);
}

export async function readOpenAIPluginPackage(
  source: PluginFileSource,
  options: ReadOpenAIPluginPackageOptions = {},
): Promise<OpenAIPluginPackageEvidence> {
  const issues: OpenAIPortalIssue[] = [];
  const gaps: OpenAIPackageGap[] = [];
  const archive = options.archive ?? {};

  const listed: PluginFileEntry[] = await source.list();

  // ---------------------------------------------------------------- raw names
  //
  // Before ANYTHING normalises a path. See the module docblock.
  const rawNames = archive.rawEntryNames ?? listed.map((entry) => entry.path);
  if (!archive.rawEntryNames) {
    gaps.push({
      subject: "rawEntryNames",
      reason:
        "the source reported no pre-normalization entry names, so the entry paths " +
        "were checked as the source spelled them; a folder source cannot report " +
        "what an archive's central directory recorded",
    });
  }
  for (const raw of rawNames) {
    issues.push(...checkRawEntryName(raw));
  }

  // ------------------------------------------------------------ archive shape
  if (archive.compressedBytes === undefined) {
    gaps.push({
      subject: "compressedBytes",
      reason:
        "the source is not an archive, so the uploaded (compressed) size does not exist to measure",
    });
  } else if (
    archive.compressedBytes > OPENAI_ARCHIVE_LIMITS.maxCompressedBytes
  ) {
    issues.push(
      openaiPortalIssue("archive-too-large", {
        observed: archive.compressedBytes,
        expected: OPENAI_ARCHIVE_LIMITS.maxCompressedBytes,
      }),
    );
  }

  if (archive.encryptedEntryPaths === undefined) {
    gaps.push({
      subject: "encryptedEntryPaths",
      reason:
        "the source did not report archive encryption flags, so encrypted entries could not be detected",
    });
  } else {
    for (const path of archive.encryptedEntryPaths) {
      issues.push(
        openaiPortalIssue("archive-encrypted-entry", { subject: path }),
      );
    }
  }

  if (listed.length > OPENAI_ARCHIVE_LIMITS.maxEntries) {
    issues.push(
      openaiPortalIssue("archive-too-many-entries", {
        observed: listed.length,
        expected: OPENAI_ARCHIVE_LIMITS.maxEntries,
      }),
    );
  }

  // ------------------------------------------------- normalise, collect files
  const files = new Map<string, { sourcePath: string; size: number }>();
  const folded = new Map<string, string>();
  let directoryCount = 0;
  let totalUncompressedBytes = 0;

  for (const entry of listed) {
    if (entry.kind === "symlink" || entry.kind === "hardlink") {
      issues.push(
        openaiPortalIssue("archive-symlink-entry", { subject: entry.path }),
      );
      continue;
    }
    if (entry.kind === "directory") {
      directoryCount += 1;
      continue;
    }

    const normalized = normalizeBundlePath(entry.path);
    if (!normalized.ok) {
      // The raw-name pass above already reported the portal's own vocabulary
      // for these; this branch exists so an unreadable path is skipped rather
      // than read from.
      continue;
    }

    const path = normalized.path;
    if (files.has(path)) {
      issues.push(
        openaiPortalIssue("archive-duplicate-path", { subject: path }),
      );
      continue;
    }
    const key = caseFoldPath(path);
    const clash = folded.get(key);
    if (clash !== undefined && clash !== path) {
      // Two entries that differ only by case extract over each other on macOS
      // and Windows, so the package that reaches the reviewer is not the one
      // that was uploaded.
      issues.push(
        openaiPortalIssue("archive-duplicate-path", {
          subject: path,
          observed: clash,
        }),
      );
      continue;
    }
    folded.set(key, path);
    files.set(path, { sourcePath: entry.path, size: entry.size });
    totalUncompressedBytes += entry.size;
  }

  if (totalUncompressedBytes > OPENAI_ARCHIVE_LIMITS.maxUncompressedBytes) {
    issues.push(
      openaiPortalIssue("archive-expands-too-large", {
        observed: totalUncompressedBytes,
        expected: OPENAI_ARCHIVE_LIMITS.maxUncompressedBytes,
      }),
    );
  }

  const read = (path: string) =>
    readBytesSafely(
      source,
      files.get(path)?.sourcePath ?? path,
      OPENAI_ARCHIVE_LIMITS.maxUncompressedBytes,
    );

  // ------------------------------------------------------------ the manifest
  const manifestCandidates = [
    OPENAI_MANIFEST_LOCATIONS.canonical,
    ...OPENAI_MANIFEST_LOCATIONS.accepted,
  ];
  const manifestPath = manifestCandidates.find((candidate) =>
    files.has(candidate),
  );

  let manifest: OpenAIPackageManifest | undefined;
  if (!manifestPath) {
    issues.push(openaiPortalIssue("manifest-missing"));
  } else {
    const canonical = manifestPath === OPENAI_MANIFEST_LOCATIONS.canonical;
    const location: OpenAIManifestLocation = {
      path: manifestPath,
      canonical,
      normalizedFrom: canonical ? undefined : manifestPath,
    };

    const { bytes, error } = await read(manifestPath);
    if (!bytes) {
      issues.push(
        openaiPortalIssue("manifest-invalid-json", {
          subject: manifestPath,
          observed: error,
        }),
      );
      manifest = { location, mcpServerNames: [] };
    } else {
      let parsed: Record<string, unknown> | undefined;
      try {
        const value: unknown = JSON.parse(decoder.decode(bytes));
        if (
          typeof value === "object" &&
          value !== null &&
          !Array.isArray(value)
        ) {
          parsed = value as Record<string, unknown>;
        } else {
          issues.push(
            openaiPortalIssue("manifest-invalid-json", {
              subject: manifestPath,
              observed: "the document is not a JSON object",
            }),
          );
        }
      } catch (parseError) {
        issues.push(
          openaiPortalIssue("manifest-invalid-json", {
            subject: manifestPath,
            observed:
              parseError instanceof Error
                ? parseError.message
                : String(parseError),
          }),
        );
      }

      const name = readStringField(parsed, "name");
      const version = readStringField(parsed, "version");

      if (parsed && name === undefined) {
        issues.push(
          openaiPortalIssue("manifest-name-missing", { subject: manifestPath }),
        );
      } else if (
        name !== undefined &&
        name.length > OPENAI_FIELD_LIMITS.nameMaxLength
      ) {
        issues.push(
          openaiPortalIssue("manifest-name-too-long", {
            subject: manifestPath,
            observed: name.length,
            expected: OPENAI_FIELD_LIMITS.nameMaxLength,
          }),
        );
      }

      // Semver, deliberately without a dependency: the portal wants a version
      // it can order, and `1.0` is the mistake this catches.
      if (
        version !== undefined &&
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
          version,
        )
      ) {
        issues.push(
          openaiPortalIssue("manifest-version-invalid", {
            subject: manifestPath,
            observed: version,
          }),
        );
      }

      const serverNames = new Set(readServerNames(parsed));
      if (files.has(".mcp.json")) {
        const mcpConfig = await read(".mcp.json");
        if (mcpConfig.bytes) {
          try {
            for (const serverName of readServerNames(
              JSON.parse(decoder.decode(mcpConfig.bytes)),
            )) {
              serverNames.add(serverName);
            }
          } catch {
            // A malformed `.mcp.json` is not a manifest problem; it surfaces as
            // an unreadable server list rather than a JSON error against the
            // manifest's own path.
            gaps.push({
              subject: ".mcp.json",
              reason:
                "the MCP configuration is not valid JSON, so its servers could not be listed",
            });
          }
        }
      }

      manifest = {
        location,
        raw: parsed,
        name,
        version,
        description: readStringField(parsed, "description"),
        mcpServerNames: [...serverNames].sort(),
      };
    }
  }

  // ------------------------------------------------- the plugin-level metadata
  let agentMetadata: OpenAIAgentMetadataParse | undefined;
  if (files.has(OPENAI_AGENT_METADATA_PATH)) {
    const { bytes } = await read(OPENAI_AGENT_METADATA_PATH);
    if (bytes) {
      agentMetadata = parseOpenAIAgentMetadata(decoder.decode(bytes));
      for (const issue of agentMetadata.issues) {
        issues.push(
          openaiPortalIssue(interfaceIssueCode(issue), {
            subject: `${OPENAI_AGENT_METADATA_PATH}:${issue.path}`,
            observed: issue.message,
          }),
        );
      }
      if (agentMetadata.metadata?.interface.displayName === undefined) {
        issues.push(
          openaiPortalIssue("interface-display-name-missing", {
            subject: OPENAI_AGENT_METADATA_PATH,
          }),
        );
      }
    }
  }

  // ----------------------------------------------------------------- skills
  //
  // THREE SEGMENTS, not two. A skill is a DIRECTORY under `skills/`, so the
  // shortest path that establishes one is `skills/<name>/<file>`. Accepting
  // two segments would register a loose file — `skills/README.md` is the
  // obvious one — as a skill directory named `README.md`, and the very next
  // step, looking for `skills/README.md/SKILL.md`, would then report a
  // BLOCKING `skill-metadata-missing` against a package whose only sin is a
  // readme.
  const skillDirectories = new Set<string>();
  for (const path of files.keys()) {
    if (!path.startsWith(`${SKILLS_DIRECTORY}/`)) continue;
    const segments = path.split("/");
    if (segments.length >= 3 && segments[1] !== "") {
      skillDirectories.add(segments[1]);
    }
  }

  const skills: OpenAIPackageSkill[] = [];
  const skillNames = new Map<string, string>();

  for (const directoryName of [...skillDirectories].sort()) {
    const directory = `${SKILLS_DIRECTORY}/${directoryName}`;
    const skillFilePath = `${directory}/${OPENAI_SKILL_METADATA_PATH}`;

    let totalBytes = 0;
    let fileCount = 0;
    for (const [path, entry] of files) {
      if (path === directory || path.startsWith(`${directory}/`)) {
        totalBytes += entry.size;
        fileCount += 1;
      }
    }

    if (!files.has(skillFilePath)) {
      issues.push(
        openaiPortalIssue("skill-metadata-missing", { subject: directory }),
      );
      continue;
    }

    const { bytes } = await read(skillFilePath);
    if (!bytes) {
      issues.push(
        openaiPortalIssue("skill-frontmatter-invalid", {
          subject: skillFilePath,
          observed: "the file could not be read",
        }),
      );
      continue;
    }

    const text = decoder.decode(bytes);
    const split = splitFrontmatter(text);
    const skill: OpenAIPackageSkill = {
      directory,
      directoryName,
      skillFilePath,
      frontmatter: {},
      contentHash: await sha256HexBytes(bytes),
      totalBytes,
      fileCount,
    };

    if (!split) {
      issues.push(
        openaiPortalIssue("skill-frontmatter-invalid", {
          subject: skillFilePath,
          observed: "no `---` frontmatter block",
        }),
      );
    } else {
      // `parseYamlLite` is the FLAT subset, and that is correct here and only
      // here: SKILL.md frontmatter is documented as flat scalars and lists, so
      // the subset cannot silently lose a nested structure the way it would in
      // `agents/openai.yaml`.
      const parsed = parseYamlLite(split.frontmatter);
      skill.frontmatter = parsed.data;
      // `.length`, not truthiness: both are ARRAYS, and an empty array is
      // truthy — so the obvious `if (parsed.tooDeep)` reports every
      // well-formed skill as malformed.
      if (parsed.tooDeep.length > 0 || parsed.unparsed.length > 0) {
        issues.push(
          openaiPortalIssue("skill-frontmatter-invalid", {
            subject: skillFilePath,
            observed:
              parsed.tooDeep.length > 0
                ? "the frontmatter nests deeper than SKILL.md allows"
                : `unparsed frontmatter lines: ${parsed.unparsed.length}`,
          }),
        );
      }

      const name = parsed.data.name;
      const description = parsed.data.description;
      skill.name = typeof name === "string" ? name : undefined;
      skill.description =
        typeof description === "string" ? description : undefined;

      if (skill.name === undefined) {
        issues.push(
          openaiPortalIssue("skill-name-missing", { subject: skillFilePath }),
        );
      } else {
        if (skill.name.length > OPENAI_FIELD_LIMITS.skillNameMaxLength) {
          issues.push(
            openaiPortalIssue("skill-name-too-long", {
              subject: skillFilePath,
              observed: skill.name.length,
              expected: OPENAI_FIELD_LIMITS.skillNameMaxLength,
            }),
          );
        }
        const previous = skillNames.get(skill.name);
        if (previous !== undefined) {
          issues.push(
            openaiPortalIssue("skill-name-collision", {
              subject: skill.name,
              observed: `${previous} and ${directory}`,
            }),
          );
        } else {
          skillNames.set(skill.name, directory);
        }
      }

      if (skill.description === undefined) {
        issues.push(
          openaiPortalIssue("skill-description-missing", {
            subject: skillFilePath,
          }),
        );
      }
    }

    const skillMetadataPath = `${directory}/${OPENAI_AGENT_METADATA_PATH}`;
    if (files.has(skillMetadataPath)) {
      const metadataBytes = await read(skillMetadataPath);
      if (metadataBytes.bytes) {
        skill.agentMetadata = parseOpenAIAgentMetadata(
          decoder.decode(metadataBytes.bytes),
        );
      }
    }

    skills.push(skill);
  }

  // ----------------------------------------------------------------- assets
  const assets: OpenAIPackageAsset[] = [];
  for (const [path, entry] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const extension = extensionOf(path);
    const declaredMimeType = IMAGE_MIME_BY_EXTENSION[extension];
    if (!declaredMimeType) continue;

    const asset: OpenAIPackageAsset = {
      path,
      bytes: entry.size,
      contentHash: "",
      declaredMimeType,
    };

    if (entry.size > OPENAI_IMAGE_CONSTRAINTS.maxBytes) {
      issues.push(
        openaiPortalIssue("asset-too-large", {
          subject: path,
          observed: entry.size,
          expected: OPENAI_IMAGE_CONSTRAINTS.maxBytes,
        }),
      );
    }

    const { bytes, error } = await read(path);
    if (!bytes) {
      asset.undecodableReason = error ?? "the file could not be read";
      issues.push(
        openaiPortalIssue("asset-undecodable", {
          subject: path,
          observed: asset.undecodableReason,
        }),
      );
      assets.push(asset);
      continue;
    }

    asset.contentHash = await sha256HexBytes(bytes);
    asset.sniffedMimeType = sniffImageMimeType(bytes, {
      parseXml: options.parseXml,
    });

    const effectiveMimeType = asset.sniffedMimeType ?? declaredMimeType;
    if (
      !(
        OPENAI_IMAGE_CONSTRAINTS.acceptedMimeTypes as readonly string[]
      ).includes(effectiveMimeType)
    ) {
      issues.push(
        openaiPortalIssue("asset-unsupported-type", {
          subject: path,
          observed: effectiveMimeType,
        }),
      );
    }

    const decoded = readImageDimensions(bytes, { parseXml: options.parseXml });
    if (!decoded.ok) {
      asset.undecodableReason = decoded.reason;

      // A runtime with no XML parser is OUR limitation, not the submitter's
      // defect. Reporting it as a malformed SVG would send them to fix a file
      // that is fine, so it is recorded as a gap and no portal code is raised.
      if (decoded.reason.includes(NO_XML_PARSER_REASON)) {
        gaps.push({
          subject: path,
          reason: `${NO_XML_PARSER_REASON}; this SVG's dimensions were not checked`,
        });
        assets.push(asset);
        continue;
      }

      // SVG gets its own two codes because the remediation differs: a
      // malformed document and a document with no dimensions are different
      // mistakes, and "could not decode" would tell the submitter neither.
      const code =
        declaredMimeType === "image/svg+xml"
          ? decoded.reason.includes("well-formed") ||
            decoded.reason.includes("root element")
            ? "asset-svg-malformed"
            : "asset-svg-no-dimensions"
          : "asset-undecodable";
      issues.push(
        openaiPortalIssue(code, { subject: path, observed: decoded.reason }),
      );
      assets.push(asset);
      continue;
    }

    asset.dimensions = decoded.dimensions;
    const { widthPx, heightPx } = decoded.dimensions;
    const shortest = Math.min(widthPx, heightPx);
    const longest = Math.max(widthPx, heightPx);

    if (shortest < OPENAI_IMAGE_CONSTRAINTS.minEdgePx) {
      issues.push(
        openaiPortalIssue("asset-too-small", {
          subject: path,
          observed: shortest,
          expected: OPENAI_IMAGE_CONSTRAINTS.minEdgePx,
        }),
      );
    }
    if (longest > OPENAI_IMAGE_CONSTRAINTS.maxEdgePx) {
      issues.push(
        openaiPortalIssue("asset-too-big-dimensions", {
          subject: path,
          observed: longest,
          expected: OPENAI_IMAGE_CONSTRAINTS.maxEdgePx,
        }),
      );
    }
    if (OPENAI_IMAGE_CONSTRAINTS.mustBeSquare && widthPx !== heightPx) {
      issues.push(
        openaiPortalIssue("asset-not-square", {
          subject: path,
          observed: `${widthPx}x${heightPx}`,
        }),
      );
    }

    assets.push(asset);
  }

  // Assets the interface document names but the package does not ship.
  //
  // NORMALISED BEFORE THE LOOKUP, because `files` is keyed by canonical path
  // and a hand-written reference is not. `./icon.png` and `icon.png` name the
  // same shipped file, and comparing the reference as written would report the
  // first as missing from a package that ships it — a fabricated defect on a
  // correct submission, which is worse than the one it was meant to catch.
  // A reference that does not normalise at all (absolute, traversing) names
  // nothing inside the package, so it is still missing.
  for (const [field, reference] of [
    ["interface.icon_small", agentMetadata?.metadata?.interface.iconSmall],
    ["interface.icon_large", agentMetadata?.metadata?.interface.iconLarge],
  ] as const) {
    if (!reference) continue;
    const resolved = normalizeBundlePath(reference);
    if (!resolved.ok || !files.has(resolved.path)) {
      issues.push(
        openaiPortalIssue("asset-missing", {
          subject: field,
          observed: reference,
        }),
      );
    }
  }

  // --------------------------------------------------------------- surfaces
  const surfaces: OpenAIPackageSurface[] = [];
  for (const path of files.keys()) {
    for (const candidate of UNSUPPORTED_SURFACES) {
      if (candidate.test(path)) {
        surfaces.push({ path, surface: candidate.surface });
        break;
      }
    }
  }
  surfaces.sort((a, b) => (a.path < b.path ? -1 : 1));

  return {
    manifest,
    agentMetadata,
    skills,
    assets,
    surfaces,
    entryStats: {
      entryCount: listed.length,
      fileCount: files.size,
      directoryCount,
      totalUncompressedBytes,
      compressedBytes: archive.compressedBytes,
    },
    issues,
    gaps,
  };
}
