import { useEffect, useMemo, useRef, useState } from "react";
import {
  createThreadAppApi,
  type PluginOnboardingTarget,
  type ThreadAppScope,
} from "./thread-app-api";
import type {
  PluginOnboardingConversation,
  PluginOnboardingSpec,
} from "@/shared/plugin-onboarding";
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { usePluginOnboardingIntentStore } from "@/lib/plugin-onboarding-intent";
import { toast } from "@/lib/toast";

const RUN_FAILED = "Couldn’t run onboarding. Try again.";

export type RunPluginOnboarding = (
  spec: PluginOnboardingSpec,
  conversation: PluginOnboardingConversation,
  signal: AbortSignal,
  target: PluginOnboardingTarget,
) => Promise<void>;

/** One explicit menu action. Reading availability never sends a chat turn. */
export function usePluginOnboarding(
  scope: ThreadAppScope | null,
  serverIds: readonly string[],
  run: RunPluginOnboarding,
) {
  const scopeKey = JSON.stringify(scope);
  const idsKey = JSON.stringify([...new Set(serverIds)].sort());
  const owner = useMemo(
    () => ({
      api: scope ? createThreadAppApi(scope) : null,
      abort: new AbortController(),
      active: true,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }),
    [scopeKey, idsKey],
  );
  const current = useRef(owner);
  current.current = owner;
  const runRef = useRef(run);
  runRef.current = run;
  const [available, setAvailable] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    setAvailable({});
    setPending(null);
    setError(null);
    busy.current = false;
    if (owner.api)
      for (const id of JSON.parse(idsKey) as string[]) {
        void owner.api
          .onboarding(id, false, abort.signal)
          .then((value) => {
            if (!abort.signal.aborted && current.current === owner)
              setAvailable((old) => ({ ...old, [id]: value.available }));
          })
          .catch(() => {});
      }
    return () => abort.abort();
  }, [owner, idsKey]);
  useEffect(() => {
    owner.active = true;
    if (owner.timer) clearTimeout(owner.timer);
    return () => {
      owner.active = false;
      owner.timer = setTimeout(() => owner.abort.abort(), 0);
    };
  }, [owner]);
  async function start(
    target: PluginOnboardingTarget,
    conversation: PluginOnboardingConversation,
  ) {
    if (
      !owner.api ||
      !owner.active ||
      owner.abort.signal.aborted ||
      busy.current
    )
      return;
    busy.current = true;
    setPending(typeof target === "string" ? target : target.pluginId);
    setError(null);
    let running = false;
    try {
      const value = await owner.api.onboarding(
        target,
        true,
        owner.abort.signal,
      );
      owner.abort.signal.throwIfAborted();
      if (
        !owner.active ||
        current.current !== owner ||
        !value.available ||
        !value.spec
      )
        throw new Error("Unavailable");
      running = true;
      await runRef.current(
        value.spec,
        conversation,
        owner.abort.signal,
        target,
      );
    } catch {
      if (
        owner.active &&
        !owner.abort.signal.aborted &&
        current.current === owner
      ) {
        setError(RUN_FAILED);
        // A run says why itself. A skill that could not be read is said here,
        // or a Set up request would end with nothing on screen.
        if (!running) toast.error(RUN_FAILED);
      }
    } finally {
      if (owner.active && current.current === owner) {
        busy.current = false;
        setPending(null);
      }
    }
  }
  // "Set up <Plugin>" from the import dialog or Settings: run the same
  // onboarding as the menu, once, as soon as one of the plugin's servers
  // offers it here. A plugin with no server is asked about directly.
  const intent = usePluginOnboardingIntentStore((state) => state.intent);
  const pluginIntent =
    intent && scope && intent.projectId === scope.projectId
      ? intent.serverIds.length === 0
        ? intent.pluginId
        : null
      : null;
  const [pluginReady, setPluginReady] = useState<string | null>(null);
  useEffect(() => {
    setPluginReady(null);
    if (!pluginIntent || !owner.api) return;
    const api = owner.api;
    const abort = new AbortController();
    const probe = async () => {
      try {
        const value = await api.onboarding(
          { pluginId: pluginIntent },
          false,
          abort.signal,
        );
        if (
          !abort.signal.aborted &&
          current.current === owner &&
          value.available
        )
          setPluginReady(pluginIntent);
      } catch (error) {
        // The request expires and says so; this only explains why.
        if (!abort.signal.aborted)
          console.warn("[onboarding] plugin setup is unavailable here", error);
      }
    };
    void probe();
    return () => abort.abort();
  }, [owner, pluginIntent]);
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (!intent || !scope || intent.projectId !== scope.projectId) return;
    // A run in flight would turn the request away, so it waits for that run
    // to end, or expires and says why.
    if (pending !== null) return;
    const target: PluginOnboardingTarget | undefined =
      intent.serverIds.find((id) => available[id]) ??
      (pluginReady !== null && pluginReady === pluginIntent
        ? { pluginId: pluginReady }
        : undefined);
    if (!target) return;
    if (!usePluginOnboardingIntentStore.getState().take(intent.id)) return;
    void startRef.current(target, intent.conversation);
  }, [intent, available, pluginReady, pluginIntent, scopeKey, pending]);
  return {
    error,
    pending,
    start,
    menu: (serverId: string, onAction?: () => void) =>
      available[serverId] ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={pending !== null}>
            Run onboarding
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem
              onSelect={() => {
                onAction?.();
                void start(serverId, "current");
              }}
            >
              In this chat
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                onAction?.();
                void start(serverId, "new");
              }}
            >
              In a new chat
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null,
  };
}
