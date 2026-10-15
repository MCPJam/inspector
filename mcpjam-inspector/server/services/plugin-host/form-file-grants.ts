import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../../utils/logger.js";
import { pluginBindingDigest } from "./bindings.js";
import {
  PluginInvocationError,
  type TrustedInvocationOwner,
} from "./invocation.js";
import type { PluginFormSource } from "./form-sources.js";
import {
  FORM_FILE_DIRECTORY,
  FORM_FILE_RETENTION_MS,
  PluginFormFileJournal,
  type FilePlacement,
} from "./form-file-journal.js";
import {
  compilePluginForm,
  ownedPluginFormProfile,
  pluginFormResources,
  validatePluginFormContent,
} from "../../../shared/plugin-extensions/form-plan.js";
import {
  PLUGIN_FORM_FILE_MAX_BYTES,
  PLUGIN_FORM_FILE_BATCH_MAX_BYTES,
  PLUGIN_FORM_FILE_MAX_COUNT,
  pluginFormDirectoryPaths,
} from "../../../shared/plugin-form-services.js";

export type PluginFormUploadFile = {
  name: string;
  type: string;
  bytes: Uint8Array;
  relativePath?: string;
};
/** Where uploaded bytes are placed: this machine's private journal (local
 * stdio servers), or the project's Computer (hosted servers running there).
 * New files only, under a reserved private folder; no arbitrary path API. */
export interface PluginFormFileStore {
  reserve(
    key: string,
    bytes: number,
  ): Promise<{ root: string; payload: string; release(): Promise<void> }>;
  makeDir(path: string): Promise<void>;
  /** Exclusive create: fails when the path already exists. */
  writeNew(path: string, bytes: Uint8Array): Promise<void>;
  join(...parts: string[]): string;
  /** Called before the first placement (the local journal's sweep). */
  start?(): Promise<unknown>;
}
type Grant = {
  source: PluginFormSource;
  token: string;
  field: string;
  operationId: string;
  fingerprint: string;
  bytes: number;
  uris: string[];
  paths: string[];
  root?: string;
  release?: () => Promise<void>;
  promoted: boolean;
  closed: boolean;
  ready: Promise<void>;
  expiry: ReturnType<typeof setTimeout>;
  detach: () => void;
};
const refuse = (): never => {
  throw new PluginInvocationError("FORM_FILE_UNAVAILABLE");
};
const same = (a: unknown, b: unknown) =>
  pluginBindingDigest(a) === pluginBindingDigest(b);
export function formUploadInput(source: PluginFormSource, fieldName: string) {
  if (
    source.uploadTarget !== "local-stdio" &&
    source.uploadTarget !== "computer"
  )
    refuse();
  const plan = compilePluginForm(
    source.requestedSchema,
    ownedPluginFormProfile(
      source.fileResources === true,
      source.origin === "app" ? "mcp-app" : "server",
      true,
    ),
  );
  const field = plan.fields.find(({ name }) => name === fieldName)?.field;
  const input = field && pluginFormResources(field);
  if (
    !field ||
    !input ||
    (input.selection !== "implicit" && !input.userOptions)
  )
    return refuse();
  return { plan, field, input };
}
/** HTML `accept` tokens: a filename extension, a MIME type, or a MIME
 * wildcard. Both compare case-insensitively, as the browser picker does. */
export function pluginFormFileAccepted(
  file: Pick<PluginFormUploadFile, "name" | "type">,
  accept?: readonly string[],
) {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return (
    !accept?.length ||
    accept.some((token) => {
      const value = token.trim().toLowerCase();
      return value.startsWith(".")
        ? name.endsWith(value)
        : value.endsWith("/*")
          ? type.startsWith(value.slice(0, -1))
          : !!value && type === value;
    })
  );
}
const accepts = pluginFormFileAccepted;

/** Exclusive new files in the original local process namespace. No arbitrary path API.
 * Browser URIs are opaque; file: URIs are disclosed only on the original MCP wire.
 * Bounded process-local receipts, durable cleanup ownership before user bytes.
 * Restart preserves uncertain consumption until retention and revives no grants.
 */
