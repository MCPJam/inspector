import { DefaultModelCardHeader } from "./DefaultModelCardHeader";
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
import { Card, CardContent } from "@mcpjam/design-system/card";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import type { EligibleProvider } from "./OrganizationDefaultModelEditor";
import {
  ModelRow,
  type DefaultModelRowAccess,
} from "./OrganizationDefaultModelRow";
import {
  useDefaultModelActions,
  type PendingEmbeddingChange,
} from "./use-default-model-actions";


/**
 * The organization's default AI model: the one model background AI work
 * runs on while "Use your keys for all AI features" is on (insights and
 * findings, generation, typed decisions, simulated users). One row per kind
 * the backend supports, so an embedding or transcription model appears when
 * the backend serves one, with no change here.
 *
 * Shows the saved model or a suggestion, without saving anything implicitly.
 * A model that can no longer run stays visible with the backend's reason.
 * Model pickers never use it, and each suite still chooses its own judge.
 *
 * Enterprise only, from the backend's `canEnable`, like the switch above it.
 * A model saved before the organization left Enterprise stays visible.
 * Members see it read-only. On a backend that does not
 * report organization AI models, it renders nothing.
 */
export function OrganizationDefaultModelCard({
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
    aiModels,
    error,
    isSaving,
    testError,
    isTesting,
    editingKind,
    testingKind,
    pendingEmbeddingChange,
    actionsFor,
    dismissEmbeddingChange,
    confirmEmbeddingChange,
  } = useDefaultModelActions(organizationId);
  if (!config || !aiModels) return null;

  const canManage = isAdmin && config.canManage !== false;
  // Only the backend's answer locks it. Clearing a saved model never is.
  const locked = !config.canEnable;
  const canChange = canManage && !locked;
  const requireOrgKeys = config.aiKeyPolicy.requireOrgKeys;
  const eligibleIds = new Set(config.readiness.eligibleConnectionIds);
  const eligibleProviders = providers?.filter(
    (p): p is EligibleProvider =>
      typeof p.id === "string" && eligibleIds.has(p.id),
  );
  const suggestions = canChange ? aiModels.suggestions : {};
  const access: DefaultModelRowAccess = { canManage, canChange, locked };

  return (
    <Card
      className="gap-4 border-0 bg-transparent py-0 shadow-none"
      data-testid="org-ai-default-model-card"
    >
      <DefaultModelCardHeader
        title={
          aiModels.kinds.length === 1 ? "Default AI model" : "Default AI models"
        }
        locked={locked}
        requireOrgKeys={requireOrgKeys}
      />
      <CardContent className="space-y-3 p-0">
        <DefaultModelCardNotices
          error={error}
          testError={testError}
          locked={locked}
          canManage={canManage}
        />

        <ul className="space-y-1">
          {aiModels.kinds.map((kind) => {
            const entry = aiModels.models[kind] ?? null;
            return (
              <ModelRow
                key={kind}
                kind={kind}
                entry={entry}
                suggestion={entry ? undefined : suggestions[kind]}
                providers={providers}
                access={access}
                busy={{
                  isSaving,
                  isTesting,
                  isTestingThis: testingKind === kind,
                }}
                editor={
                  editingKind === kind && canChange
                    ? {
                        // The backend owns connection eligibility and validates
                        // the model's capability on Test and Save.
                        eligibleProviders,
                      }
                    : null
                }
                actions={actionsFor(kind)}
              />
            );
          })}
        </ul>
      </CardContent>

      <EmbeddingChangeDialog
        pending={pendingEmbeddingChange}
        isSaving={isSaving}
        onDismiss={dismissEmbeddingChange}
        onConfirm={confirmEmbeddingChange}
      />
    </Card>
  );
}

function DefaultModelCardNotices({
  error,
  testError,
  locked,
  canManage,
}: {
  error: string | null | undefined;
  testError: string | null | undefined;
  locked: boolean;
  canManage: boolean;
}) {
  return (
    <>
      {error ? (
        <Alert variant="destructive" data-testid="org-ai-default-model-error">
          <AlertTitle>Couldn&apos;t save the model</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {testError ? (
        <Alert
          variant="destructive"
          data-testid="org-ai-default-model-test-error"
        >
          <AlertTitle>Couldn&apos;t test the model</AlertTitle>
          <AlertDescription>{testError}</AlertDescription>
        </Alert>
      ) : null}

      {locked ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid="org-ai-default-model-enterprise-only"
        >
          Available on Enterprise plans.
        </p>
      ) : null}
      {!canManage && !locked ? (
        <p className="text-xs text-muted-foreground">
          Only organization owners and admins can change this.
        </p>
      ) : null}
    </>
  );
}

/**
 * Vectors from two embedding models are never compared, so changing the
 * embedding model is confirmed first.
 */
function EmbeddingChangeDialog({
  pending,
  isSaving,
  onDismiss,
  onConfirm,
}: {
  pending: PendingEmbeddingChange | null;
  isSaving: boolean;
  onDismiss: () => void;
  onConfirm: (pending: PendingEmbeddingChange) => void;
}) {
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(next) => {
        if (!next && !isSaving) onDismiss();
      }}
    >
      <AlertDialogContent data-testid="org-ai-embedding-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>Change the embedding model?</AlertDialogTitle>
          <AlertDialogDescription>
            The session map and clustering only compare vectors made by the same
            embedding model, so sessions embedded with the current model
            won&apos;t be compared with sessions embedded with the new one.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isSaving}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isSaving}
            onClick={(event) => {
              event.preventDefault();
              if (pending) onConfirm(pending);
            }}
          >
            {isSaving ? "Saving…" : "Change embedding model"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
