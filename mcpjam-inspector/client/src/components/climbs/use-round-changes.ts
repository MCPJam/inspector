import { useEffect, useMemo, useRef, useState } from "react";
import type { PlatformMockChange } from "@mcpjam/sdk/platform";
import { mockChangesBetween } from "@/lib/apis/climbs-api";
import type { Climb } from "./climb-types";
import { startingVersion } from "./round-model";

/** A round's changes, `null` when they could not be read, absent while they load or when no comparison exists. */
export type RoundChanges = Record<number, PlatformMockChange[] | null>;

/**
 * What each round changed on its mock, by round number. Reads run a few at a
 * time because each one reads the real server's listing. A read that fails is
 * recorded as `null`, so the screen can say the change could not be read
 * instead of waiting for it.
 */
export function useRoundChanges(projectId: string, climb: Climb | undefined): RoundChanges {
  const [changes, setChanges] = useState<RoundChanges>({});
  const known = useRef(changes);
  known.current = changes;
  const wanted = useMemo(
    () =>
      (climb?.rounds ?? []).flatMap((round) => {
        const since = climb ? startingVersion(climb, round) : null;
        const version = Number.parseInt(round.serverVersion ?? "", 10);
        return since === null || !Number.isInteger(version)
          ? []
          : [{ number: round.number, mockId: round.serverId, version, since }];
      }),
    [climb],
  );

  useEffect(() => {
    let cancelled = false;
    const queue = wanted.filter((entry) => known.current[entry.number] === undefined);
    const worker = async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        const number = entry.number;
        let list: PlatformMockChange[] | null;
        try {
          list = await mockChangesBetween({
            projectId,
            mockId: entry.mockId,
            version: entry.version,
            sinceVersion: entry.since,
          });
        } catch (error) {
          // Recorded as unreadable: the rail says "Round N" and the round view says why.
          list = null;
        }
        if (!cancelled) setChanges((previous) => ({ ...previous, [number]: list }));
      }
    };
    void Promise.all([worker(), worker(), worker()]);
    return () => {
      cancelled = true;
    };
  }, [projectId, wanted]);

  return changes;
}
