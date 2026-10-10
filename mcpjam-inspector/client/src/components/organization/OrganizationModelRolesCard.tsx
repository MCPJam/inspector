import { useId, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { ChevronRight, Loader2 } from "lucide-react";
import type { ModelSelection } from "@mcpjam/sdk/browser";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Card, CardContent, CardHeader } from "@mcpjam/design-system/card";
import { cn } from "@mcpjam/design-system/cn";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  ORG_AI_MODEL_ROLES,
  orgAiRoleSelectionKey,
  useOrgAiConfig,
  type OrgAiConfig,
  type OrgAiModelRole,
  type OrgAiModelRoleChanges,
  type OrgAiModelRoleCheck,
  type OrgAiModelRoleTestResult,
} from "@/hooks/useOrgAiConfig";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import {
  ORG_AI_ROLE_PRESENTATION,
  STATUS_TONE_CLASSES,
  buildOrgRoleSelection,
  listedModelIds,
  orgProviderLabel,
  roleCheckOutcomePresentation,
  selectionModelLabel,
} from "./org-ai-config-presentation";

/** Where a saved role's connection stands against the provider list. */
type ConnectionState =
  | { kind: "loading" }
  | { kind: "ok"; provider: OrgModelProvider }
  | { kind: "ineligible"; provider: OrgModelProvider }
  | { kind: "removed" };

function connectionStateFor(
  selection: ModelSelection,
  providers: OrgModelProvider[] | undefined,
  eligibleIds: ReadonlySet<string>,
): ConnectionState {
  if (providers === undefined) return { kind: "loading" };
  const id =
    selection.connectionRef?.kind === "orgProvider"
      ? selection.connectionRef.id
      : undefined;
  const provider = id ? providers.find((p) => p.id === id) : undefined;
  if (!id || !provider) return { kind: "removed" };
  return eligibleIds.has(id)
    ? { kind: "ok", provider }
    : { kind: "ineligible", provider };
}

function sameSelection(
  a: ModelSelection | null | undefined,
  b: ModelSelection | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  return orgAiRoleSelectionKey(a) === orgAiRoleSelectionKey(b);
}

/** The newest check recorded for exactly this role + selection. */
function latestCheck(
  config: OrgAiConfig,
  role: OrgAiModelRole,
  selection: ModelSelection,
  local: OrgAiModelRoleCheck | undefined,
): OrgAiModelRoleCheck | undefined {
  const key = orgAiRoleSelectionKey(selection);
  let latest: OrgAiModelRoleCheck | undefined;
  for (const check of config.aiModelRoleChecks ?? []) {
    if (check.role !== role || check.selectionKey !== key) continue;
    if (!latest || check.checkedAt > latest.checkedAt) latest = check;
  }
  if (
    local &&
    local.selectionKey === key &&
    (!latest || local.checkedAt > latest.checkedAt)
  ) {
    return local;
  }
  return latest;
}