export class PluginFormFileGrants {
  private readonly records = new Map<string, Grant>();
  private readonly deleting = new Set<Promise<void>>();
  private readonly journal: PluginFormFileJournal;
  private startup?: Promise<unknown>;
  private janitor?: ReturnType<typeof setInterval>;
  private readonly local: PluginFormFileStore;
  constructor(base = FORM_FILE_DIRECTORY) {
    this.journal = new PluginFormFileJournal(base);
    this.local = {
      start: () => this.start(),
      reserve: async (key, bytes) => {
        const placement: FilePlacement = await this.journal.reserve(key, bytes);
        return {
          root: placement.root,
          payload: placement.payload,
          release: () => this.journal.release(placement),
        };
      },
      makeDir: async (path) => {
        await mkdir(path, { recursive: true, mode: 0o700 });
      },
      writeNew: (path, bytes) =>
        writeFile(path, bytes, { flag: "wx", mode: 0o600 }),
      join: (...parts) => join(...parts),
    };
  }
  start() {
    this.startup ??= this.journal.sweep().then((result) => {
      this.reportSweep(result);
      this.janitor = setInterval(() => {
        void this.journal
          .sweep()
          .then((value) => this.reportSweep(value))
          .catch(() => {
            logger.warn("[plugin-forms] upload journal cleanup failed");
          });
      }, 60_000);
      this.janitor.unref();
      return result;
    });
    return this.startup;
  }
  private reportSweep(
    result: Awaited<ReturnType<PluginFormFileJournal["sweep"]>>,
  ) {
    if (result.refused || result.overflow)
      logger.warn("[plugin-forms] upload journal entries retained", result);
  }
  async upload(input: {
    source: PluginFormSource;
    token: string;
    field: string;
    operationId: string;
    files: PluginFormUploadFile[];
    sourceSignal: AbortSignal;
    authorize: () => Promise<unknown>;
    signal: AbortSignal;
    /** Defaults to this machine's private journal (local stdio servers). */
    store?: PluginFormFileStore;
  }) {
    const { source, signal } = input;
    const store = input.store ?? this.local;
    const { field, input: picker } = formUploadInput(source, input.field);
    const directory = picker.userOptions?.kind === "directory";
    const files = directory
      ? [...input.files].sort((a, b) =>
          (a.relativePath ?? "") < (b.relativePath ?? "")
            ? -1
            : (a.relativePath ?? "") > (b.relativePath ?? "")
            ? 1
            : 0,
        )
      : input.files;
    let hierarchy: string[][] = [];
    try {
      if (directory) hierarchy = pluginFormDirectoryPaths(files);
      else if (files.some((file) => file.relativePath !== undefined)) refuse();
    } catch {
      refuse();
    }
    const bytes = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    if (
      !files.length ||
      files.length > PLUGIN_FORM_FILE_MAX_COUNT ||
      (!directory && field.type === "string" && files.length !== 1) ||
      bytes > PLUGIN_FORM_FILE_BATCH_MAX_BYTES ||
      files.some(
        (file) =>
          file.bytes.byteLength > PLUGIN_FORM_FILE_MAX_BYTES ||
          !file.name.trim() ||
          Buffer.byteLength(file.name) > 255 ||
          /[\/\\\0]/.test(file.name) ||
          [".", ".."].includes(file.name) ||
          file.type.length > 256 ||
          !accepts(file, picker.userOptions?.accept),
      )
    )
      refuse();
    signal.throwIfAborted();
    input.sourceSignal.throwIfAborted();
    await input.authorize();
    signal.throwIfAborted();
    await store.start?.();
    signal.throwIfAborted();
    input.sourceSignal.throwIfAborted();
    const key = pluginBindingDigest([
      source.owner,
      source.invocationId,
      input.token,
      input.operationId,
    ]);
    const fingerprint = pluginBindingDigest([
      input.field,
      files.map((file) => [
        file.name,
        file.type,
        file.relativePath,
        createHash("sha256").update(file.bytes).digest("hex"),
      ]),
    ]);
    let grant = this.records.get(key);
    if (
      grant &&
      (!same(grant.source, source) ||
        grant.fingerprint !== fingerprint ||
        grant.closed)
    )
      refuse();
    if (!grant) {
      const owned = [...this.records.values()].filter(
        (record) =>
          same(record.source.owner, source.owner) &&
          record.source.invocationId === source.invocationId,
      );
      if (
        this.records.size >= 128 ||
        owned.length >= 16 ||
        owned.reduce((sum, record) => sum + record.bytes, bytes) >
          8 * 1024 * 1024 ||
        [...this.records.values()].reduce(
          (sum, record) => sum + record.bytes,
          bytes,
        ) >
          32 * 1024 * 1024
      )
        refuse();
      grant = {
        source: structuredClone(source),
        token: input.token,
        field: input.field,
        operationId: input.operationId,
        fingerprint,
        bytes,
        uris: (directory ? [files[0]!] : files).map(
          () => `mcpjam-form-file://${randomUUID()}`,
        ),
        paths: [],
        promoted: false,
        closed: false,
        ready: Promise.resolve(),
        expiry: setTimeout(() => this.remove(key), FORM_FILE_RETENTION_MS),
        detach: () => {},
      };
      grant.expiry.unref();
      this.records.set(key, grant);
      const record = grant;
      const close = () => {
        if (!record.promoted) this.remove(key);
      };
      input.sourceSignal.addEventListener("abort", close, { once: true });
      record.detach = () =>
        input.sourceSignal.removeEventListener("abort", close);
      record.ready = (async () => {
        const placement = await store.reserve(key, bytes);
        record.release = placement.release;
        record.root = placement.root;
        const payload = placement.payload;
        if (directory) {
          const directoryRoot = store.join(payload, randomUUID());
          await store.makeDir(directoryRoot);
          for (let index = 0; index < files.length; index++) {
            if (record.closed) refuse();
            const parts = hierarchy[index]!;
            await store.makeDir(store.join(directoryRoot, ...parts.slice(0, -1)));
            await store.writeNew(
              store.join(directoryRoot, ...parts),
              files[index]!.bytes,
            );
          }
          record.paths.push(store.join(directoryRoot, hierarchy[0]![0]!));
          return;
        }
        for (const file of files) {
          if (record.closed) refuse();
          const fileDirectory = store.join(payload, randomUUID());
          await store.makeDir(fileDirectory);
          const path = store.join(fileDirectory, file.name);
          await store.writeNew(path, file.bytes);
          record.paths.push(path);
        }
      })();
    }
    try {
      await grant.ready;
      await input.authorize();
      signal.throwIfAborted();
      input.sourceSignal.throwIfAborted();
      if (grant.closed) refuse();
      return { uris: [...grant.uris] };
    } catch (error) {
      // Loss of response alone does not remove an admitted receipt. A failed
      // authorization/read/placement does: no answer has been delivered yet.
      if (!grant.promoted) this.remove(key);
      throw error;
    }
  }

