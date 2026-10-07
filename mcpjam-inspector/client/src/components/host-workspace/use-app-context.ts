import { useEffect, useMemo, useState } from "react";
import type { WidgetHost } from "@mcpjam/widget-react";
import {
  pluginContextAttachments,
  type PluginContextSnapshot,
} from "@/shared/plugin-model-context";
import type {
  ContextAttachment,
  ContextAttachmentBlock,
} from "../chat-v2/chat-input/attachments/context-attachment-chip";
import type { PluginIcons } from "@/lib/plugins/plugin-api-types";
import { createModelContextController } from "./model-context-controller";
import {
  createThreadAppApi,
  type ThreadAppHandle,
  type ThreadAppScope,
} from "./thread-app-api";

const EMPTY: PluginContextSnapshot = { revision: 0, sequence: 0, state: null };
const REMOVE_ALL = "*";

type ContextItem = ReturnType<typeof pluginContextAttachments>[number];

function plainJson(text: string) {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}
function thumbnailSource(icon: unknown) {
  const src =
    icon && typeof icon === "object" ? (icon as { src?: unknown }).src : "";
  return typeof src === "string" &&
    (src.startsWith("https:") || /^data:image\/[^;]+;base64,/i.test(src))
    ? src
    : undefined;
}

/**
 * Presentation for one context block in its App's Context popover: text
 * shows title and text, resource link and embedded resource show title and
 * URI, image shows title, format and a thumbnail. Untitled text gets a short
 * plain label, and JSON never becomes a label or a preview.
 */
