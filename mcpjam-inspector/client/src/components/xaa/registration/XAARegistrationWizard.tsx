import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";
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
  parseScopes,
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
  /** Create-mode draft seed (ignored while editing) — e.g. the debugger's
   * "register this bar server" prompt pre-fills the target's URL/issuer. The
   * secret is never prefillable. */
  prefill?: Partial<Omit<RegistrationDraft, "secret">> | null;
  onSaved?: (id: string) => void;
}

export function XAARegistrationWizard({
  open,
  onOpenChange,
  organizationId,
  editing,
  prefill,
  onSaved,
}: XAARegistrationWizardProps) {
  // Hooks run unconditionally — the flag gate returns null at the bottom of
  // the hook block, never before a hook call.
  const registrationEnabled = useFeatureFlagEnabled("xaa-registration");
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
  // After a pick the wizard collapses to a one-click review; "Edit details"
  // expands the full step flow again without losing the pick.
  const [stepsExpanded, setStepsExpanded] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const stepHeadingRef = useRef<HTMLHeadingElement | null>(null);

  // Review mode is keyed STRICTLY on an explicit pick: draft prefills from
  // any other source (editing today, debugger prefill on other branches)
  // must land in the step flow, never in the collapsed review.
  const isReview = Boolean(pickedServerName) && !stepsExpanded;

  // Reset to a fresh (or edit-seeded) draft whenever the dialog opens. The
  // secret field is intentionally never pre-filled.
  // Seed only on the closed→open transition: `prefill`/`editing` may not be
  // referentially stable across parent re-renders, and re-seeding while open
  // would wipe the user's in-progress edits.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setStep(1);
      // Prefill (the debugger's "Register this server" banner) seeds the
      // draft on open; the picker below can still override with a different
      // server — an explicit pick always wins over the seeded values.
      setDraft(
        editing
          ? draftFromResourceApp(editing)
          : { ...EMPTY_DRAFT, ...(prefill ?? {}) },
      );
      setPickedServerName("");
      setStepsExpanded(false);
      setValidationError(null);
      setSaveError(null);
    }
    wasOpenRef.current = open;
  }, [open, editing, prefill]);

  // Move focus to the step heading on step change so keyboard/screen-reader
  // users land at the top of the new step.
  useEffect(() => {
    if (open) {
      stepHeadingRef.current?.focus();
    }
  }, [step, open]);

  if (registrationEnabled !== true) {
    return null;
  }

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
    setStepsExpanded(false);
    setStep(1);
    setSaveError(null);
    updateDraft(draftFromServer(server));
  };

  // Back to the unpicked state: manual wizard with a blank draft.
  const handleClearPick = () => {
    setPickedServerName("");
    setStepsExpanded(false);
    setStep(1);
    setDraft(EMPTY_DRAFT);
    setValidationError(null);
    setSaveError(null);
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

  // The single save path — review's "Register app" and step 3's "Save" both
  // land here with the same payload.
  const persist = async () => {
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

  const handleSave = async () => {
    const error = validateScopesConfig(draft);
    if (error) {
      setValidationError(error);
      return;
    }
    await persist();
  };

  // One-click register: run every step's validation; on the first failure,
  // expand the step flow at the offending step with the inline message
  // instead of dead-ending in the review.
  const handleRegisterFromReview = async () => {
    const checks: Array<[StepId, string | null]> = [
      [1, validateBasicInfo(draft)],
      [2, validateAuthServer(draft)],
      [3, validateScopesConfig(draft)],
    ];
    const failed = checks.find(([, error]) => error !== null);
    if (failed) {
      setValidationError(failed[1]);
      setStep(failed[0]);
      setStepsExpanded(true);
      return;
    }
    await persist();
  };

  // The picker is shown on step 1 AND in review mode (so re-picking works
  // everywhere). Hidden while editing (the registration already has its
  // details) and when the project has no HTTP servers to pick from.
  const showPicker = !editing && serverOptions.length > 0;
  const serverPicker = showPicker && (
    <div className="space-y-1.5">
      <Label htmlFor="xaa-reg-server-picker">
        Start from an existing server
      </Label>
      <Select value={pickedServerName} onValueChange={handlePickServer}>
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
        Copies the server&apos;s saved details into the form as a one-time
        snapshot — edit anything before saving.
      </p>
    </div>
  );

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

        {isReview ? (
          <>
            {serverPicker}

            <h3
              ref={stepHeadingRef}
              tabIndex={-1}
              className="text-sm font-semibold outline-none"
            >
              Review &amp; register
            </h3>
            <ReviewSummary draft={draft} />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleClearPick}
              disabled={isSaving}
              className="self-start px-0 text-xs text-muted-foreground hover:text-foreground"
            >
              Clear selection and start from scratch
            </Button>
          </>
        ) : (
          <>
            <ol
              className="flex items-center gap-2"
              aria-label="Registration steps"
            >
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
                {/* Registering starts from picking one of the project's
                    servers; manual entry below is the fallback. */}
                {showPicker && (
                  <>
                    {serverPicker}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span
                        aria-hidden="true"
                        className="h-px flex-1 bg-border"
                      />
                      or enter details manually
                      <span
                        aria-hidden="true"
                        className="h-px flex-1 bg-border"
                      />
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
          </>
        )}

        {(validationError || saveError) && (
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {validationError ?? saveError}
          </p>
        )}

        <DialogFooter>
          {isReview ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => setStepsExpanded(true)}
                disabled={isSaving}
              >
                Edit details
              </Button>
              <Button
                type="button"
                onClick={handleRegisterFromReview}
                disabled={isSaving}
              >
                {isSaving ? (
                  <>
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    Registering
                  </>
                ) : (
                  "Register app"
                )}
              </Button>
            </>
          ) : (
            <>
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
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

/** Read-only summary of exactly what "Register app" will save. Honest about
 * provenance: the auth-server mode is the wizard's default (a pick never sets
 * it), while the issuer/client id/scopes are the picked server's snapshot. */
function ReviewSummary({ draft }: { draft: RegistrationDraft }) {
  const scopes = parseScopes(draft.scopes);
  return (
    <dl
      data-testid="xaa-reg-review"
      className="space-y-2 rounded-md border border-border bg-muted/30 px-3 py-2.5 text-xs"
    >
      <ReviewRow label="Name">
        <span className="font-medium">{draft.name}</span>
      </ReviewRow>
      <ReviewRow label="Resource URL">
        <code className="font-mono break-all">{draft.resourceUrl}</code>
      </ReviewRow>
      <ReviewRow label="Auth server">
        {draft.authServerMode === "mcpjam" ? (
          "MCPJam test auth server"
        ) : draft.issuer.trim() ? (
          <>
            My own auth server —{" "}
            <code className="font-mono break-all">{draft.issuer.trim()}</code>
          </>
        ) : (
          <>
            My own auth server{" "}
            <span className="text-muted-foreground">(no issuer set)</span>
          </>
        )}
      </ReviewRow>
      {draft.targetClientId.trim() && (
        <ReviewRow label="Client ID">
          <code className="font-mono break-all">
            {draft.targetClientId.trim()}
          </code>
        </ReviewRow>
      )}
      <ReviewRow label="Scopes">
        {scopes.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {scopes.map((scope) => (
              <code
                key={scope}
                className="rounded bg-muted px-1.5 py-0.5 font-mono"
              >
                {scope}
              </code>
            ))}
          </span>
        ) : (
          <span className="text-muted-foreground">none declared</span>
        )}
      </ReviewRow>
    </dl>
  );
}
