import { useRef, useState } from "react";
import { useConvexAuth } from "convex/react";
import { ArrowLeft, ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { EnvironmentComposer } from "@/components/environment-composer/environment-composer";
import { RequiredMark } from "@/components/shared/required-mark";
import {
  emptyComposerState,
  isComposeMode,
  type EnvironmentComposerState,
} from "@/components/environment-composer/environment-stack";
import { useComposerResolver } from "@/components/environment-composer/use-composer-resolver";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { useHostList } from "@/hooks/useClients";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { saveEnvironmentDraftSeed } from "@/lib/environment-draft-seed";
import { environmentLabel } from "@/lib/environment-label";
import {
  CHATBOX_ACCESS_OPTIONS as ACCESS_OPTIONS,
  settingsFromChatboxAccessPreset,
  type ChatboxAccessPreset,
} from "@/lib/chatbox-access-presets";
import type { ChatboxMode } from "@/hooks/useChatboxes";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/**
 * `/user-testing/new` — create a scenario by publishing an ENVIRONMENT behind
 * a share link.
 *
 * An environment already names the whole execution context a tester will meet:
 * the client, its servers, its skills, its sandbox image. So this screen asks
 * for the two things the environment does NOT carry — what to call the
 * scenario, and who may open it — and nothing else. The version this replaces
 * asked for a server and a client template and quietly minted a host, which is
 * why every project accumulated "scenarios" nobody made.
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
 * **Nothing is written until Save.** Every choice is local state; the single
 * write is `onCreateScenario`, injected by the parent — the same inversion
 * `new-swarm-create-flow` and the legacy flow both use.
 *
 * **The environment is REQUIRED, and now says so.** A scenario is a link handed
 * to a person, and without an environment there is nothing behind that link —
 * the tester is the one who finds out. Save has always been gated on a target,
 * but silently: a disabled button that never explains itself reads as "I can
 * create a scenario without an environment", which is how this was reported.
 * The gate names itself here (marked labels, plus the hint under the strip), and
 * `ChatboxShareSection` holds the other end — a scenario whose environment stops
 * resolving issues no tester link.
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
   * The ONLY write path: publishes the environment, applying the name and
   * access mode in the same mutation so the scenario is never briefly live in
   * a mode nobody asked for. Resolves to the new scenario's id, plus whether
   * this call actually created it (`false` ⇒ the environment was already
   * published and the existing scenario is what opens).
   */
  onCreateScenario: (draft: {
    environmentId: string;
    name: string;
    mode: ChatboxMode;
  }) => Promise<{ scenarioId: string; created: boolean }>;
}