  prepareDelivery(
    source: PluginFormSource,
    token: string,
    content: Record<string, unknown>,
  ) {
    const plan = compilePluginForm(
      source.requestedSchema,
      ownedPluginFormProfile(
        source.fileResources === true,
        source.origin === "app" ? "mcp-app" : "server",
        true,
      ),
    );
    if (!validatePluginFormContent(plan, content).valid) refuse();
    const result = structuredClone(content);
    const selected = new Set<Grant>();
    for (const { name, field } of plan.fields) {
      const picker = pluginFormResources(field);
      if (!picker || !Object.hasOwn(content, name)) continue;
      const values = Array.isArray(content[name])
        ? content[name]
        : [content[name]];
      const translated = values.map((uri) => {
        if (picker.options.some((option) => option.uri === uri)) return uri;
        const grant = [...this.records.values()].find(
          (record) =>
            !record.closed &&
            record.token === token &&
            record.field === name &&
            same(record.source, source) &&
            record.uris.includes(uri as string),
        );
        if (!grant || !grant.root || grant.paths.length !== grant.uris.length)
          return refuse();
        selected.add(grant);
        return pathToFileURL(grant.paths[grant.uris.indexOf(uri as string)]!)
          .href;
      });
      result[name] = field.type === "array" ? translated : translated[0];
    }
    return {
      content: result,
      hasUploads: selected.size > 0,
      assertReady: () => {
        for (const grant of selected) if (grant.closed) refuse();
      },
      commit: () => {
        for (const grant of selected) grant.promoted = true;
      },
    };
  }
  deliver(
    source: PluginFormSource,
    token: string,
    content: Record<string, unknown>,
  ) {
    const prepared = this.prepareDelivery(source, token, content);
    prepared.assertReady();
    prepared.commit();
    return prepared.content;
  }
  closeOperation(owner: TrustedInvocationOwner, invocationId: string) {
    for (const [key, grant] of this.records)
      if (
        same(grant.source.owner, owner) &&
        grant.source.invocationId === invocationId
      )
        this.remove(key);
  }
  /** Only after authenticated durable cancellation confirmation. */
  closeSettledMrtrParent(id: string) {
    for (const [key, grant] of this.records)
      if (grant.source.parent.kind === "mrtr" && grant.source.parent.id === id)
        this.remove(key);
  }
  closeOwner(owner: TrustedInvocationOwner) {
    for (const [key, grant] of this.records)
      if (same(grant.source.owner, owner)) this.remove(key);
  }
  private remove(key: string) {
    const grant = this.records.get(key);
    if (!grant || grant.closed) return;
    grant.closed = true;
    grant.detach();
    clearTimeout(grant.expiry);
    const cleanup = grant.ready
      .catch(() => {})
      .then(async () => {
        if (grant.release) await grant.release();
      })
      .catch(() => {
        logger.warn("[plugin-forms] temporary file cleanup failed");
      })
      .finally(() => {
        if (this.records.get(key) === grant) this.records.delete(key);
        this.deleting.delete(cleanup);
      });
    this.deleting.add(cleanup);
  }
  async drain() {
    await Promise.all([...this.deleting]);
  }
}
export const pluginFormFileGrants = new PluginFormFileGrants();
/** Called after environment loading in both local product server entrypoints. */
export function startPluginFormFileJanitor() {
  return pluginFormFileGrants.start().catch(() => {
    logger.warn("[plugin-forms] upload journal startup failed");
  });
}