export function appContextBlock(item: ContextItem): {
  title: string;
  block: ContextAttachmentBlock;
} {
  const raw = item.block;
  const titled =
    typeof raw?._meta?.["openai/title"] === "string" &&
    raw._meta["openai/title"].trim()
      ? raw._meta["openai/title"].trim().slice(0, 256)
      : undefined;
  if (!raw) return { title: "App context", block: { kind: "structured" } };
  if (raw.type === "text") {
    const json = plainJson(raw.text);
    return {
      title: titled ?? (json ? "Structured data" : "Text"),
      block: {
        kind: "text",
        ...(json ? {} : { detail: raw.text.slice(0, 280) }),
        thumbnail: thumbnailSource(raw._meta?.["openai/thumbnail"]),
      },
    };
  }
  if (raw.type === "resource_link")
    return { title: item.title, block: { kind: "resource_link", detail: raw.uri } };
  if (raw.type === "resource")
    return {
      title: titled ?? "Data",
      block: {
        kind: "resource",
        detail: raw.resource.uri,
        ...(item.image
          ? {
              thumbnail: `data:${item.image.mimeType};base64,${item.image.data}`,
            }
          : {}),
      },
    };
  return {
    title: titled ?? "Image",
    block: {
      kind: "image",
      format: item.image?.mimeType.replace(/^image\//, "").toUpperCase(),
      ...(item.image
        ? { thumbnail: `data:${item.image.mimeType};base64,${item.image.data}` }
        : {}),
    },
  };
}

/** Mounted for the retained instance, not for panel visibility. */
export function useAppContext(
  scope: ThreadAppScope,
  handle: ThreadAppHandle,
  routePrefix = "",
  /** Chip presentation only: the plugin (server) the App belongs to. */
  presentation: {
    serverName?: string;
    icons?: PluginIcons;
    /** The server's icons (`server/discover`, else `initialize`). */
    serverIcons?: readonly unknown[];
  } = {},
) {
  const key = JSON.stringify([scope, handle.instanceToken, handle.generation, routePrefix]);
  const [value, setValue] = useState({
    key,
    snapshot: handle.contextSnapshot ?? EMPTY,
  });
  const [error, setError] = useState<string>();
  const [removing, setRemoving] = useState<string>();
  const owned = useMemo(() => {
    const lifetime = new AbortController();
    const latest = { snapshot: handle.contextSnapshot ?? EMPTY };
    const api = createThreadAppApi(scope, routePrefix);
    let initializing = true;
    const controller = createModelContextController({
      requireLive: () => lifetime.signal.throwIfAborted(),
      send: (request) =>
        api.context(handle.instanceToken, "update", request, lifetime.signal),
      sendRemoval: (request) =>
        api.context(handle.instanceToken, "remove", request, lifetime.signal),
      read: () =>
        api.context(handle.instanceToken, "read", {}, lifetime.signal),
      onSnapshot: (snapshot) => {
        latest.snapshot = snapshot;
        if (!initializing) setValue({ key, snapshot });
      },
    });
    // The controller adopts persisted sequence before accepting another update.
    controller.restore(handle.contextSnapshot ?? EMPTY);
    initializing = false;
    return { lifetime, controller, latest, mounted: 0 };
  }, [key]);
  useEffect(() => {
    owned.mounted++;
    return () => {
      owned.mounted--;
      queueMicrotask(() => {
        if (!owned.mounted) owned.lifetime.abort();
      });
    };
  }, [owned]);
  // "Remove all" the server couldn't confirm: the user still asked that this
  // App add nothing to the chat. Until the App attaches new context (a later
  // revision), its chip and its own view of the context stay cleared, and
  // no turn carries it.
  const [detached, setDetached] = useState<{ key: string; revision: number }>();
  const received =
    value.key === key ? value.snapshot : handle.contextSnapshot ?? EMPTY;
  // Explicit, not inferred from the chip: the server may still hold this
  // revision, and context with no chip (assistant-only) still reaches turns.
  const isDetached =
    detached?.key === key && received.revision <= detached.revision;
  const snapshot = useMemo(
    () => (isDetached && received.state ? { ...received, state: null } : received),
    [received, isDetached],
  );
  const serverName = presentation.serverName;
  const pluginIcons = presentation.icons;
  const serverIcons = presentation.serverIcons;
  const attachments = useMemo<ContextAttachment[]>(() => {
    if (!handle.contextEnabled) return [];
    // × on the App's chip removes every visible block, one explicit removal
    // at a time against the current state, so the App hears each change.
    const removeAll = () => {
      setRemoving(REMOVE_ALL);
      setError(undefined);
      void (async () => {
        let reconciled = false;
        for (let guard = 0; guard <= 65; guard++) {
          const current = owned.latest.snapshot;
          const last = pluginContextAttachments(current).at(-1);
          if (!last || !current.state) return;
          try {
            await owned.controller.remove(current.state.updateId, last.index);
          } catch (error) {
            // The App replaced its context first, or an earlier request's
            // outcome is unknown: read the current state once and carry on
            // removing from it.
            if (reconciled) throw error;
            reconciled = true;
            await owned.controller.refresh();
          }
        }
      })()
        .catch(() => {
          setDetached({ key, revision: owned.latest.snapshot.revision });
          setError("Couldn't remove App context. Refresh and try again.");
        })
        .finally(() =>
          setRemoving((value) => (value === REMOVE_ALL ? undefined : value)),
        );
    };
    const group = {
      id: handle.instanceId,
      title: handle.toolTitle,
      serverName,
      ...(pluginIcons ? { icons: pluginIcons } : {}),
      ...(serverIcons?.length ? { serverIcons } : {}),
      removeAll,
    };
    return pluginContextAttachments(snapshot).map((item) => {
      const updateId = snapshot.state!.updateId;
      const id = `${handle.instanceId}:${updateId}:${item.index}`;
      const shown = appContextBlock(item);
      return {
        id,
        title: shown.title,
        description: handle.toolTitle,
        group,
        block: shown.block,
        removing: removing === id || removing === REMOVE_ALL,
        remove: () => {
          setRemoving(id);
          setError(undefined);
          void owned.controller
            .remove(updateId, item.index)
            .catch(() => {
              setError("Couldn't remove App context. Refresh and try again.");
              // Show what is actually attached now, and leave no unknown
              // outcome behind to refuse the next change.
              return owned.controller.refresh().catch(() => {});
            })
            .finally(() =>
              setRemoving((current) =>
                current === id ? undefined : current,
              ),
            );
        },
      };
    });
  }, [
    handle.contextEnabled,
    handle.instanceId,
    handle.toolTitle,
    serverName,
    pluginIcons,
    serverIcons,
    snapshot,
    removing,
    owned,
    key,
  ]);
  return {
    snapshot,
    attachments,
    /** Remove all went unconfirmed: no turn may reference this App's context. */
    detached: isDetached,
    error,
    update: owned.controller,
    refresh: owned.controller.refresh,
  };
}

/** Compose after the restricted owned host, using the original host only for policy. */
export function withAppContext(
  owned: WidgetHost,
  policy: WidgetHost,
  handle: ThreadAppHandle,
  context: Pick<ReturnType<typeof useAppContext>, "snapshot" | "update">,
): WidgetHost {
  const allowed = (
    args: Parameters<
      WidgetHost["resolvers"]["resolveEffectiveMcpAppsCapabilities"]
    >[0],
  ) => {
    const matrix = policy.resolvers.resolveEffectiveMcpAppsCapabilities(args);
    return (
      !!handle.contextEnabled &&
      matrix.updateModelContext &&
      matrix.hostContextChanged &&
      !!policy.resolvers.resolveEffectiveHostCapabilities(args)
        .updateModelContext
    );
  };
  return {
    ...owned,
    environment: {
      ...owned.environment,
      draftHostContext: {
        ...owned.environment.draftHostContext,
        "openai/modelContext": context.snapshot.state,
      },
    },
    services: {
      ...owned.services,
      ...(handle.contextEnabled ? { updateModelContext: context.update } : {}),
    },
    resolvers: {
      ...owned.resolvers,
      resolveEffectiveHostCapabilities: (args) => ({
        ...owned.resolvers.resolveEffectiveHostCapabilities(args),
        ...(allowed(args)
          ? {
              experimental: {
                ...owned.resolvers.resolveEffectiveHostCapabilities(args)
                  .experimental,
                "openai/modelContext": {},
              },
              updateModelContext:
                policy.resolvers.resolveEffectiveHostCapabilities(args)
                  .updateModelContext,
            }
          : {}),
      }),
      resolveEffectiveMcpAppsCapabilities: (args) => ({
        ...owned.resolvers.resolveEffectiveMcpAppsCapabilities(args),
        updateModelContext: allowed(args),
      }),
    },
  };
}
