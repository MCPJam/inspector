/**
 * Builds one server of the v3 inspection snapshot (`ServerFeatureSnapshotV3`
 * in `@mcpjam/sdk`) from the doctor state collected on a live connection and
 * the raw handshake the client manager observed. Pure: no I/O.
 *
 * Fidelity rules, from the contract in `sdk/src/server-features/snapshot.ts`:
 *  - object fields drop `$`-prefixed keys, which Convex refuses as function
 *    arguments; the backend drops `_`-prefixed nested keys when it stores;
 *  - a `*Json` string carries the value whole when that stripping would change
 *    it (schemas, capabilities) or always (`_meta`), up to
 *    `SNAPSHOT_JSON_FIELD_MAX_BYTES`; a larger value is omitted and the
 *    part's coverage reads `partial`;
 *  - a list's coverage is `complete` only when it was paged to the end
 *    without error;
 *  - a server over `SNAPSHOT_SERVER_MAX_BYTES` (`snapshot-budget.ts`) gives
 *    up `*Json` strings, then `meta` and schema objects, until it fits; each
 *    part it trims reads `partial`.
 */
import {
  COVERAGE_KEYS,
  SNAPSHOT_JSON_FIELD_MAX_BYTES,
  type CapturedEventsCapability,
  type ConnectedServerDoctorState,
  type CoverageKey,
  type CoverageState,
  type ServerFeatureSnapshotServerV3,
  type SnapshotDiscoveryV3,
  type SnapshotIcon,
  type SnapshotPromptV3,
  type SnapshotResourceTemplateV3,
  type SnapshotResourceV3,
  type SnapshotSkillV3,
  type SnapshotToolV3,
} from "@mcpjam/sdk";
import { stripConvexReservedKeys } from "../../utils/export-helpers.js";
import { parseHttpUrl } from "../../utils/hosted-upstream-projection.js";
import { fitSnapshotServer } from "./snapshot-budget.js";

type JsonRecord = Record<string, unknown>;
type Coverage = Record<CoverageKey, CoverageState>;

/** What the doctor's skills check could not tell apart on its own. */
export interface SkillsSupportInput {
  declared?: boolean;
  advertised?: boolean;
}

export interface BuildSnapshotServerInput {
  serverId: string;
  state: ConnectedServerDoctorState;
  handshake?: CapturedEventsCapability;
  skillsSupport?: SkillsSupportInput;
}

/** Icons above this many characters (large `data:` URIs) are left out. */
const MAX_ICON_SRC_LENGTH = 4096;
/** An image `data:` URI: `data:image/<type>`, parameters, then the data. */
const DATA_IMAGE_URI = /^data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+(?:=[^;,\s]+)?)*,\S*$/i;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Whether any key at any depth starts with `$` or `_`. */
export function hasReservedKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasReservedKeys);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, entry]) =>
      key.startsWith("$") || key.startsWith("_") || hasReservedKeys(entry),
  );
}

/**
 * The value as JSON when it fits the field bound, `"oversize"` when it does
 * not. A value that cannot be serialized counts as oversize: it is omitted
 * and the coverage says so.
 */
export function fidelityJson(value: unknown): string | "oversize" {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    // Unserializable input (a cycle or a BigInt) is recorded as an omission.
    return "oversize";
  }
  if (json === undefined) return "oversize";
  return Buffer.byteLength(json, "utf8") <= SNAPSHOT_JSON_FIELD_MAX_BYTES
    ? json
    : "oversize";
}

/**
 * An icon `src` the snapshot keeps: an http(s) URL without credentials, the
 * rule the hosted projection applies to `serverInfo.icons`, or an image
 * `data:` URI. Any other scheme is left out.
 */
function iconSrc(value: unknown): string | undefined {
  const src = text(value);
  if (!src || src.length > MAX_ICON_SRC_LENGTH) return undefined;
  return DATA_IMAGE_URI.test(src) ? src : parseHttpUrl(src);
}

