import { PluginFormPreviewServices } from "./form-app-preview";
import type { PluginFormPorts } from "../schema-form/PluginFormFields";
import type { ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  useComposerFormRegistration,
  useComposerFormStore,
  useComposerSlot,
} from "./composer-form-store";
import { ComposerFormCard, type ComposerFormAction } from "./ComposerFormCard";
import {
  compileComposerForm,
  logComposerFormDiagnostics,
} from "./form-diagnostics";
import type { PluginFormProfile } from "@/shared/plugin-extensions/form-plan";
import { formResourcePreviewPorts } from "./form-resource-preview";
import { useServerIconSources } from "../host-workspace/plugin-icon-directory";
import { ElicitationDialog } from "../ElicitationDialog";
import { UrlElicitationConsent } from "./UrlElicitationConsent";
import {
  useHostedMrtrStore,
  type HostedMrtrRound,
} from "@/stores/hosted-mrtr-store";
import type { MrtrElicitationResponse } from "@/shared/mrtr-continuation";

/** Stable empty answers reference so `answers` identity is steady across renders. */
const EMPTY_ANSWERS: Record<string, MrtrElicitationResponse> = Object.freeze(
  Object.create(null),
);

/* ------------------------------------------------------------------ *
 * Single-active-dialog election (multi-mount safety)
 *
 * Same hazard, same fix as `MrtrElicitationHost`: the store is a singleton but
 * the VIEW is not, so N co-visible hosts would each render `rounds[0]` and
 * stack N identical dialogs over one suspended operation. Exactly one mounted
 * host (the lowest-numbered still-mounted instance) renders; the rest render
 * `null`. The elections are deliberately SEPARATE from the local host's: a
 * local round and a hosted round are different operations and may legitimately
 * be pending at the same time.
 * ------------------------------------------------------------------ */

const mountedHostIds: number[] = [];
const electionListeners = new Set<() => void>();
let hostIdSeq = 0;

function notifyElection(): void {
  for (const listener of Array.from(electionListeners)) listener();
}

function primaryHostId(): number | null {
  return mountedHostIds.length ? Math.min(...mountedHostIds) : null;
}

/** Whether THIS instance is the elected primary. Hook order stays stable. */
function useIsPrimaryHostedMrtrHost(): boolean {
  const [id] = useState(() => ++hostIdSeq);

  useEffect(() => {
    mountedHostIds.push(id);
    notifyElection();
    return () => {
      const i = mountedHostIds.indexOf(id);
      if (i >= 0) mountedHostIds.splice(i, 1);
      notifyElection();
    };
  }, [id]);

  const subscribe = useCallback((cb: () => void) => {
    electionListeners.add(cb);
    return () => {
      electionListeners.delete(cb);
    };
  }, []);

  return useSyncExternalStore(
    subscribe,
    () => primaryHostId() === id,
    // First paint, before the mount effect registers this id: assume primary so
    // a lone host is never hidden on its initial render.
    () => true,
  );
}

/** Test-only: reset the module-level election between cases. */
export function __resetHostedMrtrHostElection(): void {
  mountedHostIds.length = 0;
  electionListeners.clear();
  hostIdSeq = 0;
}

function counterSuffix(index: number, total: number): string {
  return total > 1 ? ` (${index + 1} of ${total})` : "";
}

/**
 * The wire type of `requestedSchema` is `unknown` (it crosses an untrusted
 * boundary); the dialog takes a plain object. A non-object schema is dropped
 * rather than coerced — the dialog then renders the free-form fallback instead
 * of deriving fields from something that is not a schema.
 */
function asSchemaObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * `HostedMrtrHost` — the HOSTED counterpart of `MrtrElicitationHost`: the rail
 * that renders the reused elicitation dialog for a suspended hosted MRTR round
 * (MCP 2026-07-28 §12.5) and hands the collected `ElicitResult`s back to
 * whichever transport enqueued the round (chat turn resume, or the direct-op
 * `/api/web/mrtr/resume` driver).
 *
 * The local host talks to the SSE-backed local store; this one talks to
 * `hosted-mrtr-store`, whose rounds are durable continuations rather than a
 * driver loop held open in this process. Both render the SAME dialogs, so a
 * user cannot tell (nor should they) which transport a round arrived on.
 *
 * A round may carry several keyed requests. They are collected ONE AT A TIME
 * (spec: show one pending input at a time) into a per-round accumulator held in
 * the singleton store, and the whole round is submitted together. Decline /
 * cancel are RESPONSES (an `ElicitResult`), not withdrawals: they are collected
 * like any other answer and sent back so the server can drive the next leg.
 */
export function HostedMrtrHost() {
  const isPrimary = useIsPrimaryHostedMrtrHost();
  const rounds = useHostedMrtrStore((s) => s.rounds);
  const responding = useHostedMrtrStore((s) => s.responding);
  const collection = useHostedMrtrStore((s) => s.collection);
  const setCollection = useHostedMrtrStore((s) => s.setCollection);
  const submit = useHostedMrtrStore((s) => s.submit);
  // While any chat composer is mounted, an owned plugin round belongs to its
  // own chat's composer card (and waits there while another chat is shown).
  // Without a composer the existing modal rail keeps it answerable.
  const composerMounted = useComposerFormStore((s) => s.slots.length > 0);
  const composerRounds = useMemo(
    () =>
      composerMounted
        ? rounds.filter((round) => isComposerPluginRound(round))
        : [],
    [composerMounted, rounds],
  );

  const activeRound: HostedMrtrRound | null =
    rounds.find((round) => !composerRounds.includes(round)) ?? null;

  // A collection scoped to a different round is stale — a freshly active round
  // always starts at index 0 with no answers.
  const active =
    collection && collection.key === activeRound?.key ? collection : null;
  const index = active?.index ?? 0;
  const answers = active?.answers ?? EMPTY_ANSWERS;

  const requests = activeRound?.requests ?? [];
  const current = requests[index];
  const total = requests.length;

  if (!isPrimary) return null;
  const cards = composerRounds.map((round) => (
    <ComposerMrtrRound key={round.key} round={round} />
  ));
  if (!activeRound || !current) return cards.length ? <>{cards}</> : null;

  const recordAnswer = async (
    key: string,
    answer: MrtrElicitationResponse,
  ): Promise<void> => {
    // Object.assign onto a fresh object: keys are server-chosen and untrusted.
    const next = Object.assign(
      Object.create(null) as Record<string, MrtrElicitationResponse>,
      answers,
      { [key]: answer },
    );
    if (index + 1 < total) {
      setCollection(activeRound.key, index + 1, next);
      return;
    }
    // Last key answered — submit the whole round together. A rejected submit
    // KEEPS the round mounted so the user can retry. Owned plugin editors handle
    // rejection themselves; ordinary dialogs keep their existing error path.
    try {
      await submit(activeRound.key, next);
    } catch (err) {
      if (activeRound.pluginFormProfile) throw err;
      console.error(
        "[hosted-mrtr] Failed to submit round; dialog retained",
        err,
      );
    }
  };

  const counter = counterSuffix(index, total);
  const operation = activeRound.operationLabel
    ? ` for “${activeRound.operationLabel}”`
    : "";

  if (current.mode === "url") {
    const consent = (
      <UrlElicitationConsent
        // Remount per key so popup-blocked / copied state can't bleed across.
        key={`${activeRound.key}:${current.key}`}
        request={{
          // Hosted MRTR URL elicitation carries no server-chosen elicitation id
          // and no completion notification: the user consents (or declines /
          // cancels) and the server retries the suspended operation.
          rendezvousId: `${activeRound.continuationId}:${current.key}`,
          serverId: activeRound.serverId,
          ...(activeRound.serverName
            ? { serverName: activeRound.serverName }
            : {}),
          message:
            (current.message || `Open a link to continue${operation}.`) +
            counter,
          url: current.url,
        }}
        loading={responding}
        onResponse={(action) => recordAnswer(current.key, { action })}
      />
    );
    return (
      <>
        {cards}
        {consent}
      </>
    );
  }

  const renderForm = (services?: {
    ports: PluginFormPorts;
    presentation: ReactNode;
    userResources?: boolean;
    userResourceKinds?: ("file" | "directory")[];
  }) => (
    <ElicitationDialog
      key={`${activeRound.key}:${current.key}`}
      elicitationRequest={{
        requestId: `${activeRound.continuationId}:${current.key}`,
        message:
          (current.message || `This operation needs input${operation}.`) +
          counter,
        schema: asSchemaObject(current.requestedSchema),
        timestamp: activeRound.timestamp,
        origin: "mrtr",
        serverId: activeRound.serverId,
        ...(activeRound.serverName
          ? { serverName: activeRound.serverName }
          : {}),
      }}
      loading={responding}
      pluginForm={
        activeRound.pluginFormProfile
          ? {
              profile: {
                ...activeRound.pluginFormProfile,
                userResources: services?.userResources ?? false,
                userResourceKinds: services?.userResourceKinds ?? [],
                previews:
                  activeRound.pluginFormProfile.previews &&
                  !!activeRound.pluginFormServiceScope &&
                  !!current.pluginFormSourceToken,
              },
              presentation: services?.presentation,
              ports:
                services?.ports ??
                (activeRound.pluginFormServiceScope
                  ? formResourcePreviewPorts(
                      activeRound.pluginFormServiceScope,
                      current.pluginFormSourceToken,
                      {
                        kind: "mrtr",
                        id: activeRound.continuationId,
                        round: activeRound.round,
                        inputRequestKey: current.key,
                      },
                      activeRound.expiresAt,
                      {
                        serverId: activeRound.serverId,
                        serverName: activeRound.serverName,
                      },
                    )
                  : undefined),
            }
          : undefined
      }
      onResponse={async (action, parameters) =>
        recordAnswer(current.key, {
          action,
          ...(action === "accept" && parameters ? { content: parameters } : {}),
        })
      }
    />
  );
  const dialog =
    activeRound.pluginFormServiceScope && current.pluginFormSourceToken ? (
    <PluginFormPreviewServices
      scope={activeRound.pluginFormServiceScope}
      server={{
        serverId: activeRound.serverId,
        serverName: activeRound.serverName,
      }}
      sourceToken={current.pluginFormSourceToken}
      parent={{
        kind: "mrtr",
        id: activeRound.continuationId,
        round: activeRound.round,
        inputRequestKey: current.key,
      }}
      expiresAt={activeRound.expiresAt}
      schema={current.requestedSchema}
      onCancel={() => recordAnswer(current.key, { action: "cancel" })}
    >
      {renderForm}
    </PluginFormPreviewServices>
  ) : (
    renderForm()
  );
  return (
    <>
      {cards}
      {dialog}
    </>
  );
}

