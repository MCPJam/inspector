import {
  pluginFileNameMatchesExtension,
  pluginFileOpenParamsSchema,
} from "../../../shared/plugin-file.js";
import {
  pluginFileEntrypoints,
  type PluginEntrypointTool,
} from "../../../shared/plugin-activation.js";
import { pluginBindingDigest } from "./bindings.js";
import { waitForPluginOperation } from "../../../shared/plugin-operation.js";
import type { TrustedInvocationOwner } from "./invocation.js";
import type { TrustedPluginFileResource } from "./file-resource-session.js";

/** Shared host service: one source instance, existing target, explicit lifetime. */
export function createPluginFileOpenSession(options: {
  owner: Readonly<TrustedInvocationOwner>;
  enabled: () => boolean;
  authorize: (signal: AbortSignal) => Promise<{ revision: string }>;
  listTools: (
    cursor: string | undefined,
    signal: AbortSignal,
  ) => Promise<{ tools: PluginEntrypointTool[]; nextCursor?: string }>;
  resolveFile: (
    owner: Readonly<TrustedInvocationOwner>,
    path: string,
    signal: AbortSignal,
  ) => Promise<TrustedPluginFileResource>;
  openFile: (
    toolName: string,
    resource: TrustedPluginFileResource,
    signal: AbortSignal,
    requireSource: () => Promise<void>,
  ) => Promise<void>;
}) {
  const owner = Object.freeze({ ...options.owner });
  const receipts = new Map<
    string,
    { digest: string; revision: string; result: Promise<Record<string, never>> }
  >();
  const stopped = new AbortController();
  let closed = false;
  const authorize = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (closed || !options.enabled())
      throw new Error("RUN_FILES_OPEN_UNAVAILABLE");
    const admission = await options.authorize(signal);
    signal.throwIfAborted();
    if (closed || !options.enabled())
      throw new Error("RUN_FILES_OPEN_UNAVAILABLE");
    return admission;
  };
  return {
    async open(
      operationId: string,
      value: unknown,
      requestSignal: AbortSignal,
    ) {
      const signal = AbortSignal.any([stopped.signal, requestSignal]);
      const params = pluginFileOpenParamsSchema.parse(value);
      return waitForPluginOperation(signal, async () => {
        const admission = await authorize(signal);
        const requireSource = async () => {
          if ((await authorize(signal)).revision !== admission.revision)
            throw new Error("RUN_FILE_SOURCE_CHANGED");
        };
        const digest = pluginBindingDigest(params);
        const existing = receipts.get(operationId);
        if (existing) {
          if (existing.digest !== digest)
            throw new Error("RUN_FILE_OPEN_OPERATION_REUSED");
          if (existing.revision !== admission.revision)
            throw new Error("RUN_FILE_SOURCE_CHANGED");
          const result = await existing.result;
          await requireSource();
          return result;
        }
        if (receipts.size >= 2048)
          throw new Error("RUN_FILE_OPEN_OPERATION_LIMIT");
        // Failed and unknown receipts also remain: this operation never repeats an effect.
        const result = (async () => {
          const resource = await waitForPluginOperation(signal, () =>
            options.resolveFile(owner, params.path, signal),
          );
          await requireSource();
          let cursor: string | undefined;
          const matches = new Set<string>();
          for (let page = 0; page < 64; page++) {
            const catalog = await options.listTools(cursor, signal);
            signal.throwIfAborted();
            for (const entry of pluginFileEntrypoints(catalog.tools))
              if (
                entry.extensions.some((extension) =>
                  pluginFileNameMatchesExtension(resource.name, extension),
                )
              )
                matches.add(entry.toolName);
            if (!catalog.nextCursor) {
              cursor = undefined;
              break;
            }
            cursor = catalog.nextCursor;
          }
          if (cursor || matches.size !== 1)
            throw new Error("RUN_FILE_VIEWER_UNAVAILABLE");
          await requireSource();
          await options.openFile(
            [...matches][0],
            resource,
            signal,
            requireSource,
          );
          await requireSource();
          return {};
        })();
        receipts.set(operationId, {
          digest,
          revision: admission.revision,
          result,
        });
        return result;
      });
    },
    close() {
      closed = true;
      stopped.abort();
      receipts.clear();
    },
  };
}
