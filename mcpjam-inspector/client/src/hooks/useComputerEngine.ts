/**
 * The Local⇄Cloud computer-engine choice, resolved for a project.
 *
 * ONE rule, applied everywhere (Computer tab, Playground rail, chat body
 * builder), so the badge can never say "This machine" while commands go
 * elsewhere:
 *
 *   1. HOSTED_MODE ⇒ cloud. Toggle hidden, storage never read.
 *   2. Candidates in order: stored preference → server defaultEngine →
 *      local → cloud. The first candidate that is AVAILABLE — and, for
 *      `local`, whose consent capability is SERVER-VERIFIED — wins.
 *   3. Nothing qualifies ⇒ `cloud` with `cloudAvailable:false`; consumers
 *      render the existing unavailable state.
 *
 * Consent GATES the engine: an unconsented machine never resolves local —
 * selecting Local is what opens the consent dialog (PR 6/7 UI), and a grant
 * flips the resolution over. "Default = Local in local mode" means the
 * server's `defaultEngine:"local"` wins the candidate race as soon as
 * consent exists — no stored preference required.
 */
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { HOSTED_MODE } from "@/lib/config";
import {
  loadComputerEngine,
  saveComputerEngine,
  subscribeComputerEngine,
  type ComputerEngineChoice,
} from "@/lib/computer-engine-storage";
import {
  useLocalComputerConsent,
  type LocalComputerConsent,
} from "@/hooks/useLocalComputerConsent";
import { useComputersDataPlaneConfig } from "@/hooks/useProjectComputer";

export interface ComputerEngineState {
  /**
   * Resolved engine for EXECUTION — consent-gated: `local` only when consent
   * is granted. Chat/rail/terminal run against this; the badge follows it, so
   * it never says "This machine" while commands go to the cloud.
   */
  engine: ComputerEngineChoice;
  /**
   * The user's SELECTED engine — the same candidate order as `engine` but
   * consent-BLIND (`local` qualifies on availability alone). This is what the
   * Local⇄Cloud toggle shows and which FACE the Computer tab renders: picking
   * "This machine" before consenting must show the local face's consent gate,
   * not bounce to cloud. Execution still waits on `engine`/consent.
   */
  selectedEngine: ComputerEngineChoice;
  /** Persist a preference for this project (and notify every consumer). */
  setEngine: (engine: ComputerEngineChoice) => void;
  /** Config fetch settled (the answer below is real, not loading defaults). */
  resolved: boolean;
  localAvailable: boolean;
  localTerminalAvailable: boolean;
  /** Tilde display root; render `${workspaceDisplayRoot}/<projectId>`. */
  workspaceDisplayRoot: string | null;
  cloudAvailable: boolean;
  /** Show the Local⇄Cloud switcher — both engines exist and we're not hosted. */
  toggleVisible: boolean;
  /** The consent capability backing the local engine (grant/revoke/status). */
  consent: LocalComputerConsent;
}

export function useComputerEngine(
  projectId: string | null,
): ComputerEngineState {
  const config = useComputersDataPlaneConfig();
  const consent = useLocalComputerConsent();
  // Read the stored preference SYNCHRONOUSLY, keyed to the CURRENT projectId —
  // via useSyncExternalStore rather than a passive effect, so a project switch
  // never renders once with the previous project's preference (and switching
  // to null yields null immediately instead of stranding a stale value). The
  // snapshot is a primitive, so React's value-compare handles re-render.
  const { subscribe, getSnapshot } = useMemo(() => {
    if (HOSTED_MODE || !projectId) {
      return { subscribe: () => () => {}, getSnapshot: () => null };
    }
    return {
      subscribe: (cb: () => void) => subscribeComputerEngine(projectId, cb),
      getSnapshot: () => loadComputerEngine(projectId),
    };
  }, [projectId]);
  const storedPref = useSyncExternalStore(subscribe, getSnapshot, () => null);

  const setEngine = useCallback(
    (engine: ComputerEngineChoice) => {
      if (HOSTED_MODE || !projectId) return;
      saveComputerEngine(projectId, engine);
    },
    [projectId],
  );

  const localAvailable = !HOSTED_MODE && (config?.engines.local.available ?? false);
  const cloudAvailable = config?.engines.cloud.available ?? false;

  let engine: ComputerEngineChoice = "cloud";
  let selectedEngine: ComputerEngineChoice = "cloud";
  if (!HOSTED_MODE && config) {
    const candidates: Array<ComputerEngineChoice | null> = [
      storedPref,
      config.defaultEngine,
      "local",
      "cloud",
    ];
    // Consent-blind: which engine the user has SELECTED / would default to.
    const selectable = (candidate: ComputerEngineChoice | null): boolean =>
      candidate === "local"
        ? localAvailable
        : candidate === "cloud"
          ? cloudAvailable
          : false;
    selectedEngine =
      (candidates.find(selectable) as ComputerEngineChoice) ?? "cloud";
    // Execution-resolved: `local` additionally requires granted consent.
    const qualifies = (candidate: ComputerEngineChoice | null): boolean =>
      candidate === "local"
        ? localAvailable && consent.granted
        : candidate === "cloud"
          ? cloudAvailable
          : false;
    engine = (candidates.find(qualifies) as ComputerEngineChoice) ?? "cloud";
  }

  return {
    engine,
    selectedEngine,
    setEngine,
    resolved: config !== undefined,
    localAvailable,
    localTerminalAvailable:
      !HOSTED_MODE && (config?.engines.local.terminalAvailable ?? false),
    workspaceDisplayRoot: HOSTED_MODE
      ? null
      : (config?.engines.local.workspaceDisplayRoot ?? null),
    cloudAvailable,
    toggleVisible: !HOSTED_MODE && localAvailable && cloudAvailable,
    consent,
  };
}
