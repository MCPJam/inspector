import { useId, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth, useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Label } from "@mcpjam/design-system/label";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useSignOut } from "@/hooks/use-sign-out";
import { useSoftQuery } from "@/hooks/use-soft-query";
import { describeConvexFailure } from "@/lib/convex-error";
import { reportCaught } from "@/lib/error-reporting";
import { PRIVACY_POLICY_URL, TERMS_OF_USE_URL } from "@/lib/legal-links";
import { toast } from "@/lib/toast";

/** `legalAcceptance:getStatus`; `null` for guests. */
export type LegalAcceptanceStatus = {
  needsAcceptance: boolean;
  termsVersion: string;
  privacyVersion: string;
  /** Owned by the backend, so the age shown is the age it records. */
  minimumAge: number;
};

const acceptRef = makeFunctionReference<
  "mutation",
  { termsVersion: string; privacyVersion: string; ageConfirmed: boolean },
  { alreadyAccepted: boolean }
>("legalAcceptance:accept");

/**
 * Asks a signed-in user to accept the current Terms and Privacy Policy, which
 * the WorkOS hosted sign-up page cannot do.
 *
 * Guests and visitors with no Convex identity never subscribe. The status is a
 * soft read: if the backend does not serve it (not deployed yet, or a browser
 * outliving a rollback) the app stays usable, and `traceConvexQueries` reports
 * the failure like any other query error.
 */
export function LegalAcceptanceGate() {
  const { user } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const ready = useDbUserReady();
  const { data: status } = useSoftQuery<LegalAcceptanceStatus | null>(
    "legalAcceptance:getStatus",
    user && isAuthenticated && ready ? {} : "skip",
  );
  if (!status?.needsAcceptance) return null;
  return <LegalAcceptanceDialog status={status} />;
}

function LegalAcceptanceDialog({ status }: { status: LegalAcceptanceStatus }) {
  const accept = useMutation(acceptRef);
  // The way out for someone who does not accept. It runs without the
  // runtime-server cleanup the sidebar passes in, because that cleanup lives
  // in App and this gate renders above App.
  const signOut = useSignOut();
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const ageCheckboxId = useId();

  const submit = async () => {
    setSaving(true);
    try {
      // Echo the versions on screen: the backend refuses any other pair, so a
      // tab opened before a new version cannot record consent to unseen text.
      await accept({
        termsVersion: status.termsVersion,
        privacyVersion: status.privacyVersion,
        ageConfirmed,
      });
    } catch (error) {
      const failure = describeConvexFailure(
        error,
        "Could not save your acceptance. Try again.",
      );
      // A refusal is the backend's worded answer (for example a version
      // change), not a fault worth paging on.
      if (!failure.refusal) {
        reportCaught(error, { source: "legal_acceptance_accept" });
      }
      toast.error(failure.message);
    } finally {
      setSaving(false);
    }
  };

  // No close button, Escape or outside click: `getStatus` is reactive, so the
  // dialog closes only once the backend has recorded the acceptance.
  return (
    <Dialog open>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Accept the Terms and Privacy Policy</DialogTitle>
          <DialogDescription>
            To keep using MCPJam, read and accept the{" "}
            <LegalLink href={TERMS_OF_USE_URL}>Terms of Use</LegalLink> and the{" "}
            <LegalLink href={PRIVACY_POLICY_URL}>Privacy Policy</LegalLink>.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Checkbox
            id={ageCheckboxId}
            checked={ageConfirmed}
            onCheckedChange={(checked) => setAgeConfirmed(checked === true)}
          />
          <Label htmlFor={ageCheckboxId}>
            I am at least {status.minimumAge} years old.
          </Label>
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={signOut}>
            Sign out
          </Button>
          <Button
            disabled={!ageConfirmed || saving}
            onClick={() => void submit()}
          >
            {saving ? "Saving…" : "Accept and continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LegalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-4"
    >
      {children}
    </a>
  );
}
