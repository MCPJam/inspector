import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Sandbox } from "e2b";
import { confineToHome } from "../../utils/computers/path-confine.js";
import {
  ensureComputerReady,
  getComputerSandboxInfo,
  isComputersDataPlaneConfigured,
} from "../../utils/computers/control-plane-client.js";
import type { ExecutionScope } from "../../utils/execution-scope.js";
import {
  ResourceGrantError,
  type BoundResourceAdapter,
} from "./resource-grants.js";
import {
  resolveLocalFilePath,
  resolveLocalFileTarget,
  type LocalFileTarget,
} from "./local-file-target.js";
import { PluginFileTargetRefusal } from "./file-target-refusal.js";

/**
 * File targets on the project's Computer (hosted MCPJam, with the MCP server
 * running on that Computer): the paths a plugin's "dedicated tools" see are
 * on the VM, so reads and writes go through the sandbox filesystem API, never
 * the Inspector container's disk.
 *
 * Paths are confined to the box home with the same helper the Computer upload
 * route uses. As there, this is hygiene rather than a trust boundary: whoever
 * can run this server on the Computer already has its shell.
 */

/** Narrow structural view of the E2B sandbox filesystem (`Sandbox.files`
 * satisfies it), so tests inject a fake without the vendor SDK. */
export interface ComputerFileSystem {
  read(
    path: string,
    opts: { format: "bytes"; signal?: AbortSignal },
  ): Promise<Uint8Array>;
  write(
    path: string,
    data: ArrayBuffer,
    opts?: { signal?: AbortSignal },
  ): Promise<unknown>;
  getInfo(
    path: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ type?: string; size: number; symlinkTarget?: string }>;
  rename(
    from: string,
    to: string,
    opts?: { signal?: AbortSignal },
  ): Promise<unknown>;
  remove(path: string, opts?: { signal?: AbortSignal }): Promise<void>;
  makeDir?(path: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
  list?(
    path: string,
    opts?: { signal?: AbortSignal },
  ): Promise<{ name: string; type?: string }[]>;
}

export type ComputerFileSystemConnector = (input: {
  bearer: string;
  projectId: string;
  executionScope?: ExecutionScope;
  signal?: AbortSignal;
}) => Promise<ComputerFileSystem>;

/** The project's Computer is asleep, still provisioning, or unreachable. */
export class PluginComputerUnavailableError extends PluginFileTargetRefusal {
  constructor(serverId: string) {
    super(
      "PLUGIN_COMPUTER_UNAVAILABLE",
      serverId,
      "Couldn't reach the project's Computer",
      undefined,
      503,
    );
  }
}

/** Connect to the caller's own project Computer without a long wake: a
 * Computer running this server is already awake, so a slow answer means it
 * is asleep or unreachable, which is reported rather than waited out. */
export function createProjectComputerConnector(
  serverId: string,
  deps: {
    ready?: typeof ensureComputerReady;
    info?: typeof getComputerSandboxInfo;
    connect?: (sandboxId: string) => Promise<ComputerFileSystem>;
    configured?: () => boolean;
  } = {},
): ComputerFileSystemConnector {
  const ready = deps.ready ?? ensureComputerReady;
  const info = deps.info ?? getComputerSandboxInfo;
  const connect =
    deps.connect ??
    (async (sandboxId: string) =>
      (await Sandbox.connect(sandboxId)).files as unknown as ComputerFileSystem);
  const configured = deps.configured ?? isComputersDataPlaneConfigured;
  return async (input) => {
    const unavailable = () => new PluginComputerUnavailableError(serverId);
    if (!configured()) throw unavailable();
    try {
      const reserved = await ready({
        bearer: input.bearer,
        projectId: input.projectId,
        ...(input.executionScope
          ? { executionScope: input.executionScope }
          : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        timeoutMs: 10_000,
      });
      if (!reserved.ok) throw unavailable();
      const sandbox = await info({
        computerId: reserved.value.computerId,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!sandbox.ok || !sandbox.value.providerComputerId) throw unavailable();
      return await connect(sandbox.value.providerComputerId);
    } catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof PluginComputerUnavailableError) throw error;
      throw unavailable();
    }
  };
}

/** Hosted, with the client's Computer attached and a saved stdio server
 * (which hosted MCPJam can only run on that Computer). */
export function pluginComputerUploadsAvailable(input: {
  hosted: boolean;
  computer: boolean;
  transport?: string;
}) {
  return input.hosted && input.computer && input.transport === "stdio";
}

const contractRoots = (contract: unknown) =>
  contract && typeof contract === "object"
    ? (contract as { targets?: unknown }).targets
    : undefined;

/** Computer targets need no operator allowlist (the VM is the caller's own),
 * but every root must already be a normalized path under the box home. */
export function admitComputerFileTargetContract(
  contract: unknown,
  serverId: string,
): unknown {
  const targets = contractRoots(contract);
  if (!Array.isArray(targets)) return undefined;
  const admitted = targets.filter(
    (target) =>
      !!target &&
      typeof target === "object" &&
      (target as { serverId?: unknown }).serverId === serverId &&
      typeof (target as { root?: unknown }).root === "string" &&
      confineToHome((target as { root: string }).root) ===
        (target as { root: string }).root,
  );
  if (!admitted.length) return undefined;
  const candidate = { version: 1, targets: admitted };
  // Same grammar as local targets; anything malformed is refused whole.
  try {
    for (const target of admitted as { resources?: { uri: string }[] }[])
      for (const resource of target.resources ?? [])
        resolveLocalFileTarget(candidate, serverId, resource.uri);
  } catch {
    return undefined;
  }
  return candidate;
}

/** Resolve a path the App asked to open, on the VM, within the admitted roots. */
export function resolveComputerFilePath(
  contract: unknown,
  serverId: string,
  requestedPath: string,
): LocalFileTarget | undefined {
  if (confineToHome(requestedPath) !== requestedPath) return undefined;
  return resolveLocalFilePath(contract, serverId, requestedPath);
}

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** One writer per VM path in this process; the etag is rechecked right
 * before the replace, which narrows (but cannot close) the window against
 * writers outside this process. */
const pathLocks = new Map<string, Promise<unknown>>();
async function withPathLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = pathLocks.get(key) ?? Promise.resolve();
  const current = previous.then(run, run);
  const settled = current.then(
    () => {},
    () => {},
  );
  pathLocks.set(key, settled);
  try {
    return await current;
  } finally {
    if (pathLocks.get(key) === settled) pathLocks.delete(key);
  }
}

