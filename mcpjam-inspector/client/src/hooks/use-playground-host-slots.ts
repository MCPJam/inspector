import { useHost, type HostDetail } from "@/hooks/useClients";

/**
 * Resolve up to 3 host detail records by id, in a rules-of-hooks-safe way.
 *
 * The multi-host compare grid has a fixed cap of 3 columns. React's
 * rules-of-hooks forbid conditionally calling `useHost`, so this helper
 * makes 3 unconditional calls and lets `useHost` short-circuit on null ids
 * (verified in `useClients.ts:43-62` — passes `"skip"` to `useQuery` when
 * `hostId` is null). Callers slice the result to the live `ids.length`.
 *
 * Why a helper rather than inline at the call site: the rule is easy to
 * break ("just add a fourth `useHost`"), and the cap rises when the plan
 * eventually raises the column count. Centralizing it puts the cap in one
 * place — bumping the multi-host cap from 3 to N means editing this file
 * (and the matching grid-column count helper).
 *
 * Returns an array shaped `[slot0, slot1, slot2]` regardless of how many
 * ids the caller passed. Each slot has `host: HostDetail | null` and
 * `isLoading: boolean` per `useHost`'s contract.
 */
export interface HostSlot {
  host: HostDetail | null;
  isLoading: boolean;
}

export function usePlaygroundHostSlots(
  isAuthenticated: boolean,
  ids: (string | null | undefined)[],
): [HostSlot, HostSlot, HostSlot] {
  const slot0 = useHost({
    isAuthenticated,
    hostId: ids[0] ?? null,
  });
  const slot1 = useHost({
    isAuthenticated,
    hostId: ids[1] ?? null,
  });
  const slot2 = useHost({
    isAuthenticated,
    hostId: ids[2] ?? null,
  });
  return [slot0, slot1, slot2];
}
