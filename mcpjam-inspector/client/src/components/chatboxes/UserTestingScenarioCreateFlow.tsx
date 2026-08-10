import { useRef, useState } from "react";
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
import {
  emptyComposerState,
  isComposeMode,
  type EnvironmentComposerState,
} from "@/components/environment-composer/environment-stack";
import { useComposerResolver } from "@/components/environment-composer/use-composer-resolver";
import { useProjectEnvironments } from "@/hooks/useProjectEnvironments";
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
 * The strip is always offered — it renders behind `project-environments-enabled`
 * like the rest of this surface. Only RESOLVING a composed setup needs the
 * ad-hoc backend, and that is checked when Save uses it: hiding the control
 * instead would be indistinguishable from the feature not existing.
 *
 * **Nothing is written until Save.** Every choice is local state; the single
 * write is `onCreateScenario`, injected by the parent — the same inversion
 * `new-swarm-create-flow` and the legacy flow both use.
 */
interface UserTestingScenarioCreateFlowProps {
  projectId: string;
  onCancel: () => void;
  /** Navigates to the Environments editor with `name` pre-seeded. */
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
  const environments = useProjectEnvironments(projectId);
  const resolveComposerTargets = useComposerResolver(projectId);
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
  const canSave = hasTarget && effectiveName.length > 0 && !isSaving;

  const handleTargetChange = (next: EnvironmentComposerState) => {
    setTarget(next);
    if (userEditedNameRef.current) return;
    // Follow the saved environment's label while the name is untouched. A
    // composed setup has nothing to label yet, so the placeholder takes over.
    const pickedId = next.environmentIds[0] ?? null;
    const picked = isComposeMode(next)
      ? undefined
      : liveEnvironments.find((env) => env.environmentId === pickedId);
    setName(picked ? environmentLabel(picked) : "");
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
          Publish one of your environments behind a link you can hand to a real
          person, then read what happened in their sessions.
        </p>

        <div className="mt-6 space-y-5">
          <div className="space-y-2">
            <Label>Environment</Label>
            {/* No empty state any more: a project with zero environments is not
                a dead end, because the strip can build the one this scenario
                needs. The handoff below still covers curating a named one. */}
            {
              <>
                <EnvironmentComposer
                  projectId={projectId}
                  environments={liveEnvironments}
                  value={target}
                  onChange={handleTargetChange}
                  maxTargets={1}
                  disabled={isSaving}
                  testIdPrefix="user-testing-create"
                />
                <button
                  type="button"
                  onClick={handleCreateEnvironment}
                  data-testid="user-testing-create-new-environment"
                  className="text-xs text-primary hover:underline"
                >
                  None of these fit — build a new environment
                </button>
              </>
            }
          </div>

          <div className="space-y-2">
            <Label htmlFor="user-testing-create-name">Scenario name</Label>
            <Input
              id="user-testing-create-name"
              data-testid="user-testing-create-name"
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
