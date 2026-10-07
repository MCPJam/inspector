import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import { useStore } from "zustand";
import { Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ThreadAppApi, ThreadAppDeclaration } from "./thread-app-api";
import { logExtensionEvent } from "./extension-log";

export interface FileResourceReference {
  serverId: string;
  resourceUri: string;
}
export interface WorkspaceFileActions {
  api: ThreadAppApi;
  /** Enabled saved IDs from the current workspace, never a name lookup. */
  serverIds: readonly string[];
  open: (serverId: string, entry: ThreadAppDeclaration) => Promise<void>;
  /** The client's file viewers setting; off means no new opens. */
  enabled?: boolean;
}
const FileActionsContext = createContext<WorkspaceFileActions | null>(null);

export interface ResourceLinkTarget {
  serverId: string;
  name: string;
}
type ResourceLinkRegistry = StoreApi<{
  links: Readonly<Record<string, ResourceLinkTarget>>;
}>;
const ResourceLinkRegistryContext = createContext<ResourceLinkRegistry | null>(
  null,
);
const MAX_REGISTERED_LINKS = 512;

export function WorkspaceFileActionsProvider({
  value,
  children,
}: {
  value: WorkspaceFileActions | null;
  children: ReactNode;
}) {
  // Resource links this chat's tool results produced, so a link the model
  // writes in its reply opens the same file (and never shows its URI).
  const registry = useMemo<ResourceLinkRegistry>(
    () => createStore(() => ({ links: {} })),
    // A new workspace (chat, client, project) starts a new registry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value?.api],
  );
  return (
    <FileActionsContext.Provider value={value}>
      <ResourceLinkRegistryContext.Provider value={registry}>
        {children}
      </ResourceLinkRegistryContext.Provider>
    </FileActionsContext.Provider>
  );
}

/** Tool results record the resource links they produced, with their server. */
function useRegisterResourceLinks(
  serverId: string | undefined,
  links: readonly { uri: string; name: string }[],
) {
  const registry = useContext(ResourceLinkRegistryContext);
  const key = JSON.stringify([serverId, links.map((link) => [link.uri, link.name])]);
  useEffect(() => {
    if (!registry || !serverId || !links.length) return;
    registry.setState((state) => {
      const next = { ...state.links };
      for (const link of links)
        next[link.uri] = { serverId, name: link.name };
      const keys = Object.keys(next);
      for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_REGISTERED_LINKS)))
        delete next[stale];
      return { links: next };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, key]);
}

const EMPTY_LINKS: Readonly<Record<string, ResourceLinkTarget>> = {};
const fallbackRegistry: ResourceLinkRegistry = createStore(() => ({
  links: EMPTY_LINKS,
}));
/** Every resource link this chat's tool results produced, by URI. */
export function useResourceLinkIndex(): Readonly<
  Record<string, ResourceLinkTarget>
> {
  const registry = useContext(ResourceLinkRegistryContext);
  return useStore(registry ?? fallbackRegistry, (state) => state.links);
}

function usableActions(
  actions: WorkspaceFileActions | null,
  reference: FileResourceReference | null | undefined,
): reference is FileResourceReference {
  return (
    !!actions &&
    actions.enabled !== false &&
    !!reference &&
    actions.serverIds.includes(reference.serverId) &&
    !!reference.resourceUri
  );
}

type ViewerMenu =
  | { state: "closed" }
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; entries: ThreadAppDeclaration[] };

/**
 * Click-to-open for a file reference. Viewers are discovered when the file is
 * clicked (never on render): exactly one opens directly as a right-rail tab;
 * several show an "Open with…" chooser; none says so.
 */