/** Owned plugin rounds the composer can present: forms with a chat scope. */
function isComposerPluginRound(round: HostedMrtrRound) {
  return (
    !!round.pluginFormProfile &&
    !!round.pluginFormServiceScope &&
    round.requests.length > 0 &&
    round.requests.every((request) => request.mode === "form")
  );
}

/**
 * One owned plugin round in its chat's composer. Its keyed requests are
 * collected one card at a time and submitted together; × answers `cancel` for
 * the rest of the round.
 */
function ComposerMrtrRound({ round }: { round: HostedMrtrRound }) {
  const scope = round.pluginFormServiceScope!;
  const serverName = round.serverName?.trim() || round.serverId;
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<
    Record<string, MrtrElicitationResponse>
  >(() => Object.create(null));
  const queue = useComposerFormRegistration({
    id: round.key,
    workspaceId: scope.workspaceId,
    serverName,
    cancel: () => useHostedMrtrStore.getState().cancel(round.key),
  });
  const slot = useComposerSlot(scope.workspaceId);
  const current = round.requests[Math.min(index, round.requests.length - 1)];
  if (!queue.active || !slot || !current) return null;

  const respond = async (
    action: ComposerFormAction,
    content?: Record<string, unknown>,
  ) => {
    const next = Object.assign(
      Object.create(null) as Record<string, MrtrElicitationResponse>,
      answers,
    );
    if (action === "cancel") {
      for (const request of round.requests.slice(index))
        next[request.key] = { action: "cancel" };
    } else {
      next[current.key] = {
        action,
        ...(action === "accept" && content ? { content } : {}),
      };
      if (index + 1 < round.requests.length) {
        setAnswers(next);
        setIndex(index + 1);
        return;
      }
    }
    // A rejected submit keeps the round (and the card) for a retry.
    await useHostedMrtrStore.getState().submit(round.key, next);
  };
  const profile: PluginFormProfile = {
    ...round.pluginFormProfile!,
    previews:
      round.pluginFormProfile!.previews && !!current.pluginFormSourceToken,
  };
  const parent = {
    kind: "mrtr" as const,
    id: round.continuationId,
    round: round.round,
    inputRequestKey: current.key,
  };
  const card = (services?: {
    ports: PluginFormPorts;
    presentation: ReactNode;
    userResources?: boolean;
    userResourceKinds?: ("file" | "directory")[];
  }) => (
    <MrtrComposerCard
      key={`${round.key}:${current.key}`}
      requestId={`${round.continuationId}:${current.key}`}
      serverId={round.serverId}
      serverName={serverName}
      title={
        current.message ||
        (round.operationLabel
          ? `This operation needs input for “${round.operationLabel}”.`
          : "This operation needs input.")
      }
      schema={current.requestedSchema}
      profile={{
        ...profile,
        userResources: services?.userResources ?? false,
        userResourceKinds: services?.userResourceKinds ?? [],
      }}
      ports={
        services?.ports ??
        formResourcePreviewPorts(
          scope,
          current.pluginFormSourceToken,
          parent,
          round.expiresAt,
          { serverId: round.serverId, serverName },
        )
      }
      presentation={services?.presentation}
      onRespond={respond}
    />
  );
  return createPortal(
    current.pluginFormSourceToken ? (
      <PluginFormPreviewServices
        key={`${round.key}:${current.key}`}
        scope={scope}
        server={{ serverId: round.serverId, serverName }}
        sourceToken={current.pluginFormSourceToken}
        parent={parent}
        expiresAt={round.expiresAt}
        schema={current.requestedSchema}
        onCancel={() => respond("cancel")}
      >
        {card}
      </PluginFormPreviewServices>
    ) : (
      card()
    ),
    slot,
  );
}

