import { ensureChatEnvironment } from "@/lib/plugins/ensure-chat-environment";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";
import {
  activePluginServers,
  refusesComponentAdmission,
  useActivePlugins,
  type ActivePluginServer,
} from "@/hooks/useActivePlugins";
import { useEnsureAdhocEnvironment } from "@/hooks/useProjectEnvironments";
import { useIsMemberActor } from "@/hooks/use-is-member-actor";
import { useLocalHarnessRunsHere } from "@/hooks/useLocalHarnessTarget";
import { usePluginServerNotices } from "@/hooks/use-plugin-server-notices";
import { usePluginServerSignIn } from "@/hooks/usePluginServerSignIn";
import { registerPluginNoticeSignIn } from "@/lib/plugins/plugin-notice-display";
import { usePluginsEnabled } from "@/hooks/usePluginsEnabled";
import { useProjectSecrets } from "@/hooks/useProjectSecrets";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import { HOSTED_MODE } from "@/lib/config";
import {
  hasOnboardingAfterSignIn,
  resumeOnboardingAfterSignIn,
} from "@/lib/plugin-onboarding-intent";
import type { HiddenEnvironmentRecovery } from "@/lib/hosted-runtime-context";
import type {
  ActivePluginRow,
  ActivePluginsResult,
} from "@/lib/plugins/active-plugins-types";
import {
  hiddenEnvironmentCompositionKey,
  hiddenEnvironmentVenue,
  isRunnablePlugin,
  needsLocalVenue,
  runnablePluginServerIds,
  runnablePluginVersionIds,
  type HiddenEnvironmentVenue,
} from "@/lib/plugins/hidden-environment";
import {
  externalAccountCredentialFor,
  externalCredentialSecretSelection,
} from "@/shared/external-credential-selection";

/**
 * Composes the hidden ad-hoc environment a Playground chat runs its plugins
 * through while the environments UI is off (see
 * `lib/plugins/hidden-environment.ts`).
 *
 * One environment per (client, runnable plugin version set): it is ensured
 * when that composition first appears or changes, never per message, and the
 * backend dedupes it by fingerprint. Without a runnable plugin nothing is
 * composed and the chat stays a plain client turn.
 *
 * Until the plugin read has answered, the chat cannot know whether it has
 * plugins, so sends wait (as they do while composing) rather than going out
 * without them. That wait is bounded: past {@link HIDDEN_ENVIRONMENT_WAIT_MS},
 * or if the read fails, the chat runs as a plain client turn and says its
 * plugins couldn't load.
 */

/** How long sends wait for the plugin read before running without plugins. */
export const HIDDEN_ENVIRONMENT_WAIT_MS = 5000;

export interface PlaygroundHiddenEnvironmentInput {
  projectId: string | null;
  /**
   * The chat may run as a hidden environment at all: the environments UI is
   * off and this is the member's own live chat (not a shared transcript or
   * another member's reopened one).
   */
  eligible: boolean;
  /** The chat's client. No client, nothing to compose. */
  hostId: string | null;
  /** The client's harness, for the key a Cursor client must carry. */
  harnessId: string | null | undefined;
  /**
   * The client's settings have loaded, so `harnessId` is its answer rather
   * than a gap. Until then nothing is composed (and sends wait), so a Cursor
   * client is never composed without the key it needs.
   */
  hostResolved: boolean;
}

export interface PlaygroundHiddenEnvironmentState {
  /** Every installed plugin as a chat would see it, active or skipped. */
  plugins: ActivePluginRow[];
  /** At least one of them runs in this chat's venue. */
  hasRunnablePlugins: boolean;
  /** Where the composed plugins run (see `hiddenEnvironmentVenue`). */
  venue: HiddenEnvironmentVenue;
  /** The runnable plugins' servers, labelled with their plugin. */
  pluginServers: ActivePluginServer[];
  /** True when the chat has runnable plugins and should carry them. */
  wanted: boolean;
  /** The composed environment, once ensured. */
  environmentId: string | null;
  /** The servers the composed environment's plugins add. */
  pluginServerIds: string[];
  /**
   * Composing failed, the plugin read failed, or it did not answer in time;
   * the chat runs as a plain client turn.
   */
  failed: boolean;
  blockingError?: string;
  /** Re-read the plugins and recompose (one retry after a refusal). */
  recover: () => Promise<HiddenEnvironmentRecovery>;
}

type Composition = {
  key: string;
  projectId: string;
  hostId: string;
  venue: HiddenEnvironmentVenue;
  /** The member runs this chat's client here: what both venues come from. */
  clientRunsHere: boolean;
  pluginVersionIds: string[];
  pluginServerIds: string[];
  secretSelection?: { mode: "explicit"; secretIds: string[] };
};

