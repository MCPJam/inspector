import { useEffect, useMemo, useRef, useState } from "react";
import { useConvexAuth } from "convex/react";
import { ChevronDown, ChevronLeft, Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { Switch } from "@mcpjam/design-system/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { EnvironmentComposer } from "@/components/environment-composer/environment-composer";
import { ProgressStepper } from "@/components/shared/progress-stepper";
import { RequiredMark } from "@/components/shared/required-mark";
import { ScenarioTaskListEditor } from "@/components/scenarios/ScenarioTaskListEditor";
import {
  emptyComposerState,
  emptyEnvironmentStack,
  isComposeMode,
  type EnvironmentComposerState,
} from "@/components/environment-composer/environment-stack";
import { useComposerResolver } from "@/components/environment-composer/use-composer-resolver";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { useHostList, type HostListItem } from "@/hooks/useClients";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { saveEnvironmentDraftSeed } from "@/lib/environment-draft-seed";
import { environmentLabel } from "@/lib/environment-label";
import { useEffectiveSharePolicy } from "@/hooks/useOrgSharePolicy";
import {
  applyShareCeilingToScenarioOptions,
  clampScenarioAccessPreset,
  SCENARIO_ACCESS_OPTIONS as ACCESS_OPTIONS,
  settingsFromScenarioAccessPreset,
  type ScenarioAccessPreset,
} from "@/lib/scenario-access-presets";
import {
  emptyScenarioTaskDraft,
  scenarioTasksFromDrafts,
  type ScenarioTaskDraft,
} from "@/lib/scenario-tasks";
import type { ScenarioMode } from "@/hooks/useScenarios";
import type {
  ScenarioPerTurnFeedbackStyle,
  ScenarioTaskItem,
} from "@/types/chatUi";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** Rating widget styles, in the frame's order and wording. */
const RATING_STYLE_OPTIONS: ReadonlyArray<{
  value: ScenarioPerTurnFeedbackStyle;
  label: string;
}> = [
  { value: "stars", label: "1-5 Star Ratings" },
  { value: "thumbs", label: "Thumbs-Up/Down Ratings" },
];

const CREATE_STEPS = [
  { id: "study", label: "Set up study" },
  { id: "tasks", label: "Create tasks" },
] as const;

type CreateStep = (typeof CREATE_STEPS)[number]["id"];

/** Last-resort study name, for a creator who cleared the suggestion. */
const FALLBACK_STUDY_NAME = "User test";

/**
 * The client a project gets by default, when nobody has picked one.
 *
 * **Clients that can actually RUN come first.** A composed setup with no
 * server group inherits the client's own servers, so defaulting to a client
 * with none produces an environment that resolves to zero servers — the
 * backend's `ENV_NO_SERVERS` — and a study whose link never opens for anyone.
 * A default that walks the creator into that is worse than no default, so
 * `serverCount > 0` is the first filter.
 *
 * Within the runnable ones: MCPJam's own client first — the one host every
 * project is guaranteed to be able to run — then the most recently touched,
 * which is the closest thing to "the one you used last" without adding a
 * second store to keep in sync.
 *
 * When NO client has servers, this still returns one (so the name and the
 * strip are filled) and the screen's server gate explains what is missing.
 * Returns `null` only for a project with no clients at all.
 */
export function pickDefaultCreateClient(
  hosts: readonly HostListItem[],
): HostListItem | null {
  if (hosts.length === 0) return null;
  const runnable = hosts.filter((host) => (host.serverCount ?? 0) > 0);
  const pool = runnable.length > 0 ? runnable : hosts;
  const mcpjam = pool.find((host) => host.hostStyle === "mcpjam");
  if (mcpjam) return mcpjam;
  return pool.reduce((latest, host) =>
    host.updatedAt > latest.updatedAt ? host : latest,
  );
}

/**
 * Whether this setup will resolve to at least one server — `null` while the
 * answer is genuinely unknown.
 *
 * The reason this check exists at all: an environment with no servers is
 * refused at LAUNCH, not at publish. So a study could be created, get a share
 * link, and only then turn out to be unopenable — the creator finds out from
 * "This scenario can't be opened right now", and a tester from "This link
 * isn't available right now". Neither message says what to do about it.
 *
 * Both modes reduce to the same question, because an environment with no
 * server group of its own inherits its client's server picks:
 *  - a server GROUP is attached ⇒ it has servers by construction;
 *  - otherwise it is the client's own `serverCount`.
 *
 * `null` (not `false`) while the host list is still loading, or when the
 * picked client is not in it: an unknown answer must not render as a problem.
 */
export function composedSetupHasServers(args: {
  serverAttachmentId: string | null;
  hostId: string | null | undefined;
  hosts: readonly HostListItem[];
  hostsLoading: boolean;
}): boolean | null {
  if (args.serverAttachmentId) return true;
  if (!args.hostId) return null;
  if (args.hostsLoading) return null;
  const host = args.hosts.find((h) => h.hostId === args.hostId);
  if (!host) return null;
  return (host.serverCount ?? 0) > 0;
}

/**
 * `/user-testing/new` — create a scenario by publishing an ENVIRONMENT behind
 * a share link, in TWO steps: **Study**, then an optional **Tasks** list.
 *
 * An environment already names the whole execution context a tester will meet:
 * the client, its servers, its skills, its sandbox image. So step 1 asks for
 * the things the environment does NOT carry — what to call the scenario, who
 * may open it, whether testers rate each turn — and nothing else. The version
 * this replaces asked for a server and a client template and quietly minted a
 * host, which is why every project accumulated "scenarios" nobody made.
 *
 * **Step 1 arrives already answered (BB-176).** Research watched someone stall
 * on naming a study and again on an empty client picker — "People block when
 * you're making them name things", "Here you don't have a default client
 * picked", "Don't put that in my way". So a client is preselected, the name is
 * suggested off it, and Continue carries the screen the moment it settles.
 * A cleared name is not a wall either: Save falls back to the suggestion.
 *
 * **Step 2 is a LIST, not a wizard.** It authors the "what to try" checklist a
 * tester sees in their own header. Empty is fine and common — a study whose
 * testers can just chat needs no tasks, and Create study is the way past it.
 *
 * **It never creates a NAMED environment.** Picking a saved one is the ordinary
 * path, and "New environment" hands off to the Environments editor with the
 * typed name seeded. What it also does is compose one on the spot: pick a client
 * and the shared slots, and Save resolves that into an unnamed,
 * content-addressed row. That is what makes "publish this same setup but on a
 * different client" a one-click change instead of a trip to /environments to
 * curate a second row.
 *
 * **This is the ONLY create flow, flag or no flag.** `EnvironmentComposer`
 * gates only its saved-environment picker on `project-environments-enabled`;
 * the client and server-group pills render either way, which is what Swarms has
 * always shown a flag-off project. So flag-off this screen asks for a client
 * and an optional server group and composes an ad-hoc row from them — the same
 * thing the flow it replaces did, except that one hard-coded exactly one server
 * and left the result uneditable forever.
 *
 * Composing needs the backend's `ensureAdhocEnvironments`, and flag-off that is
 * not a new requirement: `hosts.createHost({owner: 'user_testing'})` — the
 * legacy flow's only write — has called `ensureOneAdhocEnvironment` internally
 * since the day scenarios became environment-backed, and the client-callable
 * mutation shipped BEFORE it. A deployment that can serve the flow this
 * replaces can serve this one. That is why there is no legacy fallback here.
 *
 * The strip is always offered for the same reason. Only RESOLVING a composed
 * setup needs the ad-hoc backend, and that is checked when Save uses it: hiding
 * the control instead would be indistinguishable from the feature not existing.
 *
 * **Nothing is written until Create study.** Every choice on both steps is
 * local state — Continue only moves the stepper — and the writes happen once,
 * at the end. Leaving from either step leaves nothing behind.
 *
 * **The environment is REQUIRED, and Continue says so ON PRESS.** A scenario is
 * a link handed to a person, and without an environment there is nothing behind
 * that link — the tester is the one who finds out. The button is therefore
 * live, not disabled: pressing it is how someone asks "am I done?", and a
 * button that cannot be pressed answers nothing. The press validates and names
 * what is missing — no client, or a client with no servers — and only then
 * moves the stepper. Nothing is nagged before the ask, which is the half a
 * permanently-inert button got wrong: it read as "I can create a scenario
 * without an environment", which is how this was reported. Marked labels still
 * carry the requirement ahead of the press, and `ScenarioShareSection` holds
 * the other end — a scenario whose environment stops resolving issues no
 * tester link.
 */
interface UserTestingScenarioCreateFlowProps {
  projectId: string;
  onCancel: () => void;
  /**
   * Navigates to the Environments editor with `name` pre-seeded. Only offered
   * behind `project-environments-enabled` — flag-off the route guard bounces
   * that navigation, so the handoff would be a link to nowhere.
   */
  onCreateEnvironment: () => void;
  /**
   * The primary write path: publishes the environment, applying the name and
   * access mode in the same mutation so the scenario is never briefly live in
   * a mode nobody asked for. Resolves to the new scenario's id, plus whether
   * this call actually created it (`false` ⇒ the environment was already
   * published and the existing scenario is what opens).
   */
  onCreateScenario: (draft: {
    environmentId: string;
    name: string;
    mode: ScenarioMode;
  }) => Promise<{ scenarioId: string; created: boolean }>;
  /**
   * Applies the ratings choice and the task list to the study just created.
   *
   * A SECOND write, unlike name and access: `publishEnvironmentScenario` takes
   * no `chatUi`, so setting these in the same transaction would mean a backend
   * change in the other repo. ONE second write rather than one per surface —
   * both are `chatUi` patches, so a single `updateScenario` gives them a
   * single failure mode instead of a half-configured study whose two halves
   * failed independently.
   *
   * Two writes are safe here in a way they would not be for access: an
   * unrated, task-less study exposes nothing and costs nothing, and the link
   * has not been handed out yet. A failure is reported without discarding the
   * study, which exists either way.
   */
  onApplyStudySurfaces: (
    scenarioId: string,
    surfaces: {
      perTurnFeedback: {
        enabled: boolean;
        style: ScenarioPerTurnFeedbackStyle;
      };
      tasks: { items: ScenarioTaskItem[] };
    },
  ) => Promise<void>;
}

export function UserTestingScenarioCreateFlow({
  projectId,
  onCancel,
  onCreateEnvironment,
  onCreateScenario,
  onApplyStudySurfaces,
}: UserTestingScenarioCreateFlowProps) {
  const computersEnabled = useComputersEnabled();
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  const environments = useProjectEnvironments(projectId);
  const resolveComposerTargets = useComposerResolver(projectId);
  // Also what the default client pick reads. `useConvexAuth` rather than a
  // prop, like `ClientsPill` right below in the same strip.
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading: hostsLoading } = useHostList({
    isAuthenticated,
    projectId,
  });
  const { policy: effectiveSharePolicy } = useEffectiveSharePolicy(projectId);
  const [step, setStep] = useState<CreateStep>("study");
  const [target, setTarget] =
    useState<EnvironmentComposerState>(emptyComposerState);
  const environmentId = target.environmentIds[0] ?? null;
  const [name, setName] = useState("");
  // Default to the least-exposed option: a scenario that reaches further than
  // its author expected is the failure that costs something.
  const [accessPreset, setAccessPreset] =
    useState<ScenarioAccessPreset>("invited_only");
  const accessCeiling = effectiveSharePolicy?.maxShareMode;
  const accessOptions = useMemo(
    () => applyShareCeilingToScenarioOptions(ACCESS_OPTIONS, accessCeiling),
    [accessCeiling],
  );

  useEffect(() => {
    setAccessPreset((prev) => clampScenarioAccessPreset(prev, accessCeiling));
  }, [accessCeiling]);
  /**
   * Per-turn ratings, on by default to match the frame.
   *
   * Safe as a default in a way the access mode is not: it changes what testers
   * are ASKED, not who can open the study or whose credits pay for it, and the
   * creator is looking at the switch when they press Create. The style default
   * mirrors the backend normalizer, where an absent style reads as stars.
   */
  const [perTurnRatings, setPerTurnRatings] = useState(true);
  const [ratingStyle, setRatingStyle] =
    useState<ScenarioPerTurnFeedbackStyle>("stars");
  /**
   * Step 2's rows. Seeded with one empty row so the step opens as a list you
   * add to rather than a blank panel with a button — and an untouched empty
   * row still persists nothing, because `scenarioTasksFromDrafts` drops it.
   */
  const [taskDrafts, setTaskDrafts] = useState<ScenarioTaskDraft[]>(() => [
    emptyScenarioTaskDraft(),
  ]);
  const [isSaving, setIsSaving] = useState(false);
  // Synchronous guard: a double-click must not publish twice before React
  // commits `isSaving`.
  const savingRef = useRef(false);
  // Once the user types a name, stop tracking the environment — but a name
  // they never touched should keep following their pick.
  const userEditedNameRef = useRef(false);
  // The suggested name is real text, not a placeholder, so the first focus
  // selects it: typing then REPLACES the suggestion instead of appending to
  // it, which is what made the old prefill read as junk the user had to
  // delete before they could write their own name.
  const nameSelectedOnceRef = useRef(false);
  // The default client is applied ONCE. Re-applying it would fight a creator
  // who deliberately cleared the pick.
  const defaultClientAppliedRef = useRef(false);

  const liveEnvironments = (environments ?? []).filter(
    (env) => !env.archivedAt,
  );
  const selected = liveEnvironments.find(
    (env) => env.environmentId === environmentId,
  );
  const composing = isComposeMode(target);

  /**
   * What the name field is prefilled with, and what Save falls back to.
   *
   * Tracks the pick — a saved environment's label, or the composed client's
   * name — because that is the only thing on this screen that describes what
   * is being published.
   */
  const suggestedName = useMemo(() => {
    if (selected) return environmentLabel(selected);
    const hostId = target.stack.hostIds[0];
    const client = hostId ? hosts.find((h) => h.hostId === hostId) : undefined;
    return client?.name ?? "";
  }, [hosts, selected, target.stack.hostIds]);

  /**
   * Preselect a client so step 1 is answered on arrival.
   *
   * Gated on the host list having SETTLED (`isLoading`), not merely being
   * empty: mid-load the list reads as empty, and defaulting off that would
   * pick nothing and then never try again.
   */
  useEffect(() => {
    if (defaultClientAppliedRef.current) return;
    if (hostsLoading) return;
    if (target.environmentIds.length > 0) return;
    if (target.stack.hostIds.length > 0) return;
    const client = pickDefaultCreateClient(hosts);
    if (!client) {
      // No clients to default to. Mark it done anyway — a project that gains
      // one later must not have it silently injected under a creator who is
      // already mid-form.
      defaultClientAppliedRef.current = true;
      return;
    }
    defaultClientAppliedRef.current = true;
    setTarget({
      environmentIds: [],
      stack: { ...emptyEnvironmentStack(), hostIds: [client.hostId] },
      customized: false,
    });
    if (!userEditedNameRef.current) setName(client.name);
  }, [hosts, hostsLoading, target.environmentIds.length, target.stack.hostIds]);

  // A composed setup has no row yet — the client pick IS the target.
  const hasTarget = composing
    ? target.stack.hostIds.length > 0
    : Boolean(environmentId);
  // Gated on the environment list having SETTLED: the resolver reuses a
  // matching NAMED environment, and against an empty live list it would find
  // none and mint an unnamed twin of one that already exists.
  //
  // `undefined` also covers a query that is skipped or failed, not just one in
  // flight, so the reason is stated below rather than leaving a dead button.
  const environmentsSettled = environments !== undefined;

  /**
   * Whether this setup can resolve to any servers. See
   * `composedSetupHasServers` for why publish has to ask.
   *
   * A picked saved environment is read the same way as a composed one: its
   * `serverAttachmentId`, else its own client's server picks.
   */
  const setupHasServers = composedSetupHasServers({
    serverAttachmentId: composing
      ? target.stack.serverAttachmentId
      : (selected?.serverAttachmentId ?? null),
    hostId: composing ? target.stack.hostIds[0] : selected?.hostId,
    hosts,
    hostsLoading,
  });

  // The PUBLISH gate — step 2's Create study button. Step 1's Continue no
  // longer reads it: it validates on press and names what is missing
  // (`continueBlocker` below). Both ask the same questions; only Create is
  // allowed to answer them by refusing the click, because past it there is
  // a link in someone's hands.
  //
  // Deliberately NOT gated on the name. A prefilled suggestion plus a
  // fallback means "empty" is a state the creator can pass through, not a
  // wall they have to satisfy first (BB-176).
  //
  // It IS gated on servers, because that is not a preference — it is the
  // difference between a study that opens and one that cannot. `null` (still
  // unknown) does not block: the check exists to stop a knowably-broken
  // publish, not to gate the screen on a query.
  //
  // `hostsLoading` is part of the gate, not just of `setupHasServers`: while
  // the client list is in flight the server question answers `null`, and
  // `!== false` would let a fast creator publish straight through the window
  // this check exists to close. Blocking on `=== true` instead would be
  // wrong in the other direction — a saved environment backed by a private
  // scenario host is filtered out of the list and answers `null` forever, so
  // requiring a positive answer would permanently refuse a legitimate study.
  const canAdvance =
    environmentsSettled &&
    !hostsLoading &&
    hasTarget &&
    setupHasServers !== false &&
    !isSaving;

  /**
   * What Continue would refuse over, or `null` when it would carry.
   *
   * Read live rather than frozen at press time, so fixing the problem clears
   * the message the moment it is fixed rather than leaving an error standing
   * over a form that no longer has one.
   */
  const continueBlocker: "loading" | "client" | "servers" | null =
    !environmentsSettled || hostsLoading
      ? "loading"
      : !hasTarget
        ? "client"
        : setupHasServers === false
          ? "servers"
          : null;
  /**
   * Whether Continue has been pressed on a setup it could not carry.
   *
   * The button itself is never disabled: pressing the thing that moves on is
   * how someone asks whether they are done, and finding out THERE what is
   * missing beats scanning a form for whatever keeps a grey button grey.
   */
  const [continueAttempted, setContinueAttempted] = useState(false);
  const showClientError = continueAttempted && continueBlocker === "client";
  const showServersError = continueAttempted && continueBlocker === "servers";

  const handleContinue = () => {
    setContinueAttempted(true);
    // "loading" is not the creator's mistake and is never dressed as one — the
    // loading line under the strip already says it. The press is still
    // remembered, so an answer arriving a moment later lands on the right
    // message instead of on silence.
    if (continueBlocker) return;
    setStep("tasks");
  };

  const handleTargetChange = (next: EnvironmentComposerState) => {
    // A pick of their own settles the question the default was answering.
    defaultClientAppliedRef.current = true;
    setTarget(next);
    if (userEditedNameRef.current) return;
    // Follow the pick while the name is untouched: a saved environment's label,
    // or — composing, which is the ONLY mode a flag-off project has — the
    // client's name. Naming it after the client is what the flow this replaces
    // did, and without it a flag-off user picks a client and then meets a
    // required field with nothing in it.
    const pickedId = next.environmentIds[0] ?? null;
    const picked = isComposeMode(next)
      ? undefined
      : liveEnvironments.find((env) => env.environmentId === pickedId);
    if (picked) {
      setName(environmentLabel(picked));
      return;
    }
    const hostId = next.stack.hostIds[0];
    const client = hostId ? hosts.find((h) => h.hostId === hostId) : undefined;
    setName(client?.name ?? "");
  };

  const handleCreateEnvironment = () => {
    // Carry the typed name across so the round trip doesn't cost it. The
    // Environments route consumes this seed into its create form.
    const typed = name.trim();
    saveEnvironmentDraftSeed(projectId, {
      ...(typed ? { name: typed } : {}),
      hostId: null,
      serverAttachmentId: null,
      skillSelection: null,
    });
    onCreateEnvironment();
  };

  const handleSave = async () => {
    if (!hasTarget || savingRef.current) return;
    // Never an empty name in the database: the field is allowed to be empty,
    // the study is not.
    const effectiveName =
      name.trim() || suggestedName.trim() || FALLBACK_STUDY_NAME;
    savingRef.current = true;
    setIsSaving(true);
    try {
      // A composed setup becomes a real row first — publish takes an id, and a
      // scenario has to keep resolving long after this screen is gone.
      const resolved = composing
        ? (
            await resolveComposerTargets({
              state: target,
              liveEnvironments,
              max: 1,
            })
          ).environmentIds[0]
        : environmentId;
      if (!resolved) throw new Error("Could not resolve this setup.");

      const { scenarioId, created } = await onCreateScenario({
        environmentId: resolved,
        name: effectiveName,
        mode: settingsFromScenarioAccessPreset(accessPreset).mode,
      });

      // Only for a study this call actually created. Publishing is idempotent
      // per environment, so on a collision the existing study keeps its own
      // settings — silently rewriting its rating widget or replacing its task
      // list would be this screen reconfiguring someone else's study.
      let surfacesFailed = false;
      if (created) {
        try {
          await onApplyStudySurfaces(scenarioId, {
            perTurnFeedback: {
              enabled: perTurnRatings,
              style: ratingStyle,
            },
            tasks: { items: scenarioTasksFromDrafts(taskDrafts) },
          });
        } catch {
          // The study exists; only its chatUi settings did not land. Say which
          // half failed and where to fix it, rather than reporting a failed
          // creation the user can see succeeded.
          surfacesFailed = true;
          toast.error(
            "Study created, but its ratings and task list didn't save. Set them from the study's settings.",
          );
        }
      }

      // The error above already opens with "Study created" — pairing it with a
      // bare success toast makes the screen say two things about one outcome
      // and reads like one of them is stale.
      if (!surfacesFailed) {
        toast.success(
          created
            ? "Study created"
            : // Publishing is idempotent per environment, and composing makes a
              // collision likelier: an identical setup resolves to the SAME row,
              // whose scenario keeps its own name, access and tasks.
              "This setup is already published — opening its study, with the name and access it already has",
        );
      }
    } catch (err) {
      // Surface the backend's copy verbatim: publishing is project-admin
      // gated, and "you need admin" is a different problem than "it failed".
      // `ComposerResolveError` is an Error too, and its message already tells a
      // user on an older backend to pick a saved environment instead.
      toast.error(
        err instanceof Error ? err.message : "Failed to create the study",
      );
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  const accessLabel = accessOptions.find((o) => o.value === accessPreset);
  const accessCeilingNote = accessOptions.find(
    (option) => option.disabled,
  )?.disabledReason;

  const activeStepIndex = step === "study" ? 0 : 1;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-6 py-6 sm:px-8">
        <button
          type="button"
          onClick={onCancel}
          data-testid="user-testing-create-back"
          className={cn(
            "inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary",
            "hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          {/* Same chevron, same size as the Swarms create flow's back link:
              two sibling flows reached the same way should not disagree
              about which glyph means "back". */}
          <ChevronLeft className="size-3.5" />
          User Testing
        </button>

        {/* Swarm's stepper, not a second implementation of one: the two create
            flows are reached the same way and must not disagree about what
            "you are here" looks like. Step 1 is offered as a way back only
            from step 2, and never mid-save. */}
        <ProgressStepper
          className="mt-6"
          steps={CREATE_STEPS}
          activeIndex={activeStepIndex}
          onStepSelect={(index) => {
            if (isSaving) return;
            if (index === 0) setStep("study");
          }}
          isStepSelectable={(index) =>
            index === 0 && step === "tasks" && !isSaving
          }
          ariaLabel="New study progress"
          testId="user-testing-create-progress"
        />

        {step === "study" ? (
          <>
            <h1 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-foreground">
              Create a new study
            </h1>
            <p className="mt-1.5 text-sm font-medium leading-relaxed text-foreground">
              Users try your server in ChatGPT, Claude, or another client. You
              read what happened.
            </p>

            <div className="mt-6 space-y-5">
              <div className="space-y-2">
                {/* NOT marked required, and no `aria-required`. The frame
                    draws an asterisk here, but this field accepts empty and
                    falls back to the suggestion — announcing a requirement
                    that is not enforced is a contradiction a screen reader
                    hears and a sighted user does not. */}
                <Label htmlFor="user-testing-create-name">Study name</Label>
                <Input
                  id="user-testing-create-name"
                  data-testid="user-testing-create-name"
                  value={name}
                  disabled={isSaving}
                  placeholder={suggestedName || "Checkout flow"}
                  onFocus={(e) => {
                    // Only the FIRST focus, and only a name they have not
                    // touched: selecting text under someone who came back to
                    // fix a typo would delete their work on the next keypress.
                    if (nameSelectedOnceRef.current) return;
                    nameSelectedOnceRef.current = true;
                    if (userEditedNameRef.current) return;
                    if (!e.currentTarget.value) return;
                    e.currentTarget.select();
                  }}
                  onChange={(e) => {
                    userEditedNameRef.current = true;
                    setName(e.target.value);
                  }}
                />
              </div>

              <div className="space-y-2">
                {/* Names the CHOICE, not the storage layer, and reads the same
                    flag-on and flag-off (BB-176). "Environment" flag-on
                    pointed at a picker that flag-off is not there, and made
                    one control read as two different things. */}
                <Label>
                  Choose the client and servers your users will interact with
                  <RequiredMark />
                </Label>
                {/* No empty state any more: a project with zero environments is not
                    a dead end, because the strip can build the one this scenario
                    needs. The handoff below still covers curating a named one. */}
                <EnvironmentComposer
                  projectId={projectId}
                  environments={liveEnvironments}
                  value={target}
                  onChange={handleTargetChange}
                  maxTargets={1}
                  disabled={isSaving}
                  testIdPrefix="user-testing-create"
                />
                {environmentsEnabled ? (
                  <button
                    type="button"
                    onClick={handleCreateEnvironment}
                    data-testid="user-testing-create-new-environment"
                    className="text-xs text-primary hover:underline"
                  >
                    None of these fit — build a new environment
                  </button>
                ) : null}
                {/* Why Continue did not carry, said where the choice is made
                    and only once it has been asked for. `role="alert"` because
                    it arrives in response to a press: a sighted user watches it
                    land, and a screen reader user is told.

                    Flag-on and flag-off say the SAME thing. The composer shows
                    client pills either way, so "a client" is what is missing on
                    both; a saved environment is one way to supply it, not a
                    second thing to ask for.

                    Names the missing thing rather than the fix: two errors, one
                    shape, so a creator reads which of the two required choices
                    is outstanding and not a pair of instructions to follow. */}
                {showClientError ? (
                  <p
                    className="text-xs text-destructive"
                    role="alert"
                    data-testid="user-testing-create-environment-required"
                  >
                    No client picked
                  </p>
                ) : null}
                {!environmentsSettled ? (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="user-testing-create-environments-loading"
                  >
                    Loading this project&apos;s setup…
                  </p>
                ) : null}
                {/* The gate that would have saved a broken study: a setup with
                    no servers publishes fine and then refuses to open, and
                    neither the creator's nor the tester's error names the
                    cause. Said on press, directly under the server group that
                    fixes it.

                    One message for one problem — "this setup reaches no
                    server". Whether that is because the client carries none of
                    its own or because no group is attached is a distinction the
                    creator cannot act on differently: the fix is the same
                    control either way. */}
                {showServersError ? (
                  <p
                    className="text-xs text-destructive"
                    role="alert"
                    data-testid="user-testing-create-servers-required"
                  >
                    No server picked
                  </p>
                ) : null}
                {computersEnabled ? (
                  <p
                    className="text-xs text-muted-foreground"
                    data-testid="user-testing-create-cloud-note"
                  >
                    Tester-session computer commands run in MCPJam cloud
                    sandboxes — never on the machine serving this inspector.
                  </p>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label>Who can open it</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      data-testid="user-testing-create-access"
                      disabled={isSaving}
                      className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-60"
                    >
                      <span className="flex-1 truncate text-left">
                        {accessLabel?.label}
                      </span>
                      <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    className="w-[var(--radix-dropdown-menu-trigger-width)]"
                  >
                    <DropdownMenuRadioGroup
                      value={accessPreset}
                      onValueChange={(v) => {
                        const next = v as ScenarioAccessPreset;
                        const option = accessOptions.find(
                          (o) => o.value === next,
                        );
                        if (option?.disabled) return;
                        setAccessPreset(
                          clampScenarioAccessPreset(next, accessCeiling),
                        );
                      }}
                    >
                      {accessOptions.map((option) => (
                        <DropdownMenuRadioItem
                          key={option.value}
                          value={option.value}
                          disabled={option.disabled}
                        >
                          {option.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
                {accessLabel ? (
                  <p className="text-xs text-muted-foreground">
                    {accessLabel.description}
                  </p>
                ) : null}
                {accessCeilingNote ? (
                  <p className="text-xs text-muted-foreground">
                    {accessCeilingNote}
                  </p>
                ) : null}
              </div>

              {/* Per-turn ratings, asked here rather than only after the fact
                  (BB-126). It is a decision about the study being published, and
                  finding it in a settings screen afterwards means the first
                  testers were never asked. */}
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <Label
                    htmlFor="user-testing-create-ratings"
                    className="text-sm font-semibold"
                  >
                    Turn on user ratings for every turn
                  </Label>
                  <Switch
                    id="user-testing-create-ratings"
                    checked={perTurnRatings}
                    disabled={isSaving}
                    onCheckedChange={setPerTurnRatings}
                    data-testid="user-testing-create-ratings"
                  />
                </div>
                <p className="text-[13px] leading-relaxed text-foreground">
                  Testers will be able to rate each response and leave a
                  comment. Ratings will appear in the Sessions tab.
                </p>
                {/* Only while the switch is on: a widget style is a question about
                    a widget nobody is being shown otherwise. Same rule the
                    post-create toggle follows. */}
                {perTurnRatings ? (
                  <div
                    role="radiogroup"
                    aria-label="Rating widget style"
                    // Bordered track, and the selected pill carries a border of
                    // its own. `bg-background` on `bg-muted/50` alone is all but
                    // invisible in dark mode, which is exactly how a tester
                    // reported being unable to see which style was picked
                    // (BB-176).
                    className="inline-flex rounded-lg border border-border/60 bg-muted p-0.5"
                    data-testid="user-testing-create-rating-style"
                  >
                    {RATING_STYLE_OPTIONS.map((option) => {
                      const active = ratingStyle === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          disabled={isSaving}
                          onClick={() => setRatingStyle(option.value)}
                          data-testid={`user-testing-create-rating-style-${option.value}`}
                          className={cn(
                            "rounded-md px-2.5 py-1 text-xs transition-colors",
                            active
                              ? "border border-border bg-background font-semibold text-foreground shadow-sm"
                              : "border border-transparent font-medium text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mt-7 flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={onCancel} disabled={isSaving}>
                Cancel
              </Button>
              {/* Never disabled — see `handleContinue`. */}
              <Button
                onClick={handleContinue}
                data-testid="user-testing-create-continue"
              >
                Continue
              </Button>
            </div>
          </>
        ) : (
          <>
            <h1 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-foreground">
              What should they try?
            </h1>
            <p className="mt-1.5 text-sm font-medium leading-relaxed text-foreground">
              Your testers will see this list in the top right. Skip this step
              if they can just chat directly.
            </p>

            <div className="mt-6">
              <ScenarioTaskListEditor
                value={taskDrafts}
                onChange={setTaskDrafts}
                disabled={isSaving}
                testIdPrefix="user-testing-create"
              />
            </div>

            <div className="mt-7 flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                onClick={() => setStep("study")}
                disabled={isSaving}
                data-testid="user-testing-create-back-step"
              >
                Back
              </Button>
              <Button
                onClick={() => void handleSave()}
                disabled={!canAdvance}
                data-testid="user-testing-create-save"
              >
                {isSaving ? (
                  <>
                    <Loader2 className="mr-1.5 size-4 animate-spin" />
                    Creating…
                  </>
                ) : (
                  "Create study"
                )}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
