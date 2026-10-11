import { useEffect, useMemo, useRef, useState } from "react";
import { createThreadAppApi, type ThreadAppScope } from "./thread-app-api";
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

export type RunPluginOnboarding = (
  spec: PluginOnboardingSpec,
  conversation: PluginOnboardingConversation,
  signal: AbortSignal,
  serverId: string,
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
    serverId: string,
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
    setPending(serverId);
    setError(null);
    try {
      const value = await owner.api.onboarding(
        serverId,
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
      await runRef.current(
        value.spec,
        conversation,
        owner.abort.signal,
        serverId,
      );
    } catch {
      if (
        owner.active &&
        !owner.abort.signal.aborted &&
        current.current === owner
      )
        setError("Couldn’t run onboarding. Try again.");
    } finally {
      if (owner.active && current.current === owner) {
        busy.current = false;
        setPending(null);
      }
    }
  }
  // "Set up <Plugin>" from the import dialog: run the same onboarding as
  // the menu, once, as soon as one of the plugin's servers offers it here.
  const intent = usePluginOnboardingIntentStore((state) => state.intent);
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    if (!intent || !scope || intent.projectId !== scope.projectId) return;
    const serverId = intent.serverIds.find((id) => available[id]);
    if (!serverId) return;
    if (!usePluginOnboardingIntentStore.getState().take(intent.id)) return;
    void startRef.current(serverId, intent.conversation);
  }, [intent, available, scopeKey]);
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
