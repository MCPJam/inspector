/**
 * The credit cap as the Describe step applies it: how big a generation to ask
 * for, whether Generate can start, and the notice to show.
 *
 * In compose mode the environments exist only once Generate resolves the
 * selected clients, and reused personas' goals are not loaded before Confirm,
 * so `sizeAtClick` reads the cap then. That reading stands only for the inputs
 * it was taken with: once the balance, the selection, the preset, the judge or
 * the reused personas change, Describe goes back to the live cap.
 */
import { useCallback, useState, type ComponentProps } from "react";
import type { GoalJudgeConfig } from "@/components/shared/session-quality/judge-config";
import { capGeneration } from "@/components/swarms/swarm-credit-cap";
import type { SwarmCreditCapNotice } from "@/components/swarms/swarm-credit-cap-notice";
import type { SwarmIntensityPreset } from "@/components/swarms/swarm-intensity";
import {
  useSwarmCreditCap,
  type SwarmCreditCapAtClick,
} from "@/hooks/use-swarm-credit-cap";

type GenerationSize = { personaCount: number; journeyCount: number };

export function useSwarmDescribeCap({
  projectId,
  organizationId,
  environmentIds,
  composeMode,
  selectionKey,
  preset,
  judgeConfig,
  reusedPersonaIds,
}: {
  projectId: string | null | undefined;
  organizationId: string | null | undefined;
  /** The picked environments; ignored in compose mode, which has none yet. */
  environmentIds: readonly string[];
  composeMode: boolean;
  /** Changes whenever the environment or client selection does. */
  selectionKey: string;
  preset: SwarmIntensityPreset;
  judgeConfig: GoalJudgeConfig | undefined;
  reusedPersonaIds: readonly string[];
}): {
  /** False when the cap leaves room for not one goal. */
  canGenerate: boolean;
  /** What the next generation will ask for, as far as it is known now. */
  size: GenerationSize;
  notice: Omit<
    ComponentProps<typeof SwarmCreditCapNotice>,
    "data-testid"
  > | null;
  /** Read the cap for the resolved environments; `null` when not one goal fits. */
  sizeAtClick: (
    resolvedEnvironmentIds: readonly string[],
  ) => Promise<GenerationSize | null>;
} {
  const cap = useSwarmCreditCap({
    projectId,
    organizationId,
    environmentIds: composeMode ? [] : environmentIds,
    maxTurns: preset.maxTurns,
    judgeConfig,
  });
  const inputsKey = JSON.stringify([
    selectionKey,
    cap.credits,
    cap.max,
    preset.value,
    judgeConfig ?? null,
    reusedPersonaIds,
  ]);
  const [atClick, setAtClick] = useState<
    (SwarmCreditCapAtClick & { environmentCount: number; key: string }) | null
  >(null);
  const current =
    atClick?.key === inputsKey
      ? atClick
      : {
          max: cap.max,
          reusedConversations: 0,
          conversationCredits: cap.conversationCredits,
          environmentCount: environmentIds.length,
        };
  const { size, binds } = capGeneration({ ...current, preset });

  const { capFor } = cap;
  const sizeAtClick = useCallback(
    async (resolvedEnvironmentIds: readonly string[]) => {
      const read = await capFor({
        environmentIds: resolvedEnvironmentIds,
        reusedPersonaIds,
      });
      const next = {
        ...read,
        environmentCount: resolvedEnvironmentIds.length,
        key: inputsKey,
      };
      setAtClick(next);
      return capGeneration({ ...next, preset }).size;
    },
    [capFor, inputsKey, preset, reusedPersonaIds],
  );

  return {
    canGenerate: size !== null,
    size: size ?? preset,
    notice:
      current.max !== null && binds && cap.credits !== null
        ? {
            credits: cap.credits,
            // Not one goal fits even when a few conversations do (several
            // environments, or reused goals that take the rest): say so the
            // way the empty case does, since Generate is off either way.
            max: size === null ? 0 : current.max,
            conversationCredits: current.conversationCredits,
            organizationId,
          }
        : null,
    sizeAtClick,
  };
}
