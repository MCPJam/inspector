import { z } from "zod";
import type { WidgetHost } from "@mcpjam/widget-react";
import { OpenAIFileOpenParamsSchema } from "@openai/mcp-extensions/app";
import type {
  ThreadAppApi,
  ThreadAppDeclaration,
  ThreadAppHandle,
} from "./thread-app-api";

export type ChooseFileViewer = (
  entries: ThreadAppDeclaration[],
  signal: AbortSignal,
) => Promise<ThreadAppDeclaration | null>;

/** Paths are requests to the original admitted target, never browser authority. */
export function withLocalFileHost(
  host: WidgetHost,
  api: ThreadAppApi,
  handle: ThreadAppHandle,
  lifetime: AbortSignal,
  open: (entry: ThreadAppDeclaration) => Promise<void>,
  /** The same "Open with…" choice a file link offers when several match. */
  choose?: ChooseFileViewer,
): WidgetHost {
  if (!handle.localFilesAvailable) return host;
  return {
    ...host,
    resolvers: {
      ...host.resolvers,
      resolveEffectiveHostCapabilities(args) {
        const capabilities =
          host.resolvers.resolveEffectiveHostCapabilities(args);
        return {
          ...capabilities,
          experimental: { ...capabilities.experimental, "openai/files": {} },
        };
      },
    },
    services: {
      ...host.services,
      configureAppBridge(bridge, capabilities) {
        const cleanup = host.services.configureAppBridge?.(
          bridge,
          capabilities,
        );
        let live = true;
        if (capabilities.experimental?.["openai/files"])
          bridge.setRequestHandler(
            z.object({
              method: z.literal("openai/files/open"),
              params: OpenAIFileOpenParamsSchema,
            }),
            async (request, extra) => {
              const signal = AbortSignal.any([lifetime, extra.signal]);
              signal.throwIfAborted();
              if (!live) throw new Error("File viewer closed");
              const entries = await api.resolveLocalFile(
                handle,
                request.params.path,
                signal,
              );
              signal.throwIfAborted();
              if (!live) throw new Error("File viewer closed");
              if (entries.length === 0)
                throw new Error(
                  "No file viewer of this server accepts this file's extension.",
                );
              // Ambiguous targets need an explicit host chooser, never a guessed default.
              let entry: ThreadAppDeclaration | null = entries[0];
              if (entries.length > 1) {
                if (!choose) throw new Error("No unique file viewer available");
                entry = await choose(entries, signal);
                signal.throwIfAborted();
                if (!live) throw new Error("File viewer closed");
                if (!entry) throw new Error("No file viewer was chosen.");
              }
              await open(entry);
              signal.throwIfAborted();
              return {};
            },
          );
        return () => {
          live = false;
          cleanup?.();
        };
      },
    },
  };
}