function MrtrComposerCard({
  requestId,
  serverId,
  serverName,
  title,
  schema,
  profile,
  ports,
  presentation,
  onRespond,
}: {
  requestId: string;
  serverId: string;
  serverName: string;
  title: string;
  schema: unknown;
  profile: PluginFormProfile;
  ports?: PluginFormPorts;
  presentation?: ReactNode;
  onRespond: (
    action: ComposerFormAction,
    content?: Record<string, unknown>,
  ) => Promise<void>;
}) {
  const profileKey = JSON.stringify([
    profile,
    !!ports?.chooseResources,
    !!ports?.preview,
  ]);
  const compiled = useMemo(
    () =>
      compileComposerForm(asSchemaObject(schema), {
        ...profile,
        userResources: profile.userResources && !!ports?.chooseResources,
        previews: profile.previews && !!ports?.preview,
      }),
    // One keyed request is immutable; a different one remounts this card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requestId, profileKey],
  );
  const icons = useServerIconSources(serverId);
  useEffect(() => {
    logComposerFormDiagnostics(compiled, { serverId, serverName });
  }, [compiled, serverId, serverName]);
  return (
    <ComposerFormCard
      requestId={requestId}
      title={title}
      serverName={serverName}
      icons={icons}
      plan={compiled.plan}
      unsupported={compiled.unsupported}
      ports={ports}
      presentation={presentation}
      onRespond={onRespond}
    />
  );
}
