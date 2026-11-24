import { useEffect, useMemo, useRef, useState } from "react";
import { mockChangesBetween } from "@/lib/apis/climbs-api";
import type { Climb } from "./climb-types";
import { startingVersion, type RoundChange } from "./round-model";

/** A round's changes, `null` when they could not be read, absent while they load or when no comparison exists. A code round holds the server it ran. */
export type RoundChanges = Record<number, RoundChange>;

type Servers = { real: readonly { id: string; name: string }[]; loading: boolean };
const NO_SERVERS: Servers = { real: [], loading: false };

/**
 * What each round changed on its mock, by round number. Reads run a few at a
 * time because each one reads the real server's listing. A read that fails is
 * recorded as `null`, so the screen can say the change could not be read
 * instead of waiting for it. A round that ran a saved server that is no mock
 * is a code round: it is recorded with its server and nothing is read for it.
 * Nothing is read until the project's servers are known, so a code round is
 * never asked for as a mock.
 */
export function useRoundChanges(projectId: string, climb: Climb | undefined, servers: Servers = NO_SERVERS): RoundChanges {
  const [changes, setChanges] = useState<RoundChanges>({});
  const known = useRef(changes);
  known.current = changes;
  const { real, loading } = servers;
  const codeRounds = useMemo(() => {
    const found: RoundChanges = {};
    for (const round of climb?.rounds ?? []) {
      const server = real.find((candidate) => candidate.id === round.serverId);
      if (server) found[round.number] = { code: { serverId: server.id, serverName: server.name } };
    }
    return found;
  }, [climb, real]);
  const wanted = useMemo(
    () =>
      loading
        ? []
        : (climb?.rounds ?? []).flatMap((round) => {
            if (codeRounds[round.number]) return [];
            const since = climb ? startingVersion(climb, round, (candidate) => candidate.number in codeRounds) : null;
            const version = Number.parseInt(round.serverVersion ?? "", 10);
            return since === null || !Number.isInteger(version)
              ? []
              : [{ number: round.number, mockId: round.serverId, version, since }];
          }),
    [climb, codeRounds, loading],
  );

  useEffect(() => {
    let cancelled = false;
    const queue = wanted.filter((entry) => known.current[entry.number] === undefined);
    const worker = async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        const number = entry.number;
        let list: RoundChange;
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

  return useMemo(() => ({ ...changes, ...codeRounds }), [changes, codeRounds]);
}