function snapshotIcons(value: unknown): SnapshotIcon[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const icons: SnapshotIcon[] = [];
  for (const icon of value) {
    if (!isRecord(icon)) continue;
    const src = iconSrc(icon.src);
    if (!src) continue;
    const mimeType = text(icon.mimeType);
    const sizes = Array.isArray(icon.sizes)
      ? icon.sizes.filter((size): size is string => typeof size === "string")
      : undefined;
    const theme =
      icon.theme === "light" || icon.theme === "dark" ? icon.theme : undefined;
    icons.push({
      src,
      ...(mimeType ? { mimeType } : {}),
      ...(sizes && sizes.length > 0 ? { sizes } : {}),
      ...(theme ? { theme } : {}),
    });
  }
  return icons.length > 0 ? icons : undefined;
}

/**
 * `_meta` as a stripped object plus its full JSON. Calls `onOversize` when
 * the JSON is over the bound, so the caller can mark its coverage partial.
 */
function metaFields(
  meta: unknown,
  onOversize: () => void,
): { meta?: JsonRecord; metaJson?: string } {
  if (!isRecord(meta) || Object.keys(meta).length === 0) return {};
  const json = fidelityJson(meta);
  if (json === "oversize") onOversize();
  return {
    meta: stripConvexReservedKeys(meta),
    ...(json !== "oversize" ? { metaJson: json } : {}),
  };
}

/** A schema, stripped, plus its full JSON when stripping would change it. */
function schemaFields(
  schema: unknown,
  field: "inputSchema" | "outputSchema",
  onOversize: () => void,
): Partial<SnapshotToolV3> {
  if (schema === undefined) return {};
  const out: Partial<SnapshotToolV3> = {
    [field]: stripConvexReservedKeys(schema),
  };
  if (!hasReservedKeys(schema)) return out;
  const json = fidelityJson(schema);
  if (json === "oversize") onOversize();
  else out[`${field}Json`] = json;
  return out;
}

function descriptorBase(item: JsonRecord, name: string, onMetaOversize: () => void) {
  const title = text(item.title);
  const description = text(item.description);
  const icons = snapshotIcons(item.icons);
  return {
    name,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(icons ? { icons } : {}),
    ...metaFields(item._meta, onMetaOversize),
  };
}

const TOOL_HINTS = [
  "readOnlyHint",
  "destructiveHint",
  "idempotentHint",
  "openWorldHint",
] as const;