function relativeTime(timestamp: number): string {
  try {
    return formatDistanceToNow(timestamp, { addSuffix: true });
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

/**
 * Which organization model each kind of AI work runs on (Fast, Smart,
 * Embedding, Transcription), behind an "Advanced" disclosure.
 *
 * Nothing here saves on its own: suggested defaults are shown and saved only
 * when an admin clicks "Use suggested defaults", and a role whose connection
 * was removed stays visible as "Connection removed: choose another" rather
 * than being silently pointed somewhere else.
 */
export function OrganizationModelRolesCard({
  organizationId,
  isAdmin,
  providers,
}: {
  organizationId: string;
  isAdmin: boolean;
  /** The organization's provider rows, from `useOrgModelConfig`. */
  providers: OrgModelProvider[] | undefined;
}) {
  const {
    config,
    unsupported,
    error,
    isSaving,
    testError,
    isTesting,
    saveRoles,
    testRole,
  } = useOrgAiConfig(organizationId);

  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  const [editingRole, setEditingRole] = useState<OrgAiModelRole | null>(null);
  const [testingRole, setTestingRole] = useState<OrgAiModelRole | null>(null);
  const [localChecks, setLocalChecks] = useState<
    Partial<Record<OrgAiModelRole, OrgAiModelRoleCheck>>
  >({});
  const [pendingEmbeddingChange, setPendingEmbeddingChange] = useState<{
    changes: OrgAiModelRoleChanges;
    onSaved?: () => void;
  } | null>(null);

  if (unsupported || !config) return null;

  const canManage = isAdmin && config.canManage !== false;
  const roles = config.aiModelRoles ?? { revision: 0 };
  const eligibleIds = new Set(config.readiness.eligibleConnectionIds);
  const eligibleProviders = (providers ?? []).filter(
    (p): p is OrgModelProvider & { id: string } =>
      typeof p.id === "string" && eligibleIds.has(p.id),
  );
  const suggestions = canManage ? (config.suggestedAiModelRoles ?? {}) : {};
  const suggestedChanges: OrgAiModelRoleChanges = {};
  for (const role of ORG_AI_MODEL_ROLES) {
    const suggestion = suggestions[role];
    if (!roles[role] && suggestion) suggestedChanges[role] = suggestion;
  }
  const hasSuggestedChanges = Object.keys(suggestedChanges).length > 0;

  // A saved role that no longer points at a usable connection is the one
  // state here that needs attention, so the disclosure opens itself for it.
  const needsAttention = ORG_AI_MODEL_ROLES.some((role) => {
    const selection = roles[role];
    if (!selection) return false;
    const state = connectionStateFor(selection, providers, eligibleIds);
    return state.kind === "removed" || state.kind === "ineligible";
  });
  const open = openOverride ?? needsAttention;

  const commit = async (
    changes: OrgAiModelRoleChanges,
    onSaved?: () => void,
  ) => {
    try {
      await saveRoles(changes);
      onSaved?.();
    } catch {
      // The hook keeps the backend's message for the alert below.
    }
  };

  /**
   * Save, unless the embedding model changes: that rebuilds the session map
   * and clustering, so it is confirmed first.
   */
  const requestSave = (
    changes: OrgAiModelRoleChanges,
    onSaved?: () => void,
  ) => {
    if (
      "embedding" in changes &&
      !sameSelection(changes.embedding, roles.embedding)
    ) {
      setPendingEmbeddingChange({ changes, onSaved });
      return;
    }
    void commit(changes, onSaved);
  };

  const runTest = async (
    role: OrgAiModelRole,
    candidate?: ModelSelection,
  ): Promise<OrgAiModelRoleTestResult | undefined> => {
    setTestingRole(role);
    try {
      const result = await testRole(role, candidate);
      const saved = roles[role];
      if (result && !candidate && saved) {
        setLocalChecks((current) => ({
          ...current,
          [role]: {
            role,
            selectionKey: orgAiRoleSelectionKey(saved),
            checkedAt: result.checkedAt,
            outcome: result.outcome,
            ...(result.code ? { code: result.code } : {}),
          },
        }));
      }
      return result;
    } catch {
      // The hook keeps the message for the alert below.
      return undefined;
    } finally {
      setTestingRole(null);
    }
  };

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpenOverride}
      data-testid="org-ai-model-roles"
    >
      <CollapsibleTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2.5 text-muted-foreground"
        >
          <ChevronRight
            className={cn("size-4 transition-transform", open && "rotate-90")}
          />
          Advanced
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Card className="gap-4 border-0 bg-transparent py-3 shadow-none">
          <CardHeader className="px-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <h2 className="text-sm font-medium text-muted-foreground">
                  Model roles
                </h2>
                <p className="text-xs text-muted-foreground">
                  The organization model each kind of AI work runs on.{" "}
                  {config.aiKeyPolicy.requireOrgKeys
                    ? "Work whose role is unset is unavailable while your keys are required."
                    : "Work whose role is unset uses MCPJam-provided models."}
                </p>
              </div>
              {canManage && hasSuggestedChanges ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isSaving}
                  onClick={() => requestSave(suggestedChanges)}
                >
                  Use suggested defaults
                </Button>
              ) : null}
            </div>
          </CardHeader>
          <CardContent className="space-y-3 p-0">
            {error ? (
              <Alert variant="destructive" data-testid="org-ai-roles-error">
                <AlertTitle>Couldn&apos;t save model roles</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            {testError ? (
              <Alert
                variant="destructive"
                data-testid="org-ai-roles-test-error"
              >
                <AlertTitle>Couldn&apos;t test the model</AlertTitle>
                <AlertDescription>{testError}</AlertDescription>
              </Alert>
            ) : null}

            <ul className="space-y-1">
              {ORG_AI_MODEL_ROLES.map((role) => {
                const selection = roles[role];
                return (
                  <RoleRow
                    key={role}
                    role={role}
                    selection={selection}
                    suggestion={selection ? undefined : suggestions[role]}
                    connection={
                      selection
                        ? connectionStateFor(selection, providers, eligibleIds)
                        : undefined
                    }
                    providers={providers}
                    check={
                      selection
                        ? latestCheck(
                            config,
                            role,
                            selection,
                            localChecks[role],
                          )
                        : undefined
                    }
                    canManage={canManage}
                    isSaving={isSaving}
                    isTesting={isTesting}
                    isTestingThis={testingRole === role}
                    editing={editingRole === role}
                    eligibleProviders={eligibleProviders}
                    onEdit={() => setEditingRole(role)}
                    onCancelEdit={() => setEditingRole(null)}
                    onTestSaved={() => void runTest(role)}
                    onTestCandidate={(candidate) => runTest(role, candidate)}
                    onSave={(next) =>
                      requestSave({ [role]: next }, () => setEditingRole(null))
                    }
                    onClear={() => requestSave({ [role]: null })}
                  />
                );
              })}
            </ul>
          </CardContent>
        </Card>
      </CollapsibleContent>

      <AlertDialog
        open={pendingEmbeddingChange !== null}
        onOpenChange={(next) => {
          if (!next && !isSaving) setPendingEmbeddingChange(null);
        }}
      >
        <AlertDialogContent data-testid="org-ai-embedding-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Change the embedding model?</AlertDialogTitle>
            <AlertDialogDescription>
              Changing the embedding model rebuilds the session map and
              clustering with the new model. Existing maps stay labelled with
              the model they were built with until they&apos;re rebuilt.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isSaving}
              onClick={(event) => {
                event.preventDefault();
                const pending = pendingEmbeddingChange;
                if (!pending) return;
                void commit(pending.changes, pending.onSaved).finally(() =>
                  setPendingEmbeddingChange(null),
                );
              }}
            >
              {isSaving ? "Saving…" : "Change embedding model"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Collapsible>
  );
}