type Composed =
  | {
      key: string;
      status: "ready";
      environmentId: string;
      pluginServerIds: string[];
      /**
       * The live read's server ids when this was composed. Once they change,
       * the live ids win: a sign-in changes which servers run without
       * changing the composition key.
       */
      liveServerIds: string[];
    }
  /** No plugin is runnable after a re-read: a plain client turn. */
  | { key: string; status: "none" }
  | { key: string; status: "failed"; blockingError?: string };

const EMPTY_SERVERS: ActivePluginServer[] = [];
const NO_PLUGINS: ActivePluginRow[] = [];

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

export function usePlaygroundHiddenEnvironment(
  input: PlaygroundHiddenEnvironmentInput,
): PlaygroundHiddenEnvironmentState {
  const { projectId, eligible, hostId, harnessId, hostResolved } = input;
  const pluginsEnabled = usePluginsEnabled();
  const memberActor = useIsMemberActor();
  const isMember = memberActor === true;
  // The member's own choice to run this chat's client here. The plugins are
  // read for that venue, so one that starts a process here comes back
  // runnable rather than skipped. The composition takes the venue only when
  // such a plugin is there to run.
  const clientRunsHere = useLocalHarnessRunsHere({ projectId, harnessId });
  // A Set up that signed in first comes back here, after the redirect, and
  // the first plugins read that answers makes it or drops it. So the plugins
  // are also read until then; the chat itself uses them only when eligible.
  const [settledFor, setSettledFor] = useState<string | null>(null);
  const awaitingSignIn = useMemo(
    () =>
      !!projectId &&
      settledFor !== projectId &&
      hasOnboardingAfterSignIn(projectId),
    [projectId, settledFor],
  );
  const readsPlugins = eligible && isMember;
  const active = useActivePlugins(
    readsPlugins || (awaitingSignIn && isMember) ? projectId : null,
    {
      runtimeVenue: hiddenEnvironmentVenue({
        hostedMode: HOSTED_MODE,
        clientRunsHere,
        needsLocal: true,
      }),
    },
  );
  const { answered, plugins: read } = active;
  useEffect(() => {
    if (!projectId || !awaitingSignIn || !answered) return;
    resumeOnboardingAfterSignIn(projectId, read);
    setSettledFor(projectId);
  }, [projectId, awaitingSignIn, answered, read]);
  const plugins = readsPlugins ? active.plugins : NO_PLUGINS;
  const venue = hiddenEnvironmentVenue({
    hostedMode: HOSTED_MODE,
    clientRunsHere,
    needsLocal: plugins.some(needsLocalVenue),
  });
  // The chat's plugin notices offer the same Sign in as the server's card, for
  // the members whose plugins they name. Registered before the notices below
  // replay, so a notice a remount replays already carries it.
  const pluginSignIn = usePluginServerSignIn(
    eligible && isMember ? projectId : null,
  );
  const { available: canSignIn, signIn } = pluginSignIn;
  useEffect(
    () =>
      canSignIn
        ? registerPluginNoticeSignIn((binding) => void signIn(binding))
        : undefined,
    [canSignIn, signIn],
  );
  usePluginServerNotices(plugins);
  // No authoritative answer yet: who this is, or which plugins it has. An
  // empty list here is not "no plugins". Only for a chat that could have
  // plugins at all (the flag is on, a real project and a client).
  const pluginsPending =
    eligible &&
    pluginsEnabled &&
    !!hostId &&
    shouldQueryProjectId(projectId) &&
    (memberActor === undefined || (isMember && active.isLoading));
  const readFailed = eligible && isMember && active.failed;

  const runnable = useMemo(
    () => plugins.filter((plugin) => isRunnablePlugin(plugin, venue)),
    [plugins, venue],
  );
  const pluginVersionIds = useMemo(
    () => runnablePluginVersionIds(runnable, venue),
    [runnable, venue],
  );
  const pluginServerIds = useMemo(
    () => runnablePluginServerIds(runnable, venue),
    [runnable, venue],
  );
  const pluginServers = useMemo(
    () => (runnable.length > 0 ? activePluginServers(runnable) : EMPTY_SERVERS),
    [runnable],
  );

  // A client that signs in with the member's own account (Cursor) runs on a
  // box that holds that key only if its environment grants it, exactly as the
  // client turn's own hidden grant does. Read only when such a client has
  // something to run.
  const needsCredential = !!externalAccountCredentialFor(
    harnessId ?? undefined,
  );
  const projectSecrets = useProjectSecrets(
    needsCredential && pluginVersionIds.length > 0 ? projectId : null,
  );
  const credential = useMemo(():
    | { status: "none" }
    | { status: "loading" }
    | { status: "missing" }
    | {
        status: "granted";
        selection: { mode: "explicit"; secretIds: string[] };
      } => {
    if (!needsCredential) return { status: "none" };
    if (projectSecrets === undefined) return { status: "loading" };
    try {
      const selection = externalCredentialSecretSelection(
        { harness: harnessId ?? null },
        projectSecrets,
      );
      return selection ? { status: "granted", selection } : { status: "none" };
    } catch {
      // No usable key. The client turn refuses this with the copy that says
      // where to add one, so the chat stays on it rather than composing an
      // environment that would be refused with less helpful words.
      return { status: "missing" };
    }
  }, [needsCredential, projectSecrets, harnessId]);

  const composition = useMemo((): Composition | "loading" | null => {
    if (pluginsPending) return "loading";
    if (!eligible || !projectId || !hostId) return null;
    if (pluginVersionIds.length === 0) return null;
    if (!hostResolved) return "loading";
    if (credential.status === "missing") return null;
    if (credential.status === "loading") return "loading";
    const secretSelection =
      credential.status === "granted" ? credential.selection : undefined;
    return {
      key: hiddenEnvironmentCompositionKey({
        hostId,
        pluginVersionIds,
        secretIds: secretSelection?.secretIds,
        venue,
      }),
      projectId,
      hostId,
      venue,
      clientRunsHere,
      pluginVersionIds,
      pluginServerIds,
      ...(secretSelection ? { secretSelection } : {}),
    };
  }, [
    pluginsPending,
    eligible,
    isMember,
    projectId,
    hostId,
    hostResolved,
    venue,
    clientRunsHere,
    pluginVersionIds,
    pluginServerIds,
    credential,
  ]);
  const compositionRef = useRef(composition);
  compositionRef.current = composition;
  const compositionKey =
    composition && composition !== "loading" ? composition.key : null;

  // Sends wait while the composition is pending, but not forever.
  const waitKey =
    composition === "loading"
      ? `${projectId ?? ""}\u0000${hostId ?? ""}`
      : null;
  const [timedOutKey, setTimedOutKey] = useState<string | null>(null);
  useEffect(() => {
    if (waitKey === null) {
      setTimedOutKey(null);
      return;
    }
    const timer = setTimeout(
      () => setTimedOutKey(waitKey),
      HIDDEN_ENVIRONMENT_WAIT_MS,
    );
    return () => clearTimeout(timer);
  }, [waitKey]);
  const waitTimedOut = waitKey !== null && timedOutKey === waitKey;
  // Moves on every time the composition's key does, including through
  // "nothing composed". A key alone cannot tell an A→B→A switch from no
  // switch at all; this can.
  const keyEpochRef = useRef({ key: compositionKey, epoch: 0 });
  if (keyEpochRef.current.key !== compositionKey) {
    keyEpochRef.current = {
      key: compositionKey,
      epoch: keyEpochRef.current.epoch + 1,
    };
  }

  const ensureAdhocEnvironment = useEnsureAdhocEnvironment();
  const ensureRef = useRef(ensureAdhocEnvironment);
  ensureRef.current = ensureAdhocEnvironment;
  const convex = useConvex();

  const [composed, setComposed] = useState<Composed | null>(null);
  const composedRef = useRef(composed);
  composedRef.current = composed;

  const ensureFor = useCallback(
    async (target: Composition, versionIds: string[]): Promise<string> => {
      const result = await ensureChatEnvironment(ensureRef.current, {
        projectId: target.projectId,
        purpose: "chat",
        hostId: target.hostId,
        // No stored servers: each turn names the chat's own selection.
        serverSelection: { mode: "none" },
        pluginVersionIds: versionIds,
        ...(target.secretSelection
          ? { secretSelection: target.secretSelection }
          : {}),
      });
      return result.environment.environmentId;
    },
    [],
  );

  // Ensure on a NEW composition only. Re-renders, refetches of the same
  // plugin set and sends never reach the backend.
  useEffect(() => {
    const target = compositionRef.current;
    if (!compositionKey || !target || target === "loading") return;
    if (composedRef.current?.key === compositionKey) return;
    let cancelled = false;
    ensureFor(target, target.pluginVersionIds).then(
      (environmentId) => {
        if (cancelled) return;
        setComposed({
          key: target.key,
          status: "ready",
          environmentId,
          pluginServerIds: target.pluginServerIds,
          liveServerIds: target.pluginServerIds,
        });
      },
      (error: unknown) => {
        if (cancelled) return;
        console.warn(
          "[playground] couldn't prepare this chat's plugins; it runs without them",
          error,
        );
        setComposed({
          key: target.key,
          status: "failed",
          blockingError: hiddenEnvironmentLimitError(error),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [compositionKey, ensureFor]);

  const recover = useCallback(async (): Promise<HiddenEnvironmentRecovery> => {
    const target = compositionRef.current;
    if (!target || target === "loading") return { ok: false };
    const epoch = keyEpochRef.current.epoch;
    // The client or the plugin set changed while this was in flight. Its
    // answer is for a composition the chat no longer has: writing it would
    // overwrite the newer one's state, and replaying onto it would send the
    // turn to the previous client's environment.
    const superseded = () => {
      const now = compositionRef.current;
      return (
        !now ||
        now === "loading" ||
        now.key !== target.key ||
        keyEpochRef.current.epoch !== epoch
      );
    };
    try {
      // Read and composed as the subscription does, so a plugin that now
      // starts a process here moves a hosted composition to this client.
      const venueFor = (needsLocal: boolean) =>
        hiddenEnvironmentVenue({
          hostedMode: HOSTED_MODE,
          clientRunsHere: target.clientRunsHere,
          needsLocal,
        });
      // A fresh read, not the subscription's last answer: the refusal says
      // the plugins changed, and the reactive copy may not have caught up.
      const args = {
        projectId: target.projectId,
        content: false,
        runtimeVenue: venueFor(true),
      };
      const read = (extra: object) =>
        convex.query(
          "plugins:resolveActivePlugins" as never,
          { ...args, ...extra } as never,
        ) as Promise<ActivePluginsResult | null | undefined>;
      const fresh = await read({ componentAdmission: true }).catch((error) => {
        if (refusesComponentAdmission(error)) return read({});
        throw error;
      });
      const rows =
        fresh?.enabled === true && Array.isArray(fresh.plugins)
          ? fresh.plugins
          : [];
      if (superseded()) return { ok: false };
      const venue = venueFor(rows.some(needsLocalVenue));
      const versionIds = runnablePluginVersionIds(rows, venue);
      if (versionIds.length === 0) {
        setComposed({ key: target.key, status: "none" });
        return { ok: true, environmentId: null };
      }
      const serverIds = runnablePluginServerIds(rows, venue);
      const environmentId = await ensureFor(target, versionIds);
      if (superseded()) return { ok: false };
      // Held under the CURRENT key until the subscription moves on, at which
      // point the ordinary composition above takes over again.
      setComposed({
        key: target.key,
        status: "ready",
        environmentId,
        pluginServerIds: serverIds,
        liveServerIds: target.pluginServerIds,
      });
      return { ok: true, environmentId, pluginServerIds: serverIds };
    } catch (error) {
      const blockingError = hiddenEnvironmentLimitError(error);
      if (blockingError)
        setComposed({ key: target.key, status: "failed", blockingError });
      console.warn(
        "[playground] couldn't recompose this chat's plugins",
        error,
      );
      return { ok: false };
    }
  }, [convex, ensureFor]);

  const current =
    composed && compositionKey && composed.key === compositionKey
      ? composed
      : null;
  const wanted =
    composition !== null &&
    !waitTimedOut &&
    current?.status !== "none" &&
    current?.status !== "failed";

  return {
    plugins,
    hasRunnablePlugins: runnable.length > 0,
    venue,
    pluginServers: wanted ? pluginServers : EMPTY_SERVERS,
    wanted,
    environmentId: current?.status === "ready" ? current.environmentId : null,
    pluginServerIds:
      current?.status === "ready" &&
      sameIds(current.liveServerIds, pluginServerIds)
        ? current.pluginServerIds
        : pluginServerIds,
    failed: current?.status === "failed" || waitTimedOut || readFailed,
    blockingError:
      current?.status === "failed" ? current.blockingError : undefined,
    recover,
  };
}

export function hiddenEnvironmentLimitError(
  error: unknown,
): string | undefined {
  if (!error || typeof error !== "object" || !("data" in error))
    return undefined;
  const data = error.data;
  if (
    !data ||
    typeof data !== "object" ||
    !("code" in data) ||
    data.code !== "ENV_ADHOC_LIMIT"
  )
    return undefined;
  return "message" in data && typeof data.message === "string"
    ? data.message
    : "This project has reached its environment limit. Try an existing setup.";
}