function toolAnnotations(value: unknown): SnapshotToolV3["annotations"] {
  if (!isRecord(value)) return undefined;
  const out: NonNullable<SnapshotToolV3["annotations"]> = {};
  const title = text(value.title);
  if (title) out.title = title;
  for (const hint of TOOL_HINTS) {
    if (typeof value[hint] === "boolean") out[hint] = value[hint];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function toolExecution(value: unknown): SnapshotToolV3["execution"] {
  const taskSupport = isRecord(value) ? value.taskSupport : undefined;
  return taskSupport === "forbidden" ||
    taskSupport === "optional" ||
    taskSupport === "required"
    ? { taskSupport }
    : undefined;
}

function annotationsField(value: unknown): { annotations?: JsonRecord } {
  return isRecord(value) ? { annotations: stripConvexReservedKeys(value) } : {};
}

/** Built items for the records `build` accepts, sorted by `sortKey`. */
function collect<T>(
  items: unknown[],
  build: (item: JsonRecord) => T | undefined,
  sortKey: (item: T) => string,
): T[] {
  const built: T[] = [];
  for (const item of items) {
    const entry = isRecord(item) ? build(item) : undefined;
    if (entry) built.push(entry);
  }
  return built.sort((left, right) => sortKey(left).localeCompare(sortKey(right)));
}

function buildTools(
  state: ConnectedServerDoctorState,
  coverage: Coverage,
): SnapshotToolV3[] {
  const schemaOversize = () => (coverage.toolSchemas = "partial");
  return collect(
    state.tools,
    (tool): SnapshotToolV3 | undefined => {
      if (typeof tool.name !== "string") return undefined;
      const annotations = toolAnnotations(tool.annotations);
      const execution = toolExecution(tool.execution);
      return {
        ...descriptorBase(
          { ...tool, _meta: state.toolsMetadata[tool.name] },
          tool.name,
          () => (coverage.toolMeta = "partial"),
        ),
        ...schemaFields(tool.inputSchema, "inputSchema", schemaOversize),
        ...schemaFields(tool.outputSchema, "outputSchema", schemaOversize),
        ...(annotations ? { annotations } : {}),
        ...(execution ? { execution } : {}),
      };
    },
    (tool) => tool.name,
  );
}

function mimeTypeField(value: unknown): { mimeType?: string } {
  const mimeType = text(value);
  return mimeType ? { mimeType } : {};
}

function promptArguments(value: unknown): SnapshotPromptV3["arguments"] {
  if (!Array.isArray(value)) return undefined;
  const args = value.flatMap((arg) => {
    if (!isRecord(arg) || typeof arg.name !== "string") return [];
    const description = text(arg.description);
    return [
      {
        name: arg.name,
        ...(description ? { description } : {}),
        ...(typeof arg.required === "boolean" ? { required: arg.required } : {}),
      },
    ];
  });
  return args.length > 0 ? args : undefined;
}

/** Resources, templates, prompts and skills; `_meta` overflow marks coverage. */
function buildLists(state: ConnectedServerDoctorState, coverage: Coverage) {
  const partial = (key: CoverageKey) => () => (coverage[key] = "partial");
  const resources = collect(
    state.resources,
    (item): SnapshotResourceV3 | undefined =>
      typeof item.uri !== "string"
        ? undefined
        : {
            ...descriptorBase(item, text(item.name) ?? item.uri, partial("resources")),
            uri: item.uri,
            ...mimeTypeField(item.mimeType),
            ...(typeof item.size === "number" ? { size: item.size } : {}),
            ...annotationsField(item.annotations),
          },
    (resource) => resource.uri,
  );
  const resourceTemplates = collect(
    state.resourceTemplates,
    (item): SnapshotResourceTemplateV3 | undefined =>
      typeof item.uriTemplate !== "string"
        ? undefined
        : {
            ...descriptorBase(
              item,
              text(item.name) ?? item.uriTemplate,
              partial("resourceTemplates"),
            ),
            uriTemplate: item.uriTemplate,
            ...mimeTypeField(item.mimeType),
            ...annotationsField(item.annotations),
          },
    (template) => template.uriTemplate,
  );
  const prompts = collect(
    state.prompts,
    (item): SnapshotPromptV3 | undefined => {
      if (typeof item.name !== "string") return undefined;
      const args = promptArguments(item.arguments);
      return {
        ...descriptorBase(item, item.name, partial("prompts")),
        ...(args ? { arguments: args } : {}),
      };
    },
    (prompt) => prompt.name,
  );
  const skills = collect(
    state.skills,
    (item): SnapshotSkillV3 | undefined => {
      if (typeof item.name !== "string") return undefined;
      const description = text(item.description);
      const uri = text(item.skillUri);
      return {
        name: item.name,
        ...(description ? { description } : {}),
        ...(uri ? { uri } : {}),
      };
    },
    (skill) => skill.uri ?? skill.name,
  );
  return { resources, resourceTemplates, prompts, skills };
}

function buildDiscovery(
  state: ConnectedServerDoctorState,
  handshake: CapturedEventsCapability | undefined,
  coverage: Coverage,
): SnapshotDiscoveryV3 | undefined {
  const initInfo = isRecord(state.initInfo) ? state.initInfo : undefined;
  const discovery: SnapshotDiscoveryV3 = {};

  const protocolVersion =
    text(initInfo?.protocolVersion) ?? text(handshake?.protocolVersion);
  if (protocolVersion) discovery.protocolVersion = protocolVersion;
  if (handshake?.supportedVersions?.length) {
    discovery.supportedVersions = [...handshake.supportedVersions];
  }

  const info = isRecord(initInfo?.serverVersion)
    ? initInfo.serverVersion
    : handshake?.rawServerInfo;
  if (isRecord(info)) {
    const serverInfo: NonNullable<SnapshotDiscoveryV3["serverInfo"]> = {};
    for (const field of [
      "name",
      "title",
      "version",
      "description",
      "websiteUrl",
    ] as const) {
      const value = text(info[field]);
      if (value) serverInfo[field] = value;
    }
    const icons = snapshotIcons(info.icons);
    if (icons) serverInfo.icons = icons;
    if (Object.keys(serverInfo).length > 0) {
      discovery.serverInfo = serverInfo;
      coverage.serverInfo = "complete";
    }
  }

  // The raw handshake keeps keys the client's parser strips; the parsed
  // capabilities are a fallback that may have lost some.
  const capabilities = handshake?.rawCapabilities ?? state.capabilities;
  if (isRecord(capabilities)) {
    discovery.capabilities = stripConvexReservedKeys(capabilities);
    coverage.capabilities = handshake?.rawCapabilities ? "complete" : "partial";
    if (hasReservedKeys(capabilities)) {
      const json = fidelityJson(capabilities);
      if (json === "oversize") coverage.capabilities = "partial";
      else discovery.capabilitiesJson = json;
    }
  }

  if (initInfo) {
    coverage.instructions = "complete";
    const instructions = text(initInfo.instructions);
    if (instructions) discovery.instructions = instructions;
  }

  Object.assign(
    discovery,
    metaFields(handshake?.rawMeta, () => {
      if (coverage.serverInfo === "complete") coverage.serverInfo = "partial";
    }),
  );
  return Object.keys(discovery).length > 0 ? discovery : undefined;
}

function listCoverage(status: string): CoverageState {
  return status === "ok" ? "complete" : "not-captured";
}

function skillsCoverage(
  check: ConnectedServerDoctorState["checks"]["skills"],
  support: SkillsSupportInput | undefined,
): CoverageState {
  if (check.status === "ok") return "complete";
  // An error with findings is a verification problem after a full listing.
  if (check.status === "error") {
    return "findings" in check && check.findings ? "complete" : "not-captured";
  }
  // Skipped: complete only when the server itself declares no skills.
  return support?.declared === false ? "complete" : "not-captured";
}

/** One server of the v3 snapshot, with its per-part coverage. */
export function buildSnapshotServerV3(
  input: BuildSnapshotServerInput,
): ServerFeatureSnapshotServerV3 {
  const { state, handshake } = input;
  const coverage = Object.fromEntries(
    COVERAGE_KEYS.map((key) => [key, "not-captured"]),
  ) as Coverage;
  const { checks } = state;

  coverage.tools = listCoverage(checks.tools.status);
  coverage.toolMeta = coverage.tools;
  coverage.toolSchemas = coverage.tools;
  coverage.resources = listCoverage(checks.resources.status);
  coverage.resourceTemplates =
    checks.resourceTemplates.status === "error" ? "not-captured" : "complete";
  coverage.prompts = listCoverage(checks.prompts.status);
  coverage.skills = skillsCoverage(checks.skills, input.skillsSupport);

  const tools = buildTools(state, coverage);
  const lists = buildLists(state, coverage);
  const discovery = buildDiscovery(state, handshake, coverage);

  const initInfo = isRecord(state.initInfo) ? state.initInfo : undefined;
  const transport = initInfo?.transport;
  return fitSnapshotServer({
    serverId: input.serverId,
    tools,
    ...(discovery ? { discovery } : {}),
    ...lists,
    ...(transport === "stdio" ||
    transport === "streamable-http" ||
    transport === "sse"
      ? { transport }
      : {}),
    coverage,
    ...(checks.tools.status === "error"
      ? { captureError: checks.tools.detail }
      : {}),
  });
}
