/**
 * The package a hosted readiness run grades: a plugin version stored in the
 * project, frozen with the run's answers when the run was requested.
 *
 * The ChatGPT directory reviews a ZIP, and the hosted runner cannot receive
 * an upload, so a ChatGPT plugin submission's run grades a version MCPJam
 * already stores. The backend hands a short-lived link to that version's ZIP
 * only to the node holding the run's lease; this module downloads it and
 * checks it is that version before the readiness reader opens it.
 *
 * THE LINK GRANTS CONTENT, NEVER TRUST. The bytes must parse to the version's
 * `bundleHash` under the profile the import pinned it with. That parse is the
 * only way to compute the hash (the SDK keeps its primitives private, as the
 * plugin bundle cache also relies on). Bytes that hash to anything else are
 * not this version, and grading them would report on a package nobody
 * submitted, so the run fails instead.
 */
import {
  collectZipArchiveObservations,
  createZipPluginFileSource,
  type OpenAIArchiveObservations,
} from "@mcpjam/sdk";
import {
  parsePluginBundle,
  type PluginFileSource,
} from "@mcpjam/sdk/plugin-bundle";
import { getInternalBackendConfig } from "../internal-backend.js";
import type { ReadinessLease } from "./backend-client.js";
import { ReadinessLeaseLostError } from "./runner.js";

const BUNDLE_LINK_PATH = "/internal/v1/claude-readiness/runs/plugin-bundle";
const LINK_TIMEOUT_MS = 10_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * The largest ZIP the backend serves: Convex caps an HTTP action's response
 * at 20 MiB, less 64 KiB of headroom. The backend refuses a larger version
 * when the run starts, and answers 413 here.
 */
const MAX_RUN_PACKAGE_BYTES = 20 * 1024 * 1024 - 64 * 1024;

/** The profile the backend imports with, so its pinned hash is the one computed here. */
const IMPORT_PROFILE = "openai-compatible";

/** Which stored version a run graded. Recorded on the report. */
export interface GradedPluginVersion {
  pluginVersionId: string;
  pluginId: string;
  declaredVersion?: string;
  bundleHash: string;
}

export interface RunPackage {
  source: PluginFileSource;
  /** Facts about the stored ZIP itself, which the source cannot carry. */
  archive: OpenAIArchiveObservations;
  version: GradedPluginVersion;
}

type PackageFailure =
  | "plugin_bundle_unavailable"
  | "plugin_bundle_too_large"
  | "plugin_bundle_mismatch";

/** The run's package could not be read as its version. `reason` is the run's terminal reason. */
export class ReadinessPackageUnreadableError extends Error {
  readonly code = "readinessPackageUnreadable" as const;
  constructor(
    readonly reason: PackageFailure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

type Refusal = { reason: PackageFailure; message: string };

// The messages land on the run row, written for the person reading the run
// as the answers' failures are.
const NOT_DOWNLOADED: Refusal = {
  reason: "plugin_bundle_unavailable",
  message:
    "This run's plugin version could not be downloaded, so it was not graded. Start the run again.",
};
const MISSING: Refusal = {
  reason: "plugin_bundle_unavailable",
  message:
    "The files of this run's plugin version are missing, so it was not graded. Import the plugin again, then start a new run.",
};
const NO_VERSION: Refusal = {
  reason: "plugin_bundle_unavailable",
  message:
    "This run names no plugin version to grade, so it was not graded. Start a new run from the submission and name the version.",
};
const TOO_LARGE: Refusal = {
  reason: "plugin_bundle_too_large",
  message:
    "This run's plugin version is larger than the 20 MB a hosted run can download, so it was not graded. Grade the ZIP with the MCPJam CLI instead.",
};
const MISMATCH: Refusal = {
  reason: "plugin_bundle_mismatch",
  message:
    "The downloaded files do not match this run's plugin version, so it was not graded. Import the plugin again, then start a new run.",
};

/** The backend's 404 refusals, by the code in their body. */
const NOT_FOUND = new Map([
  ["no_plugin_version", NO_VERSION],
  ["bundle_unavailable", MISSING],
]);

function refused({ reason, message }: Refusal, cause?: unknown) {
  return new ReadinessPackageUnreadableError(
    reason,
    message,
    cause === undefined ? undefined : { cause },
  );
}

interface BundleLink {
  version: GradedPluginVersion;
  size: number;
  url: string;
}

/** The link's fields, checked one by one; anything else in the body stays out. */
function asBundleLink(body: unknown): BundleLink | undefined {
  const link = body as Record<string, unknown> | null;
  const { pluginVersionId, pluginId, declaredVersion, bundleHash, size, url } =
    link ?? {};
  if (
    typeof pluginVersionId !== "string" ||
    typeof pluginId !== "string" ||
    typeof bundleHash !== "string" ||
    typeof url !== "string" ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size)
  ) {
    return undefined;
  }
  const version: GradedPluginVersion = {
    pluginVersionId,
    pluginId,
    ...(typeof declaredVersion === "string" ? { declaredVersion } : {}),
    bundleHash,
  };
  return { version, size, url };
}

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Not JSON: a backend without the route answers with its router's text.
    return null;
  }
}

