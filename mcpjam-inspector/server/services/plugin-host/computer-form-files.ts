import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { FORM_FILE_RETENTION_MS } from "./form-file-journal.js";
import { PluginInvocationError } from "./invocation.js";
import type { PluginFormFileStore } from "./form-file-grants.js";
import type { ComputerFileSystem } from "./computer-file-target.js";

/** Where hosted form uploads land on the project's Computer. */
export const COMPUTER_FORM_UPLOAD_ROOT = "/home/user/.mcpjam/form-uploads";
const ENTRY = /^mcpjam-form-[0-9a-f-]{36}$/;
const MARKER = "ownership.json";
const SWEEP_LIMIT = 64;

const refuse = (): never => {
  throw new PluginInvocationError("FORM_FILE_UNAVAILABLE");
};
const isNotFound = (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  ((error as { name?: unknown }).name === "NotFoundError" ||
    /not found|no such file/i.test(String((error as Error).message ?? "")));

/**
 * Form uploads for a server running on the project's Computer: each upload
 * gets a private `mcpjam-form-<uuid>` folder under
 * `~/.mcpjam/form-uploads` with an `ownership.json` journal entry, so the
 * server reads the files at their VM paths. MCPJam keeps no Computer
 * connection after the request, so cleanup is a journal sweep: each later
 * upload removes this root's entries whose retention has passed (never a
 * folder without a valid entry).
 */
export function createComputerFormFileStore(
  files: () => Promise<ComputerFileSystem>,
  now: () => number = () => Date.now(),
): PluginFormFileStore & { sweep(): Promise<number> } {
  const sweep = async () => {
    const fs = await files();
    if (!fs.list) return 0;
    let entries: { name: string; type?: string }[];
    try {
      entries = await fs.list(COMPUTER_FORM_UPLOAD_ROOT);
    } catch (error) {
      if (isNotFound(error)) return 0;
      throw error;
    }
    let removed = 0;
    for (const entry of entries.slice(0, SWEEP_LIMIT)) {
      if (!ENTRY.test(entry.name) || (entry.type && entry.type !== "dir"))
        continue;
      const folder = posix.join(COMPUTER_FORM_UPLOAD_ROOT, entry.name);
      let expiresAt: unknown;
      try {
        const marker = JSON.parse(
          new TextDecoder().decode(
            await fs.read(posix.join(folder, MARKER), { format: "bytes" }),
          ),
        );
        expiresAt =
          marker?.version === 1 && marker?.name === entry.name
            ? marker.expiresAt
            : undefined;
      } catch {
        continue;
      }
      if (typeof expiresAt !== "number" || expiresAt > now()) continue;
      try {
        await fs.remove(folder);
        removed++;
      } catch {
        /* A later sweep retries. */
      }
    }
    return removed;
  };
  return {
    sweep,
    async start() {
      // Best effort: an unreachable sweep never blocks a new upload.
      try {
        await sweep();
      } catch {
        /* Retried by the next upload. */
      }
    },
    async reserve(_key, bytes) {
      const fs = await files();
      const name = `mcpjam-form-${randomUUID()}`;
      const root = posix.join(COMPUTER_FORM_UPLOAD_ROOT, name);
      await fs.makeDir?.(root);
      const createdAt = now();
      const marker = new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          name,
          createdAt,
          expiresAt: createdAt + FORM_FILE_RETENTION_MS,
          bytes,
        }),
      );
      const data = new ArrayBuffer(marker.byteLength);
      new Uint8Array(data).set(marker);
      await fs.write(posix.join(root, MARKER), data);
      const payload = posix.join(root, "files");
      await fs.makeDir?.(payload);
      // Removal happens through the retention sweep; no connection is kept.
      return { root, payload, release: async () => {} };
    },
    async makeDir(path) {
      await (await files()).makeDir?.(path);
    },
    async writeNew(path, bytes) {
      const fs = await files();
      try {
        await fs.getInfo(path);
        refuse();
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      const data = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(data).set(bytes);
      await fs.write(path, data);
    },
    join: (...parts) => posix.join(...parts),
  };
}
