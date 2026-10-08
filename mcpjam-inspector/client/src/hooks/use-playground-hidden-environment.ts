import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConvex } from "convex/react";
import {
  activePluginServers,
  activePluginsRuntimeVenue,
  useActivePlugins,
  type ActivePluginServer,
} from "@/hooks/useActivePlugins";
import { useEnsureAdhocEnvironment } from "@/hooks/useProjectEnvironments";
import { useIsMemberActor } from "@/hooks/use-is-member-actor";
import { useProjectSecrets } from "@/hooks/useProjectSecrets";
import type { HiddenEnvironmentRecovery } from "@/lib/hosted-runtime-context";
import type {
  ActivePluginRow,
  ActivePluginsResult,
} from "@/lib/plugins/active-plugins-types";
import {
  hiddenEnvironmentCompositionKey,
  isRunnablePlugin,
  runnablePluginServerIds,
  runnablePluginVersionIds,
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
 */

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
  /** The runnable plugins' servers, labelled with their plugin. */
  pluginServers: ActivePluginServer[];
  /** True when the chat has runnable plugins and should carry them. */
  wanted: boolean;
  /** The composed environment, once ensured. */
  environmentId: string | null;
  /** The servers the composed environment's plugins add. */
  pluginServerIds: string[];
  /** Composing failed; the chat runs as a plain client turn. */
  failed: boolean;
  /** Re-read the plugins and recompose (one retry after a refusal). */
  recover: () => Promise<HiddenEnvironmentRecovery>;
}

type Composition = {
  key: string;
  projectId: string;
  hostId: string;
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
    }
  /** No plugin is runnable after a re-read: a plain client turn. */
  | { key: string; status: "none" }
  | { key: string; status: "failed" };

const EMPTY_SERVERS: ActivePluginServer[] = [];

export function usePlaygroundHiddenEnvironment(
  input: PlaygroundHiddenEnvironmentInput,
): PlaygroundHiddenEnvironmentState {
  const { projectId, eligible, hostId, harnessId, hostResolved } = input;
  const isMember = useIsMemberActor() === true;
  const active = useActivePlugins(eligible && isMember ? projectId : null);
  const plugins = active.plugins;

  const runnable = useMemo(() => plugins.filter(isRunnablePlugin), [plugins]);
  const pluginVersionIds = useMemo(
    () => runnablePluginVersionIds(runnable),
    [runnable],
  );
  const pluginServerIds = useMemo(
    () => runnablePluginServerIds(runnable),
    [runnable],
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
    if (!eligible || !isMember || !projectId || !hostId) return null;
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
      }),
      projectId,
      hostId,
      pluginVersionIds,
      pluginServerIds,
      ...(secretSelection ? { secretSelection } : {}),
    };
  }, [
    eligible,
    isMember,
    projectId,
    hostId,
    hostResolved,
    pluginVersionIds,
    pluginServerIds,
    credential,
  ]);
  const compositionRef = useRef(composition);
  compositionRef.current = composition;
  const compositionKey =
    composition && composition !== "loading" ? composition.key : null;
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
      const result = await ensureRef.current({
        projectId: target.projectId,
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
        });
      },
      (error: unknown) => {
        if (cancelled) return;
        console.warn(
          "[playground] couldn't prepare this chat's plugins; it runs without them",
          error,
        );
        setComposed({ key: target.key, status: "failed" });
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
      // A fresh read, not the subscription's last answer: the refusal says
      // the plugins changed, and the reactive copy may not have caught up.
      const fresh = (await convex.query(
        "plugins:resolveActivePlugins" as never,
        {
          projectId: target.projectId,
          content: false,
          runtimeVenue: activePluginsRuntimeVenue(),
        } as never,
      )) as ActivePluginsResult | null | undefined;
      const rows =
        fresh?.enabled === true && Array.isArray(fresh.plugins)
          ? fresh.plugins
          : [];
      if (superseded()) return { ok: false };
      const versionIds = runnablePluginVersionIds(rows);
      if (versionIds.length === 0) {
        setComposed({ key: target.key, status: "none" });
        return { ok: true, environmentId: null };
      }
      const serverIds = runnablePluginServerIds(rows);
      const environmentId = await ensureFor(target, versionIds);
      if (superseded()) return { ok: false };
      // Held under the CURRENT key until the subscription moves on, at which
      // point the ordinary composition above takes over again.
      setComposed({
        key: target.key,
        status: "ready",
        environmentId,
        pluginServerIds: serverIds,
      });
      return { ok: true, environmentId, pluginServerIds: serverIds };
    } catch (error) {
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
    current?.status !== "none" &&
    current?.status !== "failed";

  return {
    plugins,
    pluginServers: wanted ? pluginServers : EMPTY_SERVERS,
    wanted,
    environmentId: current?.status === "ready" ? current.environmentId : null,
    pluginServerIds:
      current?.status === "ready" ? current.pluginServerIds : pluginServerIds,
    failed: current?.status === "failed",
    recover,
  };
}
