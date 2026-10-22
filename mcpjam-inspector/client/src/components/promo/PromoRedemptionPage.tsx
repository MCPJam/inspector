import { useEffect, useRef, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useMutation, useQuery } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { readStoredActiveOrganizationId } from "@/lib/active-organization-storage";
import { PromoFields } from "./PromoFields";
import { Dialog } from "@mcpjam/design-system/dialog";
import { PromoCardLayout } from "./PromoCardLayout";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import {
  clearPromoIntent,
  readPromoIntent,
  promoSignInState,
} from "@/lib/promo-intent";
import { writeAppSignInReturnPath } from "@/lib/app-signin-return-path";
import {
  campaignId,
  contextQuery,
  redeemMutation,
  refusalCopy,
  type Ready,
  type Receipt,
} from "./promo-api";

function ReceiptView({ receipt }: { receipt: Receipt }) {
  useEffect(() => {
    clearPromoIntent();
  }, []);
  return (
    <div className="space-y-4">
      <p>You've already redeemed your AGNTCon credits.</p>
      <p>
        {receipt.credits.toLocaleString()} credits added to{" "}
        {receipt.organizationName} on{" "}
        {new Date(receipt.redeemedAt).toLocaleDateString()}.
      </p>
      {receipt.canOpenOrganization && (
        <Button
          variant="outline"
          onClick={() =>
            window.location.assign(`/organizations/${receipt.organizationId}`)
          }
        >
          Open {receipt.organizationName}
        </Button>
      )}
    </div>
  );
}

function ClaimForm({ context }: { context: Ready }) {
  const redeem = useMutation(redeemMutation);
  const active = useActiveClaim();
  const [code, setCode] = usePromoCode();
  const [name, setName] = useState(context.account.name);
  const [company, setCompany] = useState<string | null>(null);
  const [orgId, setOrgId] = useState(() => initialOrganization(context));
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const org = context.organizations.find(
    (item) => item.organizationId === orgId,
  );
  const canSubmit =
    !!org &&
    !!context.account.email &&
    !!name.trim() &&
    !!(company ?? org.name).trim() &&
    !!code.trim() &&
    !pending;
  if (receipt) return <ReceiptView receipt={receipt} />;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!org || !canSubmit) return;
    setPending(true);
    setMessage("");
    try {
      const result = await redeem({
        campaignId,
        code,
        name,
        company: company ?? org.name,
        organizationId: org.organizationId,
      });
      if (!active.current) return;
      if (result.status === "refused")
        setMessage(
          refusalCopy[result.code] ?? "Could not redeem this card. Try again.",
        );
      else {
        clearPromoIntent();
        setReceipt(result.receipt);
      }
    } catch {
      // Do not report the mutation error: it can contain bearer or lead arguments.
      if (!active.current) return;
      setMessage(
        "Could not confirm redemption. Retry to recover your receipt or redeem the card.",
      );
    } finally {
      if (active.current) setPending(false);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-4 ph-no-capture" data-private>
      <PromoFields
        context={context}
        code={code}
        setCode={setCode}
        name={name}
        setName={setName}
        company={company ?? org?.name ?? ""}
        setCompany={setCompany}
        orgId={orgId}
        setOrgId={setOrgId}
      />
      {message && <p role="alert">{message}</p>}
      <Button type="submit" className="w-full" disabled={!canSubmit}>
        {pending ? "Redeeming…" : `Claim for ${org?.name ?? "organization"}`}
      </Button>
    </form>
  );
}

function SignedInClaim() {
  const { user } = useAuth();
  const ready = useDbUserReady();
  const context = useQuery(contextQuery, ready ? { campaignId } : "skip");
  if (!context || context.accountExternalId !== user?.id)
    return <p role="status">Loading your redemption details…</p>;
  if (context.status === "refused")
    return <p role="alert">{refusalCopy[context.code]}</p>;
  if (context.status !== "ready")
    return <ReceiptView receipt={context.receipt} />;
  return (
    <ClaimForm
      key={`${context.account.userId}:${context.organizations.map((o) => o.organizationId).join(",")}`}
      context={context}
    />
  );
}

export function PromoRedemptionPage() {
  const { user, signIn } = useAuth();
  const [error, setError] = useState("");
  async function login() {
    writeAppSignInReturnPath("/redeem");
    try {
      await signIn({ state: promoSignInState() });
    } catch {
      setError("Could not open sign-in. Try again.");
    }
  }
  return (
    <main className="min-h-screen bg-background text-foreground">
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) {
            clearPromoIntent();
            window.location.assign("/");
          }
        }}
      >
        <PromoCardLayout signedIn={!!user}>
          {user ? (
            <SignedInClaim key={user.id} />
          ) : (
            <div className="space-y-4">
              <Button className="w-full" onClick={login}>
                Sign in to claim
              </Button>
            </div>
          )}
          {error && <p role="alert">{error}</p>}
        </PromoCardLayout>
      </Dialog>
    </main>
  );
}

function useActiveClaim() {
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return active;
}

function initialOrganization(context: Ready) {
  if (context.organizations.length === 1)
    return context.organizations[0].organizationId;
  try {
    const stored = readStoredActiveOrganizationId(context.account.userId);
    return context.organizations.some((org) => org.organizationId === stored)
      ? stored!
      : (context.organizations[0]?.organizationId ?? "");
  } catch {
    // The named submit button still confirms the default when storage is blocked.
    console.debug("Organization preference storage unavailable");
    return context.organizations[0]?.organizationId ?? "";
  }
}

function usePromoCode() {
  const [code, setCode] = useState(readPromoIntent);
  useEffect(() => {
    const update = () => setCode(readPromoIntent());
    window.addEventListener("promo-intent-changed", update);
    return () => window.removeEventListener("promo-intent-changed", update);
  }, []);
  return [code, setCode] as const;
}
