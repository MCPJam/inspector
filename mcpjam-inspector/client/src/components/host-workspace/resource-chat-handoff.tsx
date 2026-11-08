import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { UNSAFE_LocationContext } from "react-router";
import { z } from "zod";
import { Button } from "@mcpjam/design-system/button";
import {
  routePaths,
  useAppNavigate,
  useCurrentLocationParts,
} from "@/lib/app-navigation";
import { buildProjectPath } from "@/lib/project-route";
import type { ExtensionOwnerIdentity } from "./extension-owners";
import type { ThreadAppApi } from "./thread-app-api";
import {
  FileOpenWith,
  useWorkspaceFileActions,
  type WorkspaceFileActions,
} from "./file-actions";

const STATE_KEY = "pluginResourceFile";
const MAX_AGE_MS = 5 * 60_000;
const consumed = new Map<string, number>();
const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\u0000-\u001f\u007f]+$/);
const handoffSchema = z
  .object({
    actorId: identifier,
    projectId: identifier,
    hostId: identifier,
    serverId: identifier,
    resourceUri: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[^\u0000-\u001f\u007f]+$/),
    nonce: z.string().uuid(),
    createdAt: z.number().finite(),
  })
  .strict();
type Handoff = z.infer<typeof handoffSchema>;
export type ResourceChatScope = Pick<
  Handoff,
  "actorId" | "projectId" | "hostId" | "serverId"
>;

function claim(handoff: Handoff) {
  const now = Date.now();
  for (const [nonce, expiresAt] of consumed)
    if (expiresAt <= now) consumed.delete(nonce);
  if (
    handoff.createdAt > now ||
    now - handoff.createdAt >= MAX_AGE_MS ||
    consumed.has(handoff.nonce) ||
    consumed.size >= 256
  )
    return false;
  consumed.set(handoff.nonce, handoff.createdAt + MAX_AGE_MS);
  return true;
}

/** A resource URI is private navigation state, never a URL or a file grant. */
export function ResourceOpenInChat({
  scope,
  resourceUri,
}: {
  scope?: ResourceChatScope | null;
  resourceUri: string;
}) {
  const navigate = useAppNavigate();
  if (!scope) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={(event) => {
        event.stopPropagation();
        const handoff = handoffSchema.safeParse({
          ...scope,
          resourceUri,
          nonce: crypto.randomUUID(),
          createdAt: Date.now(),
        });
        if (!handoff.success) return;
        navigate(buildProjectPath(scope.projectId, routePaths.playground), {
          state: { [STATE_KEY]: handoff.data },
        });
      }}
    >
      Open in chat
    </Button>
  );
}

/** Consumes one intent before the current chat's normal viewer discovery. */
export function ResourceChatHandoff({
  identity,
  ready,
  fileActions,
  compareActive = false,
}: {
  identity: ExtensionOwnerIdentity | null;
  ready: boolean;
  fileActions?: WorkspaceFileActions | null;
  compareActive?: boolean;
}) {
  const location = useContext(UNSAFE_LocationContext)?.location;
  const navigate = useAppNavigate();
  const contextualActions = useWorkspaceFileActions();
  const actions = fileActions === undefined ? contextualActions : fileActions;
  const parts = useCurrentLocationParts();
  const [fallbackState, setFallbackState] = useState<unknown>(() =>
    typeof window === "undefined" ? null : window.history.state,
  );
  useEffect(() => {
    if (location) return;
    const sync = () => setFallbackState(window.history.state);
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, [location]);
  const state: unknown = location ? location.state : fallbackState;
  const handled = useRef<unknown>(null);
  const handledLocation = useRef<string | undefined>(undefined);
  const [pending, setPending] = useState<Handoff | null>(null);
  const [owner, setOwner] = useState<{
    nonce: string;
    api: ThreadAppApi;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);

  useLayoutEffect(() => {
    if (
      !state ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      !(STATE_KEY in state) ||
      (handled.current === state && handledLocation.current === location?.key)
    )
      return;
    handled.current = state;
    handledLocation.current = location?.key;
    const { [STATE_KEY]: raw, ...rest } = state;
    // Replace first: refresh, Back, or an effect replay must not open again.
    navigate(`${parts.pathname}${parts.search}${parts.hash}`, {
      replace: true,
      state: rest,
    });
    const parsed = handoffSchema.safeParse(raw);
    setOwner(null);
    setStarted(null);
    if (!parsed.success || !claim(parsed.data)) {
      setPending(null);
      setError(
        "This file request is no longer available. Open it again from Resources.",
      );
      return;
    }
    setError(null);
    setPending(parsed.data);
  }, [
    state,
    location?.key,
    parts.pathname,
    parts.search,
    parts.hash,
    navigate,
  ]);

  const matchesIdentity =
    !!pending &&
    !!identity &&
    identity.actorId === pending.actorId &&
    identity.projectId === pending.projectId &&
    identity.hostId === pending.hostId;
  const matches =
    matchesIdentity &&
    !!pending &&
    !!actions &&
    actions.enabled !== false &&
    actions.serverIds.includes(pending.serverId);

  useLayoutEffect(() => {
    if (!pending || error) return;
    if (compareActive) {
      setError(
        "Switch to a single chat, then open this file again from Resources.",
      );
      return;
    }
    if (!ready) return;
    // Parent registration publishes the first chat owner after child layout effects.
    if (matchesIdentity && !actions && !owner) return;
    if (!matches || (owner && owner.api !== actions?.api)) {
      setError(
        "This chat cannot open that file. Check the selected client, connected server, and file viewer settings, then open it again from Resources.",
      );
    } else if (!owner && actions) {
      setOwner({ nonce: pending.nonce, api: actions.api });
    }
  }, [
    pending,
    ready,
    error,
    matchesIdentity,
    matches,
    owner,
    actions,
    compareActive,
  ]);

  useEffect(() => {
    if (!pending || owner || error) return;
    const timer = setTimeout(
      () =>
        setError(
          "The chat could not open the file. Check your connection, then open it again from Resources.",
        ),
      15_000,
    );
    return () => clearTimeout(timer);
  }, [pending, owner, error]);

  if (error)
    return (
      <p role="alert" className="px-3 py-2 text-sm text-destructive">
        {error}
      </p>
    );
  if (!pending) return null;
  if (!ready || !matches || !owner || owner.api !== actions?.api)
    return (
      <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
        Preparing the file viewer…
      </p>
    );
  return (
    <div className="px-3 py-2">
      <FileOpenWith
        fileActions={actions}
        reference={{
          serverId: pending.serverId,
          resourceUri: pending.resourceUri,
        }}
        autoOpenKey={started === pending.nonce ? undefined : pending.nonce}
        onAutoOpenStart={() => setStarted(pending.nonce)}
      />
    </div>
  );
}
