import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import type { ChatboxListItem, ChatboxSettings } from "@/hooks/useChatboxes";
import {
  hostConfigDtoToInput,
  type HostConfigDtoV2,
} from "@/lib/host-config-v2";
import {
  CHATBOX_STARTERS,
  DEFAULT_SYSTEM_PROMPT,
  getDefaultHostedModelId,
} from "./drafts";
import type { ChatboxStarterDefinition } from "./types";

function getDemoStarter(): ChatboxStarterDefinition | undefined {
  return CHATBOX_STARTERS.find((s) => s.id === "excalidraw-demo");
}

interface UseChatboxDemoSeedArgs {
  isAuthenticated: boolean;
  projectId: string | null;
  chatboxes: ChatboxListItem[] | undefined;
  isLoadingChatboxes: boolean;
  /** Disable seeding when the user is at their chatbox quota. */
  isCreateChatboxDisabled?: boolean;
}

export interface UseChatboxDemoSeedResult {
  /** Newly minted demo chatbox id (or null until/unless seed succeeds). */
  seededChatboxId: string | null;
  /**
   * True while the auto-seed mutation is in flight OR while we're still
   * waiting on the project default before deciding whether to seed.
   */
  isSeeding: boolean;
}

/**
 * First-run experience: when a project has zero chatboxes, ask the
 * backend to mint a ready-to-use Excalidraw demo chatbox so the user
 * lands directly in preview instead of an empty index.
 *
 * Dedup is enforced server-side by the `chatboxes:ensureDemoChatbox`
 * mutation via the monotonic `projects.demoSeededAt` flag — once a
 * project has been seeded, the mutation returns `{ alreadySeeded: true }`
 * even if the user later deletes the demo. Convex mutations are
 * transactional, so racing tabs / remounts / StrictMode all serialize
 * through the flag check; only one call wins the seed, the rest no-op.
 */
export function useChatboxDemoSeed({
  isAuthenticated,
  projectId,
  chatboxes,
  isLoadingChatboxes,
  isCreateChatboxDisabled = false,
}: UseChatboxDemoSeedArgs): UseChatboxDemoSeedResult {
  const ensureDemoChatbox = useMutation("chatboxes:ensureDemoChatbox" as any);

  // The chatbox builder's regular save path seeds connection settings
  // (headers / capabilities / hostContext) from the project default;
  // do the same here so the demo inherits the same baseline.
  const projectDefaultHostConfig = useQuery(
    "hostConfigsV2:getProjectDefault" as any,
    isAuthenticated && projectId ? ({ projectId } as any) : "skip",
  ) as HostConfigDtoV2 | null | undefined;

  const [seededChatboxId, setSeededChatboxId] = useState<string | null>(null);
  const [isSeeding, setIsSeeding] = useState(false);
  const inFlightRef = useRef(false);
  // Latch any non-throwing attempt per project — including `alreadySeeded`
  // no-ops — so a Convex refetch of an empty `chatboxes` list doesn't
  // re-fire the mutation on every reference change. Keyed by projectId
  // because ChatboxesTab swaps the `projectId` prop in place (no
  // `key={projectId}`) when the user switches projects; a single
  // boolean latch would block first-run seeding for every subsequent
  // empty project in the session. Transient errors deliberately do not
  // latch so the effect can retry after a network blip.
  const attemptedProjectsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!isAuthenticated) return;
    if (!projectId) return;
    if (isCreateChatboxDisabled) return;
    if (isLoadingChatboxes) return;
    if (chatboxes === undefined) return;
    if (chatboxes.length > 0) return;
    if (projectDefaultHostConfig === undefined) return;
    if (inFlightRef.current) return;
    if (attemptedProjectsRef.current.has(projectId)) return;

    const starter = getDemoStarter();
    const seed = starter?.serverSeeds?.[0];
    if (!starter || !seed) return;

    inFlightRef.current = true;
    setIsSeeding(true);

    void (async () => {
      try {
        const draft = starter.createDraft(getDefaultHostedModelId());
        const projectDefaultInput = projectDefaultHostConfig
          ? hostConfigDtoToInput(projectDefaultHostConfig)
          : null;

        const result = (await ensureDemoChatbox({
          projectId,
          name: draft.name,
          description: draft.description.trim() || undefined,
          welcomeDialog: draft.welcomeDialog,
          feedbackDialog: draft.feedbackDialog,
          mode: draft.mode,
          serverSeed: { name: seed.name, url: seed.url },
          hostConfigSeed: {
            hostStyle: draft.hostStyle,
            modelId: draft.modelId,
            systemPrompt:
              draft.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
            temperature: draft.temperature,
            requireToolApproval: draft.requireToolApproval,
            connectionDefaults: projectDefaultInput?.connectionDefaults ?? {
              headers: {},
              requestTimeout: 60_000,
            },
            clientCapabilities:
              projectDefaultInput?.clientCapabilities ?? {},
            hostContext: projectDefaultInput?.hostContext ?? {},
          },
        })) as {
          chatbox: ChatboxSettings | null;
          alreadySeeded: boolean;
        };

        // Latch *after* a non-throwing response (success or
        // `alreadySeeded`) so we don't re-fire on Convex chatboxes-list
        // refetches; the throw path falls through without latching so a
        // transient network error can still retry.
        attemptedProjectsRef.current.add(projectId);
        if (result.chatbox) {
          setSeededChatboxId(result.chatbox.chatboxId);
        }
        // alreadySeeded === true: no-op. The user has already been
        // through first-run for this project; the chatboxes list will
        // reflect whatever they currently have.
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        toast.error(`Couldn't set up the demo: ${message}`);
        // eslint-disable-next-line no-console
        console.error("[chatboxes] auto-seed failed", error);
      } finally {
        inFlightRef.current = false;
        setIsSeeding(false);
      }
    })();
  }, [
    chatboxes,
    ensureDemoChatbox,
    isAuthenticated,
    isCreateChatboxDisabled,
    isLoadingChatboxes,
    projectDefaultHostConfig,
    projectId,
  ]);

  // While we're an eligible seed candidate but the project default
  // hasn't resolved yet, surface "isSeeding" so the index page keeps
  // the spinner up instead of flashing the empty state.
  const isPreparingPrerequisites =
    isAuthenticated &&
    !!projectId &&
    !isCreateChatboxDisabled &&
    !isLoadingChatboxes &&
    chatboxes !== undefined &&
    chatboxes.length === 0 &&
    projectDefaultHostConfig === undefined;

  return {
    seededChatboxId,
    isSeeding: isSeeding || isPreparingPrerequisites,
  };
}
