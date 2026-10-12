import { useEffect, useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { Button } from "@mcpjam/design-system/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@mcpjam/design-system/alert-dialog";
import type { AccountDeletionInspection } from "@mcpjam/sdk/account-deletion";
import {
  accountDeletionClient,
  startAccountDeletion,
  useAccountDeletionFlow,
} from "@/lib/account-deletion-flow";

const obligationText = {
  transfer_ownership:
    "Transfer organization ownership before deleting your account.",
  ownership_unresolved:
    "Organization ownership could not be verified. Contact support.",
  scope_deleting:
    "An organization deletion is in progress. Wait for it to finish.",
  inventory_limit: "Your organizations need verification. Contact support.",
};
function useAccountDeletionInspection(actorSubject?: string) {
  const [inspection, setInspection] =
    useState<AccountDeletionInspection | null>(null);
  const [available, setAvailable] = useState(false);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState("");
  async function refresh() {
    setChecking(true);
    setError("");
    setInspection(null);
    setAvailable(false);
    try {
      const client = accountDeletionClient();
      const capability = await client.capabilities();
      setAvailable(capability.available);
      if (capability.available) setInspection(await client.inspect());
    } catch {
      setError(
        "Account deletion availability could not be checked. Try again later.",
      );
    } finally {
      setChecking(false);
    }
  }
  useEffect(() => {
    if (actorSubject) void refresh();
  }, [actorSubject]);
  return { inspection, available, checking, error, refresh };
}
function AccountDeletionObligations({
  inspection,
}: {
  inspection: AccountDeletionInspection | null;
}) {
  return (
    <>
      {inspection && !inspection.identityCoverageReady && (
        <p className="text-sm">
          Your account identities need verification. Contact support before
          deleting your account.
        </p>
      )}
      {inspection?.obligations.map((obligation, index) => (
        <p
          key={`${obligation.code}:${obligation.organizationId ?? index}`}
          className="text-sm"
        >
          {obligationText[obligation.code]}{" "}
          {obligation.organizationId && (
            <a
              className="underline"
              href={`/organizations/${encodeURIComponent(obligation.organizationId)}/members`}
            >
              View organization
            </a>
          )}
        </p>
      ))}
    </>
  );
}
function AccountDeletionConfirmation({
  actorSubject,
  inspection,
  confirming,
  setConfirming,
  currentActorSubject,
}: {
  actorSubject: string;
  inspection: AccountDeletionInspection | null;
  confirming: boolean;
  setConfirming: (open: boolean) => void;
  currentActorSubject: () => string | undefined;
}) {
  const { signOut } = useAuth();
  const flow = useAccountDeletionFlow();
  return (
    <AlertDialog open={confirming} onOpenChange={setConfirming}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete your account?</AlertDialogTitle>
          <AlertDialogDescription>
            Your account will be blocked immediately and you will be signed out.
            Personal data and private chats will be removed. Shared organization
            data is retained. You cannot cancel this request.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-sm text-muted-foreground">
          Keep this browser’s recovery record to check progress after sign-out.
          Deletion starts after your request is accepted.
        </p>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={flow.busy}>
            Keep account
          </AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={flow.busy || !inspection?.ready}
            onClick={() => {
              if (inspection?.ready)
                void startAccountDeletion(
                  actorSubject,
                  inspection.checkpointSha256,
                  signOut,
                  currentActorSubject,
                );
            }}
          >
            Start account deletion
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
export function AccountDeletionSection() {
  const { user } = useAuth();
  const currentActor = useRef(user?.id);
  currentActor.current = user?.id;
  useEffect(() => {
    currentActor.current = user?.id;
    return () => {
      // A detached settings section cannot authorize cleanup against a later session.
      currentActor.current = "";
    };
  }, [user?.id]);
  const flow = useAccountDeletionFlow();
  const { inspection, available, checking, error, refresh } =
    useAccountDeletionInspection(user?.id);
  const [confirming, setConfirming] = useState(false);
  if (!user) return null;
  return (
    <section
      className="space-y-3 border-t border-border pt-6"
      aria-labelledby="delete-account-title"
    >
      <h2 id="delete-account-title" className="text-sm font-semibold">
        Delete account
      </h2>
      <p className="text-sm text-muted-foreground">
        Delete your personal data and private chats. Shared organization data is
        retained.
      </p>
      {checking ? (
        <p role="status" className="text-sm">
          Checking deletion requirements…
        </p>
      ) : !available && !error ? (
        <p className="text-sm text-muted-foreground">
          Account deletion is unavailable. Contact support for a deletion
          request.
        </p>
      ) : null}
      {(error || flow.error) && (
        <p role="alert" className="text-sm text-destructive">
          {error || flow.error}
        </p>
      )}
      <AccountDeletionObligations inspection={inspection} />
      <div className="flex gap-2">
        <Button
          variant="outline"
          disabled={checking || flow.busy}
          onClick={() => void refresh()}
        >
          Check requirements
        </Button>
        <Button
          variant="destructive"
          disabled={checking || flow.busy || !available || !inspection?.ready}
          onClick={() => setConfirming(true)}
        >
          Delete account
        </Button>
      </div>
      <AccountDeletionConfirmation
        actorSubject={user.id}
        inspection={inspection}
        confirming={confirming}
        setConfirming={setConfirming}
        currentActorSubject={() => currentActor.current}
      />
    </section>
  );
}
