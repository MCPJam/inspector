import { useEffect, useMemo, useRef, useState } from "react";
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
import {
  createModelContextController,
  PLUGIN_CONTEXT_NOT_PERSISTED_CODES,
  PluginContextHeld,
  PluginContextNotPersisted,
} from "./model-context-controller";
import {
  createThreadAppApi,
  ThreadAppError,
  type ThreadAppHandle,
  type ThreadAppScope,
} from "./thread-app-api";
import { logPluginExtensionIssue } from "@/lib/plugin-extension-logs";
import { describePluginError } from "@/lib/plugin-diagnostics";
import { removeAllAppContext } from "./context-remove-all";

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

/**
 * Whether the person is using an App right now: keyboard focus is inside its
 * frame (clicking an App moves focus into it). An App that re-sends context on
 * its own, after the person removed it from the composer, does so while focus
 * is still in the composer. The frame is the renderer's sandbox iframe, titled
 * "MCP App: <tool name>" by widget-react.
 */
export function appFrameFocused(toolName: string | undefined): boolean {
  if (!toolName || typeof document === "undefined") return false;
  const active = document.activeElement;
  return (
    active instanceof HTMLIFrameElement &&
    active.title === `MCP App: ${toolName}`
  );
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
    /** The App's tool, to tell when the person is using its frame. */
    toolName?: string;
  } = {},
) {
  const key = JSON.stringify([scope, handle.instanceToken, handle.generation, routePrefix]);
  const toolNameRef = useRef(presentation.toolName);
  toolNameRef.current = presentation.toolName;
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
        api
          .context(handle.instanceToken, "update", request, lifetime.signal)
          .catch((error: unknown) => {
            if (
              error instanceof ThreadAppError &&
              error.code === "INSTANCE_CONTEXT_HELD"
            )
              throw new PluginContextHeld(
                "Context was removed from this chat. Use the App to attach it again.",
              );
            // Its diagnostic is already in Logs (`thread-app-api` posts it).
            if (
              error instanceof ThreadAppError &&
              PLUGIN_CONTEXT_NOT_PERSISTED_CODES.has(error.code)
            )
              throw new PluginContextNotPersisted(error.code);
            throw error;
          }),
      onRefused: (refusal) =>
        logPluginExtensionIssue({
          code: refusal.reason,
          level: "warning",
          message: `${handle.toolTitle ?? "App"}: ${describePluginError(refusal.reason)}`,
          ...(refusal.excess ? { detail: refusal.excess } : {}),
          dedupeKey: `context-refused:${handle.instanceToken}`,
        }),
      userAttaching: () => appFrameFocused(toolNameRef.current),
      onHeld: () =>
        logPluginExtensionIssue({
          code: "INSTANCE_CONTEXT_HELD",
          level: "info",
          message: `${handle.toolTitle ?? "App"}: ${describePluginError("INSTANCE_CONTEXT_HELD")}`,
          dedupeKey: `context-held:${handle.instanceToken}`,
        }),
      sendRemoveAll: (request) =>
        api.context(
          handle.instanceToken,
          "remove-all",
          request,
          lifetime.signal,
        ),
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
  // The person removed this App's context and the server hasn't confirmed
  // it: they still asked that this App add nothing, so no turn carries its
  // context. While the removal is in flight the chip and the App's own view
  // are cleared too. An unknown outcome holds until a later removal is
  // confirmed (`revision` never passes it). A stale removal (it never
  // landed, and the person attached again first) holds until the App
  // replaces that context with a later revision. Both show the context so
  // the person can review it and remove it again.
  const [detached, setDetached] = useState<{
    key: string;
    revision: number;
    visible: boolean;
  }>();
  const received =
    value.key === key ? value.snapshot : handle.contextSnapshot ?? EMPTY;
  // Explicit, not inferred from the chip: the server may still hold this
  // revision, and context with no chip (assistant-only) still reaches turns.
  const isDetached =
    detached?.key === key && received.revision <= detached.revision;
  const snapshot = useMemo(
    () =>
      isDetached && !detached?.visible && received.state
        ? { ...received, state: null }
        : received,
    [received, isDetached, detached?.visible],
  );
  const serverName = presentation.serverName;
  const pluginIcons = presentation.icons;
  const serverIcons = presentation.serverIcons;
  const attachments = useMemo<ContextAttachment[]>(() => {
    if (!handle.contextEnabled) return [];
    // × on the App's chip removes all of its context in one server
    // operation; there is no per-block removal.
    const removeAll = () => {
      const operation = {
        operationId: crypto.randomUUID(),
        basis: owned.latest.snapshot.cursor ?? 0,
      };
      setRemoving(REMOVE_ALL);
      setError(undefined);
      setDetached({ key, revision: Number.MAX_SAFE_INTEGER, visible: false });
      void removeAllAppContext(
        () => owned.controller.removeAll(operation),
        owned.lifetime.signal,
      )
        .then((result) => {
          if (owned.lifetime.signal.aborted) return;
          if (result.outcome === "stale") {
            setDetached({
              key,
              revision: owned.latest.snapshot.revision,
              visible: true,
            });
            setError(
              "This App's context changed before it was removed. Review it, then remove it again.",
            );
          } else if (result.outcome) setDetached(undefined);
          else {
            // Still unknown: keep it out of turns, and show the last known
            // context again so the person can retry from the chip.
            setDetached({
              key,
              revision: Number.MAX_SAFE_INTEGER,
              visible: true,
            });
            setError(
              "Couldn't confirm that App context was removed, so it stays out of this chat. Remove it again to retry.",
            );
          }
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
        removing: removing === REMOVE_ALL,
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
    /** Remove all is unconfirmed or stale: no turn may reference this App's context. */
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
