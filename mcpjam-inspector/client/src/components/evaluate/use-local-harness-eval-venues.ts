/**
 * Where each local harness client in a run would run, asked when the run sheet
 * opens, with the sheet's two fixes: Set up (the same one-click setup Add
 * client and the Playground run) and Retry. Start stays off while any client
 * can't run, is being set up, or hasn't been answered yet; the launch still
 * refuses on its own if anything changed after the check.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { HOSTED_MODE } from "@/lib/config";
import {
  ensureLocalHarnessReady,
  LOCAL_HARNESS_CLIENT_NAMES,
  type LocalHarnessClientId,
} from "@/lib/local-harness-consent";
import {
  fetchLocalHarnessEvalVenue,
  type LocalEvalVenueResult,
} from "@/lib/local-harness-eval-venue";
import type { LocalEvalVenueFix } from "@/shared/local-eval-venue";

export type LocalEvalVenueState =
  | { kind: "checking" }
  | { kind: "local" }
  | { kind: "cloud" }
  /** This Inspector can't say (local clients are switched off); the launch decides. */
  | { kind: "unknown" }
  | { kind: "refused"; message: string; fix: LocalEvalVenueFix }
  | { kind: "setting-up"; progress: string | null }
  | { kind: "setup-failed"; message: string };

export type LocalEvalVenueRow = {
  harnessId: LocalHarnessClientId;
  name: string;
  state: LocalEvalVenueState;
};

export type LocalEvalVenues = {
  rows: readonly LocalEvalVenueRow[];
  check: (harnessId: LocalHarnessClientId) => void;
  setUp: (harnessId: LocalHarnessClientId) => void;
  /** Start's disabled reason, or null when every client can run. */
  startBlockedReason: string | null;
};

function checkFailed(name: string, status?: number): LocalEvalVenueState {
  return {
    kind: "refused",
    message:
      status === 401
        ? `Couldn't check whether ${name} can run on this machine. Sign in again, then retry.`
        : `Couldn't check whether ${name} can run on this machine. Check your connection, then retry.`,
    fix: "retry",
  };
}

function stateOf(result: LocalEvalVenueResult, name: string): LocalEvalVenueState {
  if (!result.ok) return result.turnedOff ? { kind: "unknown" } : checkFailed(name, result.status);
  const { venue } = result;
  return venue.venue === "refused"
    ? { kind: "refused", message: venue.message, fix: venue.fix }
    : { kind: venue.venue };
}

export function localEvalVenueStartBlock(rows: readonly LocalEvalVenueRow[]): string | null {
  const blocking = rows.filter(
    ({ state }) => state.kind === "refused" || state.kind === "setup-failed",
  );
  if (blocking.length > 1) {
    return `${blocking.length} clients can't run here. Fix them above to start this run.`;
  }
  const [row] = blocking;
  if (row?.state.kind === "setup-failed") return `Retry the ${row.name} setup to start this run.`;
  if (row?.state.kind === "refused") {
    switch (row.state.fix) {
      case "set-up":
        return `Set up ${row.name} to start this run.`;
      case "retry":
        return `Retry the check for ${row.name} to start this run.`;
      case "choose-another":
        return `Replace or remove ${row.name} to start this run.`;
    }
  }
  const settingUp = rows.find(({ state }) => state.kind === "setting-up");
  if (settingUp) return `Start is available once ${settingUp.name} is set up.`;
  const checking = rows.find(({ state }) => state.kind === "checking");
  return checking ? `Checking where ${checking.name} runs…` : null;
}

export function useLocalHarnessEvalVenues(
  projectId: string,
  harnessIds: readonly LocalHarnessClientId[],
): LocalEvalVenues {
  const ids = HOSTED_MODE ? [] : [...new Set(harnessIds)].sort();
  const key = ids.join(",");
  const [states, setStates] = useState<Partial<Record<LocalHarnessClientId, LocalEvalVenueState>>>({});
  const checks = useRef(new Map<LocalHarnessClientId, AbortController>());
  const setups = useRef(new Map<LocalHarnessClientId, AbortController>());
  const asked = useRef(new Set<string>());
  const put = useCallback((id: LocalHarnessClientId, state: LocalEvalVenueState) => {
    setStates((previous) => ({ ...previous, [id]: state }));
  }, []);

  const check = useCallback(
    (id: LocalHarnessClientId) => {
      checks.current.get(id)?.abort();
      const controller = new AbortController();
      checks.current.set(id, controller);
      put(id, { kind: "checking" });
      fetchLocalHarnessEvalVenue(id, projectId, controller.signal).then(
        (result) => {
          if (!controller.signal.aborted) put(id, stateOf(result, LOCAL_HARNESS_CLIENT_NAMES[id]));
        },
        () => {
          // Only an abort rejects: a newer check, or the sheet closing, owns it.
          if (!controller.signal.aborted) put(id, checkFailed(LOCAL_HARNESS_CLIENT_NAMES[id]));
        },
      );
    },
    [projectId, put],
  );

  const setUp = useCallback(
    (id: LocalHarnessClientId) => {
      const name = LOCAL_HARNESS_CLIENT_NAMES[id];
      setups.current.get(id)?.abort();
      const controller = new AbortController();
      setups.current.set(id, controller);
      put(id, { kind: "setting-up", progress: null });
      const progress = (message: string) => {
        if (!controller.signal.aborted) put(id, { kind: "setting-up", progress: message });
      };
      ensureLocalHarnessReady(projectId, true, controller.signal, progress, id).then(
        () => {
          if (!controller.signal.aborted) check(id);
        },
        (error: unknown) => {
          // Add client's own failure text, with Retry beside it.
          if (controller.signal.aborted) return;
          put(id, {
            kind: "setup-failed",
            message: error instanceof Error && error.message ? error.message : `${name} setup needs a retry.`,
          });
        },
      );
    },
    [projectId, put, check],
  );

  // A project's answers belong to it: switching projects (or closing the
  // sheet) stops its checks and setups, so a late answer can't land on another
  // project's row. An install already started on the server carries on.
  useEffect(() => {
    const running = [checks.current, setups.current];
    const answered = asked.current;
    setStates({});
    return () => {
      for (const controllers of running) {
        for (const controller of controllers.values()) controller.abort();
        controllers.clear();
      }
      answered.clear();
    };
  }, [projectId]);

  // Each harness is asked once per project; a client added later is asked
  // when it appears, and one removed keeps its answer for if it comes back.
  useEffect(() => {
    for (const id of key ? (key.split(",") as LocalHarnessClientId[]) : []) {
      if (asked.current.has(`${projectId}:${id}`)) continue;
      asked.current.add(`${projectId}:${id}`);
      check(id);
    }
  }, [key, projectId, check]);

  const rows = ids.map((id) => ({
    harnessId: id,
    name: LOCAL_HARNESS_CLIENT_NAMES[id],
    state: states[id] ?? { kind: "checking" as const },
  }));
  return { rows, check, setUp, startBlockedReason: localEvalVenueStartBlock(rows) };
}