function useFileOpen(
  actions: WorkspaceFileActions | null,
  reference: FileResourceReference | null | undefined,
) {
  const [menu, setMenu] = useState<ViewerMenu>({ state: "closed" });
  const [failed, setFailed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const binding = JSON.stringify([reference?.serverId, reference?.resourceUri]);
  useEffect(() => {
    setMenu({ state: "closed" });
    setFailed(false);
    return () => request.current?.abort();
  }, [binding, actions?.api]);
  const open = async (entry: ThreadAppDeclaration) => {
    if (!usableActions(actions, reference)) return;
    setMenu({ state: "closed" });
    setFailed(false);
    try {
      await actions!.open(reference.serverId, entry);
    } catch {
      setFailed(true);
    }
  };
  const activate = async () => {
    if (!usableActions(actions, reference)) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setFailed(false);
    setMenu({ state: "loading" });
    try {
      const entries = await actions!.api.discoverFile(
        reference.serverId,
        reference.resourceUri,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (entries.length === 1) {
        await open(entries[0]);
        return;
      }
      if (entries.length === 0)
        logExtensionEvent({
          serverId: reference.serverId,
          label: "file-viewer",
          level: "info",
          message:
            "No file viewer of this server accepts this file's extension.",
        });
      setMenu({ state: "ready", entries });
    } catch {
      if (controller.signal.aborted) return;
      setMenu({ state: "error" });
      logExtensionEvent({
        serverId: reference.serverId,
        label: "file-viewer",
        level: "error",
        message: "Couldn't list the file viewers for this file.",
      });
    }
  };
  return { menu, setMenu, failed, activate, open };
}

/** Radix opens a menu on pointer down; this trigger decides on click. */
const holdMenu = {
  onPointerDown: (event: { preventDefault: () => void }) =>
    event.preventDefault(),
  onKeyDown: (event: { key: string; preventDefault: () => void }) => {
    if (event.key === "Enter" || event.key === " ") event.preventDefault();
  },
};

function ViewerMenuContent({
  menu,
  onOpen,
}: {
  menu: ViewerMenu;
  onOpen: (entry: ThreadAppDeclaration) => void;
}) {
  return (
    <DropdownMenuContent align="start">
      <DropdownMenuLabel className="text-xs text-muted-foreground">
        Open with…
      </DropdownMenuLabel>
      {menu.state === "error" && (
        <DropdownMenuItem disabled>Couldn't load viewers</DropdownMenuItem>
      )}
      {menu.state === "ready" && menu.entries.length === 0 && (
        <DropdownMenuItem disabled>No viewer can open this file</DropdownMenuItem>
      )}
      {menu.state === "ready" &&
        menu.entries.map((entry) => (
          <DropdownMenuItem key={entry.toolName} onSelect={() => onOpen(entry)}>
            {entry.title}
          </DropdownMenuItem>
        ))}
    </DropdownMenuContent>
  );
}

/**
 * A file name that opens its viewer. Without a qualified workspace (or with
 * file viewers off) it is plain text. Never shows the resource URI.
 */
export function FileLink({
  reference,
  label,
  className,
}: {
  reference?: FileResourceReference | null;
  label: ReactNode;
  className?: string;
}) {
  const actions = useContext(FileActionsContext);
  const file = useFileOpen(actions, reference);
  if (!usableActions(actions, reference))
    return <span className={className}>{label}</span>;
  return (
    <DropdownMenu
      open={file.menu.state === "ready" || file.menu.state === "error"}
      onOpenChange={(open) => {
        if (!open) file.setMenu({ state: "closed" });
      }}
    >
      <DropdownMenuTrigger asChild {...holdMenu}>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void file.activate();
          }}
          className={cn(
            "inline-flex max-w-full items-center gap-1 text-left text-primary underline-offset-2 hover:underline",
            className,
          )}
        >
          <span className="truncate">{label}</span>
          {file.menu.state === "loading" ? (
            <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
          ) : null}
        </button>
      </DropdownMenuTrigger>
      <ViewerMenuContent menu={file.menu} onOpen={(entry) => void file.open(entry)} />
      {file.failed && (
        <span role="alert" className="ms-1 text-xs text-destructive">
          Could not open viewer
        </span>
      )}
    </DropdownMenu>
  );
}

/** Reference metadata requests discovery; only the server may grant file access. */
export function FileOpenWith({
  reference,
}: {
  reference?: FileResourceReference | null;
}) {
  const actions = useContext(FileActionsContext);
  const file = useFileOpen(actions, reference);
  if (!usableActions(actions, reference)) return null;
  return (
    <span onClick={(event) => event.stopPropagation()}>
      <DropdownMenu
        open={file.menu.state === "ready" || file.menu.state === "error"}
        onOpenChange={(open) => {
          if (!open) file.setMenu({ state: "closed" });
        }}
      >
        <DropdownMenuTrigger asChild {...holdMenu}>
          <button
            type="button"
            onClick={() => void file.activate()}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium hover:bg-accent"
          >
            Open
            {file.menu.state === "loading" ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <ViewerMenuContent
          menu={file.menu}
          onOpen={(entry) => void file.open(entry)}
        />
      </DropdownMenu>
      {file.failed && <span role="alert">Could not open viewer</span>}
    </span>
  );
}

/** Resource links keep their producing saved server; a URI never selects a server. */
export function ToolResourceAttachments({
  result,
  serverId,
}: {
  result: unknown;
  serverId?: string;
}) {
  const actions = useContext(FileActionsContext);
  if (
    !actions ||
    !serverId ||
    !actions.serverIds.includes(serverId) ||
    !result ||
    typeof result !== "object"
  )
    return null;
  const root = result as { content?: unknown; value?: { content?: unknown } };
  const content = root.content ?? root.value?.content;
  if (!Array.isArray(content)) return null;
  const links = content
    .slice(0, 64)
    .filter(
      (item): item is { type: "resource_link"; uri: string; name: string } =>
        !!item &&
        typeof item === "object" &&
        item.type === "resource_link" &&
        typeof item.uri === "string" &&
        item.uri.length <= 4096 &&
        typeof item.name === "string" &&
        item.name.length <= 4096,
    );
  if (!links.length) return null;
  return (
    <ResourceLinkChips serverId={serverId} links={links} />
  );
}

function ResourceLinkChips({
  serverId,
  links,
}: {
  serverId: string;
  links: { uri: string; name: string }[];
}) {
  useRegisterResourceLinks(serverId, links);
  return (
    <div className="flex flex-wrap gap-2 px-3 pb-2">
      {links.map((link, index) => (
        <div
          key={`${link.uri}:${index}`}
          className="inline-flex max-w-64 items-center gap-2 rounded-md border border-border px-2 py-1 text-xs"
          title={link.name}
        >
          <FileLink
            reference={{ serverId, resourceUri: link.uri }}
            label={link.name}
          />
        </div>
      ))}
    </div>
  );
}