/** Ask for the link on the lease this node holds. */
async function requestBundleLink(lease: ReadinessLease): Promise<BundleLink> {
  const { convexUrl, serviceToken } = getInternalBackendConfig();
  const query = new URLSearchParams({ runId: lease.runId, jobId: lease.jobId });
  let response: Response;
  let body: unknown;
  try {
    // Read on every status, so a refusal's body does not hold its connection.
    response = await fetch(`${convexUrl}${BUNDLE_LINK_PATH}?${query}`, {
      headers: { "x-inspector-service-token": serviceToken },
      signal: AbortSignal.timeout(LINK_TIMEOUT_MS),
    });
    body = jsonOf(await response.text());
  } catch (error) {
    throw refused(NOT_DOWNLOADED, error);
  }
  // The run was cancelled or swept: its result belongs to nobody now.
  if (response.status === 409) throw new ReadinessLeaseLostError();
  if (response.status === 413) throw refused(TOO_LARGE);
  if (response.status === 404) {
    const code = String((body as { error?: unknown } | null)?.error);
    throw refused(NOT_FOUND.get(code) ?? NOT_DOWNLOADED);
  }
  const link = response.ok ? asBundleLink(body) : undefined;
  if (!link) throw refused(NOT_DOWNLOADED);
  return link;
}

/**
 * Exactly `size` bytes, or `null`. A body of any other length is not the
 * stored ZIP, and reading past the declared size would hold whatever arrived.
 */
async function readExactly(
  response: Response,
  size: number,
): Promise<Uint8Array | null> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > size) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return total === size ? new Uint8Array(Buffer.concat(chunks, total)) : null;
}

async function download(link: BundleLink): Promise<Uint8Array> {
  if (link.size > MAX_RUN_PACKAGE_BYTES) throw refused(TOO_LARGE);
  let bytes: Uint8Array | null = null;
  try {
    // The link authorizes itself; the service token never travels with it.
    const response = await fetch(link.url, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (response.ok) bytes = await readExactly(response, link.size);
    else await response.body?.cancel();
  } catch (error) {
    throw refused(NOT_DOWNLOADED, error);
  }
  if (!bytes) throw refused(NOT_DOWNLOADED);
  return bytes;
}

/** The ZIP as a source, only once it parses to the version's hash. */
async function openVerified(
  bytes: Uint8Array,
  bundleHash: string,
): Promise<PluginFileSource> {
  let source: PluginFileSource;
  let parsedHash: string;
  try {
    source = await createZipPluginFileSource(bytes);
    const parsed = await parsePluginBundle(source, { profile: IMPORT_PROFILE });
    parsedHash = parsed.bundleHash;
  } catch (error) {
    // Bytes that do not parse at all are not the version either.
    throw refused(MISMATCH, error);
  }
  if (parsedHash !== bundleHash) throw refused(MISMATCH);
  return source;
}

/**
 * Download the run's plugin version and check that it is that version.
 *
 * A lost lease throws `ReadinessLeaseLostError`, and the worker writes
 * nothing. Every other failure throws `ReadinessPackageUnreadableError`, and
 * the run fails with its message rather than grading without its package.
 */
export async function readRunPackage(
  lease: ReadinessLease,
): Promise<RunPackage> {
  const link = await requestBundleLink(lease);
  const bytes = await download(link);
  const source = await openVerified(bytes, link.version.bundleHash);
  return {
    source,
    // Read off the stored bytes: compressed size, raw entry names and
    // encryption flags, as the CLI reads them off a ZIP on disk.
    archive: await collectZipArchiveObservations(bytes),
    version: link.version,
  };
}