function SelectionSummary({
  selection,
  providers,
}: {
  selection: ModelSelection;
  providers: OrgModelProvider[] | undefined;
}) {
  const id =
    selection.connectionRef?.kind === "orgProvider"
      ? selection.connectionRef.id
      : undefined;
  const provider = id ? providers?.find((p) => p.id === id) : undefined;
  const model = selectionModelLabel(selection);
  return <>{provider ? `${orgProviderLabel(provider)} · ${model}` : model}</>;
}

function RoleRow({
  role,
  selection,
  suggestion,
  connection,
  providers,
  check,
  canManage,
  isSaving,
  isTesting,
  isTestingThis,
  editing,
  eligibleProviders,
  onEdit,
  onCancelEdit,
  onTestSaved,
  onTestCandidate,
  onSave,
  onClear,
}: {
  role: OrgAiModelRole;
  selection: ModelSelection | undefined;
  suggestion: ModelSelection | undefined;
  connection: ConnectionState | undefined;
  providers: OrgModelProvider[] | undefined;
  check: OrgAiModelRoleCheck | undefined;
  canManage: boolean;
  isSaving: boolean;
  isTesting: boolean;
  isTestingThis: boolean;
  editing: boolean;
  eligibleProviders: Array<OrgModelProvider & { id: string }>;
  onEdit: () => void;
  onCancelEdit: () => void;
  onTestSaved: () => void;
  onTestCandidate: (
    candidate: ModelSelection,
  ) => Promise<OrgAiModelRoleTestResult | undefined>;
  onSave: (selection: ModelSelection) => void;
  onClear: () => void;
}) {
  const { label, features } = ORG_AI_ROLE_PRESENTATION[role];
  const testable = selection !== undefined && connection?.kind === "ok";
  const outcome = check ? roleCheckOutcomePresentation(check.outcome) : null;

  return (
    <li
      className="space-y-2 rounded-md border border-border/40 px-3 py-2.5"
      data-testid={`org-ai-role-${role}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{features}</p>
        </div>
        {canManage ? (
          <div className="flex items-center gap-1">
            {testable ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Test ${label} model`}
                disabled={isTesting}
                onClick={onTestSaved}
              >
                {isTestingThis ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : null}
                Test
              </Button>
            ) : null}
            {!editing ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`${selection ? "Change" : "Set"} ${label} model`}
                onClick={onEdit}
              >
                {selection ? "Change" : "Set"}
              </Button>
            ) : null}
            {selection ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Clear ${label} model`}
                disabled={isSaving}
                onClick={onClear}
              >
                Clear
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      <div
        className="space-y-1 text-xs"
        data-testid={`org-ai-role-${role}-saved`}
      >
        {selection ? (
          <>
            {connection?.kind === "removed" ? (
              <p className="text-destructive">
                Connection removed: choose another
              </p>
            ) : null}
            {connection?.kind === "ineligible" ? (
              <p className="text-destructive">
                This connection isn&apos;t eligible: choose another
              </p>
            ) : null}
            <p className="break-all text-foreground">
              <SelectionSummary selection={selection} providers={providers} />
            </p>
            <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
              {check && outcome ? (
                <>
                  <span>Last test</span>
                  <Badge
                    variant="outline"
                    className={cn(STATUS_TONE_CLASSES[outcome.tone])}
                  >
                    {outcome.label}
                  </Badge>
                  <span>{relativeTime(check.checkedAt)}</span>
                </>
              ) : (
                <span>Not tested yet</span>
              )}
            </div>
          </>
        ) : (
          <p className="text-muted-foreground">
            Not set
            {suggestion ? (
              <>
                {" · Suggested: "}
                <SelectionSummary
                  selection={suggestion}
                  providers={providers}
                />
              </>
            ) : null}
          </p>
        )}
      </div>

      {editing && canManage ? (
        <RoleEditor
          role={role}
          initial={selection ?? suggestion}
          eligibleProviders={eligibleProviders}
          isSaving={isSaving}
          isTesting={isTesting}
          onCancel={onCancelEdit}
          onSave={onSave}
          onTest={onTestCandidate}
        />
      ) : null}
    </li>
  );
}

function initialNativeModel(selection: ModelSelection): string {
  return (
    selection.nativeModelId?.trim() ||
    selection.modelId.slice(selection.modelId.indexOf("/") + 1)
  );
}

function RoleEditor({
  role,
  initial,
  eligibleProviders,
  isSaving,
  isTesting,
  onCancel,
  onSave,
  onTest,
}: {
  role: OrgAiModelRole;
  initial: ModelSelection | undefined;
  eligibleProviders: Array<OrgModelProvider & { id: string }>;
  isSaving: boolean;
  isTesting: boolean;
  onCancel: () => void;
  onSave: (selection: ModelSelection) => void;
  onTest: (
    candidate: ModelSelection,
  ) => Promise<OrgAiModelRoleTestResult | undefined>;
}) {
  const { label } = ORG_AI_ROLE_PRESENTATION[role];
  const fieldId = useId();
  // Prefilled only from a connection that is still eligible. A removed one is
  // never swapped for another automatically; the admin picks.
  const initialConnectionId =
    initial?.connectionRef?.kind === "orgProvider"
      ? initial.connectionRef.id
      : undefined;
  const initialProvider = initialConnectionId
    ? eligibleProviders.find((p) => p.id === initialConnectionId)
    : undefined;
  const [connectionId, setConnectionId] = useState(initialProvider?.id ?? "");
  const [model, setModel] = useState(
    initial && initialProvider ? initialNativeModel(initial) : "",
  );
  const [candidateCheck, setCandidateCheck] = useState<{
    key: string;
    result: OrgAiModelRoleTestResult;
  } | null>(null);

  if (eligibleProviders.length === 0) {
    return (
      <div className="space-y-2 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
        <p>
          No eligible organization provider is configured. Add a direct cloud
          provider below; OpenRouter and local providers aren&apos;t eligible.
        </p>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    );
  }

  const provider = eligibleProviders.find((p) => p.id === connectionId);
  const candidate = provider ? buildOrgRoleSelection(provider, model) : null;
  const candidateKey = candidate ? orgAiRoleSelectionKey(candidate) : null;
  const candidateOutcome =
    candidateCheck && candidateCheck.key === candidateKey
      ? roleCheckOutcomePresentation(candidateCheck.result.outcome)
      : null;
  const listed = new Set(provider ? listedModelIds(provider) : []);
  if (initial && provider && initialConnectionId === provider.id) {
    listed.add(initialNativeModel(initial));
  }
  const isAzure = provider?.providerKey === "azure";

  return (
    <div
      className="space-y-3 rounded-md bg-muted/40 p-3"
      data-testid={`org-ai-role-${role}-editor`}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${fieldId}-connection`}>Connection</Label>
          <Select
            value={connectionId}
            onValueChange={(next) => {
              setConnectionId(next);
              setCandidateCheck(null);
            }}
          >
            <SelectTrigger
              id={`${fieldId}-connection`}
              aria-label={`${label} connection`}
              className="w-full"
            >
              <SelectValue placeholder="Choose a connection" />
            </SelectTrigger>
            <SelectContent>
              {eligibleProviders.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {orgProviderLabel(p)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${fieldId}-model`}>
            {isAzure ? "Deployment name" : "Model"}
          </Label>
          <Input
            id={`${fieldId}-model`}
            aria-label={`${label} model id`}
            list={`${fieldId}-models`}
            value={model}
            placeholder={isAzure ? "my-deployment" : "Provider model id"}
            autoComplete="off"
            onChange={(event) => setModel(event.target.value)}
          />
          <datalist id={`${fieldId}-models`}>
            {[...listed].map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>
        </div>
      </div>

      {provider && model.trim() && !candidate ? (
        <p className="text-xs text-destructive">
          Enter the model id the provider uses, for example its API model name.
        </p>
      ) : null}
      {candidate ? (
        <p className="break-all text-xs text-muted-foreground">
          Saved as {candidate.modelId}
        </p>
      ) : null}
      {candidateOutcome && candidateCheck ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Test</span>
          <Badge
            variant="outline"
            className={cn(STATUS_TONE_CLASSES[candidateOutcome.tone])}
            data-testid={`org-ai-role-${role}-candidate-outcome`}
          >
            {candidateOutcome.label}
          </Badge>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={!candidate || isSaving}
          onClick={() => {
            if (candidate) onSave(candidate);
          }}
        >
          Save
        </Button>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Test this ${label} model`}
          disabled={!candidate || isTesting}
          onClick={() => {
            if (!candidate || !candidateKey) return;
            void onTest(candidate).then((result) => {
              if (result) setCandidateCheck({ key: candidateKey, result });
            });
          }}
        >
          Test
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