const isNotFound = (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  ((error as { name?: unknown }).name === "NotFoundError" ||
    /not found|no such file/i.test(String((error as Error).message ?? "")));

/** The VM path for a target (also the trusted `_meta["openai/resource"].path`). */
export function computerFilePath(target: LocalFileTarget) {
  return posix.join(target.root, target.relativePath);
}

/**
 * Read and compare-then-write one admitted file on the Computer. `files`
 * returns this request's sandbox connection; the adapter retains none.
 */
export function createComputerFileTargetAdapter(
  target: LocalFileTarget,
  files: (signal: AbortSignal) => Promise<ComputerFileSystem>,
  maxBytes = 1024 * 1024,
): BoundResourceAdapter & {
  check(signal: AbortSignal): Promise<void>;
} {
  const absolute = computerFilePath(target);
  const confined = confineToHome(absolute) === absolute;
  const vm = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof ResourceGrantError ||
        error instanceof PluginComputerUnavailableError
      )
        throw error;
      if (isNotFound(error)) throw new ResourceGrantError("RESOURCE_DENIED");
      throw new ResourceGrantError("RESOURCE_OUTCOME_UNKNOWN");
    }
  };
  const validate = async (fs: ComputerFileSystem, signal: AbortSignal) => {
    if (!confined) throw new ResourceGrantError("RESOURCE_DENIED");
    const info = await vm(() => fs.getInfo(absolute, { signal }));
    if (info.symlinkTarget || (info.type !== undefined && info.type !== "file"))
      throw new ResourceGrantError("RESOURCE_DENIED");
    if (info.size > maxBytes) throw new ResourceGrantError("RESOURCE_TOO_LARGE");
  };
  const readWith = async (fs: ComputerFileSystem, signal: AbortSignal) => {
    await validate(fs, signal);
    const bytes = await vm(() =>
      fs.read(absolute, { format: "bytes", signal }),
    );
    if (bytes.byteLength > maxBytes)
      throw new ResourceGrantError("RESOURCE_TOO_LARGE");
    signal.throwIfAborted();
    return { bytes, etag: digest(bytes) };
  };
  return {
    async check(signal) {
      await validate(await files(signal), signal);
    },
    async read(key, signal) {
      if (key !== target.uri) throw new ResourceGrantError("RESOURCE_DENIED");
      signal.throwIfAborted();
      return readWith(await files(signal), signal);
    },
    async conditionalWrite(key, bytes, ifMatch, signal) {
      if (key !== target.uri || bytes.byteLength > maxBytes)
        throw new ResourceGrantError("RESOURCE_DENIED");
      const fs = await files(signal);
      return withPathLock(absolute, async () => {
        const previous = await readWith(fs, signal);
        if (ifMatch !== undefined && ifMatch !== previous.etag)
          return { outcome: "conflict" as const, etag: previous.etag };
        const temporary = posix.join(
          posix.dirname(absolute),
          `.mcpjam-save-${randomUUID()}`,
        );
        try {
          const data = new ArrayBuffer(bytes.byteLength);
          new Uint8Array(data).set(bytes);
          await vm(() => fs.write(temporary, data, { signal }));
          signal.throwIfAborted();
          const last = await readWith(fs, signal);
          if (last.etag !== previous.etag)
            return { outcome: "conflict" as const, etag: last.etag };
          await vm(() => fs.rename(temporary, absolute, { signal }));
          return { outcome: "saved" as const, etag: digest(bytes) };
        } finally {
          await fs.remove(temporary).catch(() => {});
        }
      });
    },
  };
}
