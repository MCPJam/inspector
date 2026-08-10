import { useRef, useState } from "react";
import { ArrowLeft, ChevronDown, Layers, Loader2, Plus } from "lucide-react";
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
import { EnvironmentPicker } from "@/components/project-environments/environment-picker";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
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
 * **It never CREATES an environment.** Scenario surfaces select one; Swarms is
 * the only surface that materializes them. "New environment" hands off to the
 * Environments editor with the typed name seeded, and the user comes back.
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
  const computersEnabled = useComputersEnabled();
  const environments = useProjectEnvironments(projectId);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
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
  const effectiveName = name.trim();
  const canSave =
    Boolean(environmentId) && effectiveName.length > 0 && !isSaving;

  const handlePickEnvironment = (next: string | null) => {
    setEnvironmentId(next);
    if (userEditedNameRef.current) return;
    const picked = liveEnvironments.find((env) => env.environmentId === next);
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
    if (!environmentId || !effectiveName || savingRef.current) return;
    savingRef.current = true;
    setIsSaving(true);
    try {
      const { created } = await onCreateScenario({
        environmentId,
        name: effectiveName,
        mode: settingsFromChatboxAccessPreset(accessPreset).mode,
      });
      toast.success(
        created
          ? "Scenario created"
          : "That environment is already published — opening its scenario",
      );
    } catch (err) {
      // Surface the backend's copy verbatim: publishing is project-admin
      // gated, and "you need admin" is a different problem than "it failed".
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
            {environments !== undefined && liveEnvironments.length === 0 ? (
              <div
                data-testid="user-testing-create-no-environments"
                className="rounded-md border border-dashed border-border/70 px-4 py-5 text-center"
              >
                <Layers className="mx-auto size-6 text-muted-foreground/70" />
                <p className="mt-2 text-sm font-medium">No environments yet</p>
                <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                  An environment is the client, servers and skills a tester will
                  meet. Build one, then come back and publish it.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={handleCreateEnvironment}
                  data-testid="user-testing-create-new-environment"
                >
                  <Plus className="mr-1.5 size-4" />
                  New environment
                </Button>
              </div>
            ) : (
              <>
                <EnvironmentPicker
                  projectId={projectId}
                  value={environmentId}
                  onChange={handlePickEnvironment}
                  multi={false}
                  disabled={isSaving}
                  emptyLabel="Select an environment"
                  triggerTestId="user-testing-create-environment"
                  triggerAriaLabel="Environment to publish"
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
            )}
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