export function UserTestingScenarioCreateFlow({
  projectId,
  onCancel,
  onCreateEnvironment,
  onCreateScenario,
}: UserTestingScenarioCreateFlowProps) {
  const computersEnabled = useComputersEnabled();
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  const environments = useProjectEnvironments(projectId);
  const resolveComposerTargets = useComposerResolver(projectId);
  // Only to default the name off the picked client, the way picking a saved
  // environment defaults it off that environment's label. `useConvexAuth`
  // rather than a prop, like `ClientsPill` right below in the same strip.
  const { isAuthenticated } = useConvexAuth();
  const { hosts } = useHostList({ isAuthenticated, projectId });
  const [target, setTarget] = useState<EnvironmentComposerState>(
    emptyComposerState
  );
  const environmentId = target.environmentIds[0] ?? null;
  const [name, setName] = useState("");
  // Default to the least-exposed option: a scenario that reaches further than
  // its author expected is the failure that costs something.
  const [accessPreset, setAccessPreset] =
    useState<ChatboxAccessPreset>("invited_only");
  const [isSaving, setIsSaving] = useState(false);
  // Synchronous guard: a double-click must not publish twice before React
  // commits `isSaving`.
  const savingRef = useRef(false);
  // Once the user types a name, stop tracking the environment — but a name
  // they never touched should keep following their pick.
  const userEditedNameRef = useRef(false);

  const liveEnvironments = (environments ?? []).filter(
    (env) => !env.archivedAt,
  );
  const selected = liveEnvironments.find(
    (env) => env.environmentId === environmentId,
  );
  const composing = isComposeMode(target);
  const effectiveName = name.trim();
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
  const canSave =
    environmentsSettled && hasTarget && effectiveName.length > 0 && !isSaving;

  const handleTargetChange = (next: EnvironmentComposerState) => {
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
    saveEnvironmentDraftSeed(projectId, {
      ...(effectiveName ? { name: effectiveName } : {}),
      hostId: null,
      serverAttachmentId: null,
      skillSelection: null,
    });
    onCreateEnvironment();
  };

  const handleSave = async () => {
    if (!hasTarget || !effectiveName || savingRef.current) return;
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

      const { created } = await onCreateScenario({
        environmentId: resolved,
        name: effectiveName,
        mode: settingsFromChatboxAccessPreset(accessPreset).mode,
      });
      toast.success(
        created
          ? "Scenario created"
          : // Publishing is idempotent per environment, and composing makes a
            // collision likelier: an identical setup resolves to the SAME row,
            // whose scenario keeps its own name and access.
            "This setup is already published — opening its scenario, with the name and access it already has",
      );
    } catch (err) {
      // Surface the backend's copy verbatim: publishing is project-admin
      // gated, and "you need admin" is a different problem than "it failed".
      // `ComposerResolveError` is an Error too, and its message already tells a
      // user on an older backend to pick a saved environment instead.
      toast.error(
        err instanceof Error ? err.message : "Failed to create the scenario",
      );
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  const accessLabel = ACCESS_OPTIONS.find((o) => o.value === accessPreset);

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
          <ArrowLeft className="size-3.5" />
          User Testing
        </button>

        <h1 className="mt-3 text-xl font-bold tracking-tight text-foreground">
          New scenario
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {environmentsEnabled
            ? "Publish one of your environments behind a link you can hand to a real person, then read what happened in their sessions."
            : "Publish a client and the servers it can reach behind a link you can hand to a real person, then read what happened in their sessions."}
        </p>

        <div className="mt-6 space-y-5">
          <div className="space-y-2">
            <Label>
              {/* Flag-off there is no environment CONTROL in the strip — just
                  a client and a server group — so naming the section after the
                  thing it composes would point at a picker that isn't there.
                  Same words Swarms uses for the same strip. */}
              {environmentsEnabled ? "Environment" : "Where it runs"}
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
            {/* Why Save is inert, said where the choice is made. Only once the
                list has SETTLED: before that the loading line below is the
                honest answer, and two hints would contradict each other. */}
            {environmentsSettled && !hasTarget ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="user-testing-create-environment-required"
              >
                {environmentsEnabled
                  ? "Required — pick a saved environment or compose one."
                  : "Required — pick the client a tester will see. Its server group is optional, and covers every server you want them to reach."}{" "}
                A scenario without one has nothing for a tester to run, so it
                isn&apos;t created and no tester link is issued.
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
            {computersEnabled ? (
              <p
                className="text-xs text-muted-foreground"
                data-testid="user-testing-create-cloud-note"
              >
                Tester-session computer commands run in MCPJam cloud sandboxes —
                never on the machine serving this inspector.
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="user-testing-create-name">
              Scenario name
              <RequiredMark />
            </Label>
            <Input
              id="user-testing-create-name"
              data-testid="user-testing-create-name"
              aria-required
              value={name}
              disabled={isSaving}
              placeholder={
                selected ? environmentLabel(selected) : "Checkout flow"
              }
              onChange={(e) => {
                userEditedNameRef.current = true;
                setName(e.target.value);
              }}
            />
            <p className="text-xs text-muted-foreground">
              What you&apos;ll recognize this run of testing by. Renaming the
              environment later won&apos;t rename it.
            </p>
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
                className="w-[--radix-dropdown-menu-trigger-width]"
              >
                <DropdownMenuRadioGroup
                  value={accessPreset}
                  onValueChange={(v) =>
                    setAccessPreset(v as ChatboxAccessPreset)
                  }
                >
                  {ACCESS_OPTIONS.map((option) => (
                    <DropdownMenuRadioItem
                      key={option.value}
                      value={option.value}
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
          </div>
        </div>

        <div className="mt-7 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={!canSave}
            data-testid="user-testing-create-save"
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-1.5 size-4 animate-spin" />
                Creating…
              </>
            ) : (
              "Create scenario"
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
