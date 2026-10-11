import { setTimeout as delay } from "node:timers/promises";
import { constants, watch } from "node:fs";
import { lstat, realpath, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import {
  ResourceGrantError,
  type BoundResourceAdapter,
} from "./resource-grants.js";

const contractSchema = z.object({
  version: z.literal(1),
  targets: z
    .array(
      z.object({
        serverId: z.string().min(1),
        root: z.string().min(1),
        exclusiveWrites: z.literal(true),
        resources: z
          .array(
            z.object({
              uri: z.string().min(1),
              relativePath: z.string().min(1),
            }),
          )
          .max(128),
      }),
    )
    .max(32),
});
const operatorRootsSchema = z
  .array(
    z.object({
      actorId: z.string().min(1),
      projectId: z.string().min(1),
      serverId: z.string().min(1),
      root: z.string().min(1),
    }),
  )
  .max(128);
/** User-editable host JSON can select a file, never grant local filesystem access. */
export function admitLocalFileTargetContract(
  contract: unknown,
  identity: { actorId: string; projectId: string; serverId: string },
  operatorRoots = process.env.MCPJAM_PLUGIN_LOCAL_FILE_ROOTS,
): unknown {
  if (contract === undefined || !operatorRoots) return undefined;
  let roots: z.infer<typeof operatorRootsSchema>;
  try {
    roots = operatorRootsSchema.parse(JSON.parse(operatorRoots));
  } catch {
    return undefined;
  }
  const parsed = contractSchema.safeParse(contract);
  if (!parsed.success) return undefined;
  const targets = parsed.data.targets.filter(
    (target) =>
      target.serverId === identity.serverId &&
      roots.some(
        (root) =>
          root.actorId === identity.actorId &&
          root.projectId === identity.projectId &&
          root.serverId === identity.serverId &&
          root.root === target.root,
      ),
  );
  return targets.length ? { version: 1, targets } : undefined;
}
export interface LocalFileTarget {
  root: string;
  relativePath: string;
  uri: string;
  exclusiveWrites: true;
}
/** Operator-owned host configuration, never a request path or MCP metadata. */
export function resolveLocalFileTarget(
  contract: unknown,
  serverId: string,
  uri: string,
): LocalFileTarget | undefined {
  if (contract === undefined) return undefined;
  const parsed = contractSchema.safeParse(contract);
  if (!parsed.success) throw new ResourceGrantError("RESOURCE_DENIED");
  const matches = parsed.data.targets.flatMap((target) =>
    target.serverId === serverId
      ? target.resources
          .filter((resource) => resource.uri === uri)
          .map((resource) => ({
            root: target.root,
            ...resource,
            exclusiveWrites: true as const,
          }))
      : [],
  );
  if (matches.length > 1) throw new ResourceGrantError("RESOURCE_DENIED");
  const result = matches[0];
  if (!result) return undefined;
  if (
    !path.isAbsolute(result.root) ||
    result.relativePath.includes("\\") ||
    result.relativePath.includes("\0") ||
    result.relativePath
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    path.isAbsolute(result.relativePath)
  )
    throw new ResourceGrantError("RESOURCE_DENIED");
  return result;
}
export function resolveLocalFilePath(
  contract: unknown,
  serverId: string,
  requestedPath: string,
): LocalFileTarget | undefined {
  if (!path.isAbsolute(requestedPath) || contract === undefined)
    return undefined;
  const parsed = contractSchema.safeParse(contract);
  if (!parsed.success) throw new ResourceGrantError("RESOURCE_DENIED");
  const candidates = parsed.data.targets.flatMap((target) =>
    target.serverId === serverId
      ? target.resources
          .filter(
            (resource) =>
              path.join(target.root, resource.relativePath) === requestedPath,
          )
          .map(
            (resource) =>
              resolveLocalFileTarget(contract, serverId, resource.uri)!,
          )
      : [],
  );
  if (candidates.length > 1) throw new ResourceGrantError("RESOURCE_DENIED");
  return candidates[0];
}
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** CAS is guaranteed among writers honoring the explicit exclusive-root contract. */
export function createLocalFileTargetAdapter(
  target: LocalFileTarget,
  maxBytes = 1024 * 1024,
): BoundResourceAdapter {
  const absolute = path.join(target.root, target.relativePath);
  const validate = async () => {
    if ((await realpath(target.root)) !== path.resolve(target.root))
      throw new ResourceGrantError("RESOURCE_DENIED");
    let current = target.root;
    for (const part of target.relativePath.split("/")) {
      current = path.join(current, part);
      if ((await lstat(current)).isSymbolicLink())
        throw new ResourceGrantError("RESOURCE_DENIED");
    }
    const stat = await lstat(absolute);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
      throw new ResourceGrantError("RESOURCE_DENIED");
  };
  const read = async (key: string, signal: AbortSignal) => {
    if (key !== target.uri) throw new ResourceGrantError("RESOURCE_DENIED");
    signal.throwIfAborted();
    await validate();
    const file = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maxBytes || stat.nlink !== 1)
        throw new ResourceGrantError("RESOURCE_DENIED");
      const bytes = await file.readFile();
      if (bytes.length > maxBytes)
        throw new ResourceGrantError("RESOURCE_TOO_LARGE");
      signal.throwIfAborted();
      return { bytes, etag: digest(bytes) };
    } finally {
      await file.close();
    }
  };
  return {
    read,
    async conditionalWrite(key, bytes, ifMatch, signal) {
      if (key !== target.uri || bytes.byteLength > maxBytes)
        throw new ResourceGrantError("RESOURCE_DENIED");
      await validate();
      const lockPath = path.join(
        path.dirname(absolute),
        ".mcpjam-cas-" + digest(new TextEncoder().encode(absolute)),
      );
      const deadline = Date.now() + 3000;
      const acquire = async () => {
        for (;;) {
          signal.throwIfAborted();
          try {
            return await open(lockPath, "wx", 0o600);
          } catch (error) {
            if (
              (error as NodeJS.ErrnoException).code !== "EEXIST" ||
              Date.now() >= deadline
            )
              throw error;
            await delay(25, undefined, { signal });
          }
        }
      };
      const lock = await acquire();
      const temporary = path.join(
        path.dirname(absolute),
        ".mcpjam-save-" + randomUUID(),
      );
      try {
        const previous = await read(key, signal);
        if (ifMatch !== undefined && ifMatch !== previous.etag)
          return { outcome: "conflict", etag: previous.etag };
        const output = await open(temporary, "wx", 0o600);
        try {
          await output.writeFile(bytes);
          await output.sync();
        } finally {
          await output.close();
        }
        signal.throwIfAborted();
        await validate();
        const last = await read(key, signal);
        if (last.etag !== previous.etag)
          return { outcome: "conflict", etag: last.etag };
        await rename(temporary, absolute);
        return { outcome: "saved", etag: digest(bytes) };
      } finally {
        await unlink(temporary).catch(() => {});
        await lock.close();
        await unlink(lockPath);
      }
    },
    async watch(key, changed, signal) {
      if (key !== target.uri) throw new ResourceGrantError("RESOURCE_DENIED");
      await validate();
      const observer = watch(path.dirname(absolute), (_event, filename) => {
        if (!signal.aborted && filename === path.basename(absolute)) changed();
      });
      const stop = () => observer.close();
      observer.on("error", stop);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
      return () => {
        signal.removeEventListener("abort", stop);
        stop();
      };
    },
  };
}
