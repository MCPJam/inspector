import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { cn } from "@/lib/utils";
import { track } from "@/lib/analytics";
import { useXaaResourceApps } from "@/hooks/useXaaResourceApps";
import { useOptionalSharedAppState } from "@/state/app-state-context";
import type { XaaResourceApp } from "@/lib/xaa/types";
import { BasicInfoStep } from "./BasicInfoStep";
import { AuthServerStep } from "./AuthServerStep";
import { ScopesConfigStep } from "./ScopesConfigStep";
import {
  draftFromResourceApp,
  draftFromServer,
  draftToInput,
  EMPTY_DRAFT,
  isPickableServer,
  validateAuthServer,
  validateBasicInfo,
  validateScopesConfig,
  type RegistrationDraft,
} from "./wizard-draft";

const STEPS = [
  { id: 1, title: "Basic info" },
  { id: 2, title: "Auth server" },
  { id: 3, title: "Scopes & health" },
] as const;

type StepId = (typeof STEPS)[number]["id"];

interface XAARegistrationWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  organizationId: string | null;
  /** When set, the wizard edits this registration instead of creating. */
  editing?: XaaResourceApp | null;
  onSaved?: (id: string) => void;
}

export function XAARegistrationWizard({
  open,
  onOpenChange,
  organizationId,
  editing,
  onSaved,
}: XAARegistrationWizardProps) {
  const { upsert } = useXaaResourceApps(organizationId);

  // Project server catalog for the "start from an existing server" picker
  // (the Okta model: admins pick from the directory instead of re-typing
  // URLs). Optional context: outside an AppStateProvider (isolated surfaces,
  // tests) the catalog is empty and the picker simply hides. The project
  // catalog — not `servers` (runtime connections, which drop the persisted
  // OAuth config) — carries clientId/oauthScopes/xaaAuthzIssuer.
  const sharedAppState = useOptionalSharedAppState();
  const serverOptions = useMemo(() => {
    const catalog =
      sharedAppState?.projects[sharedAppState.activeProjectId]?.servers ?? {};
    return Object.values(catalog)
      .filter(isPickableServer)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [sharedAppState]);

  const [step, setStep] = useState<StepId>(1);
  const [draft, setDraft] = useState<RegistrationDraft>(EMPTY_DRAFT);
  const [pickedServerName, setPickedServerName] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null);

  // Reset to a fresh (or edit-seeded) draft whenever the dialog opens. The
  // secret field is intentionally never pre-filled.
  useEffect(() => {
    if (open) {
      setStep(1);
      setDraft(editing ? draftFromResourceApp(editing) : EMPTY_DRAFT);
      setPickedServerName("");
      setValidationError(null);
      setSaveError(null);
    }
  }, [open, editing]);

  // Move focus to the step heading on step change so keyboard/screen-reader
  // users land at the top of the new step.
  useEffect(() => {
    if (open) {
      stepHeadingRef.current?.focus();
    }
  }, [step, open]);

  const updateDraft = (updates: Partial<RegistrationDraft>) => {
    setDraft((current) => ({ ...current, ...updates }));
    setValidationError(null);
  };

  // Picking snapshots the server row into the draft (overwriting the
  // prefillable fields — a pick is an explicit action) and leaves everything
  // else alone. The user can still edit anything before saving; the stored
  // registration never references the server row.
  const handlePickServer = (name: string) => {
    const server = serverOptions.find((s) => s.name === name);
    if (!server) return;
    setPickedServerName(name);
    updateDraft(draftFromServer(server));
  };

  const handleNext = () => {
    const error =
      step === 1 ? validateBasicInfo(draft) : validateAuthServer(draft);
    if (error) {
      setValidationError(error);
      return;
    }
    setStep((current) => (current === 1 ? 2 : 3));
  };

  const handleSave = async () => {
    const error = validateScopesConfig(draft);
    if (error) {
      setValidationError(error);
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    try {
      const { id } = await upsert(draftToInput(draft, editing?.id));
      track("xaa_resource_app_saved", {
        location: "xaa_registration_wizard",
        resource_type: draft.resourceType,
        auth_server_mode: draft.authServerMode,
      });
      onSaved?.(id);
      onOpenChange(false);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : "Failed to save resource app",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit resource app" : "Register resource app"}
          </DialogTitle>
          <DialogDescription>
            Save the resource and auth-server details once; the flow runner
            drives the full token-exchange flow against them.
          </DialogDescription>
        </DialogHeader>

        <ol className="flex items-center gap-2" aria-label="Registration steps">
          {STEPS.map((s) => {
            const isCurrent = s.id === step;
            return (
              <li
                key={s.id}
                aria-current={isCurrent ? "step" : undefined}
                className={cn(
                  "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                  isCurrent
                    ? "border-primary/50 bg-primary/10 font-medium text-foreground"
                    : "border-border text-muted-foreground",
                )}
              >
                <span className="font-mono">{s.id}</span>
                {s.title}
              </li>
            );
          })}
        </ol>

        <h3
          ref={stepHeadingRef}
          tabIndex={-1}
          className="text-sm font-semibold outline-none"
        >
          {STEPS.find((s) => s.id === step)?.title}
        </h3>

        {step === 1 ? (
          <div className="space-y-4">
            {/* Registering starts from picking one of the project's servers;
                manual entry below is the fallback. Hidden while editing (the
                registration already has its details) and when the project has
                no HTTP servers to pick from. */}
            {!editing && serverOptions.length > 0 && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="xaa-reg-server-picker">
                    Start from an existing server
                  </Label>
                  <Select
                    value={pickedServerName}
                    onValueChange={handlePickServer}
                  >
                    <SelectTrigger id="xaa-reg-server-picker">
                      <SelectValue placeholder="Pick one of your servers" />
                    </SelectTrigger>
                    <SelectContent>
                      {serverOptions.map((server) => (
                        <SelectItem key={server.name} value={server.name}>
                          {server.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Copies the server&apos;s saved details into the form as a
                    one-time snapshot — edit anything before saving.
                  </p>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span aria-hidden="true" className="h-px flex-1 bg-border" />
                  or enter details manually
                  <span aria-hidden="true" className="h-px flex-1 bg-border" />
                </div>
              </>
            )}
            <BasicInfoStep draft={draft} onChange={updateDraft} />
          </div>
        ) : step === 2 ? (
          <AuthServerStep
            draft={draft}
            onChange={updateDraft}
            hasStoredSecret={Boolean(editing?.hasSecret)}
          />
        ) : (
          <ScopesConfigStep draft={draft} onChange={updateDraft} />
        )}

        {(validationError || saveError) && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {validationError ?? saveError}
          </p>
        )}

        <DialogFooter>
          {step > 1 && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setStep((current) => (current === 3 ? 2 : 1))}
              disabled={isSaving}
            >
              Back
            </Button>
          )}
          {step < 3 ? (
            <Button type="button" onClick={handleNext}>
              Next
            </Button>
          ) : (
            <Button type="button" onClick={handleSave} disabled={isSaving}>
              {isSaving ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  Saving
                </>
              ) : (
                "Save"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
