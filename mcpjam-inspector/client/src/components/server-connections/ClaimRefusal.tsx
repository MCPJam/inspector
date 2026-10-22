import type { ClaimRefusalDetails } from "@/shared/server-connection-claim-refusal";
import { Shell } from "./HandoffShell";

/**
 * The claim was refused because of WHO is asking — the one failure on this page
 * with something to do about it.
 *
 * Both branches say the link survives, because it does: the backend checks the
 * claimant before it consumes the token, so the same URL still works after
 * signing in or switching accounts. That is the fact the old single message
 * left out, and the reason people treated a recoverable state as a dead end.
 */
export function ClaimRefusal({
  refusal,
  signedInAs,
  busy,
  onSignIn,
  onSwitchAccount,
}: {
  refusal: ClaimRefusalDetails;
  signedInAs: string | null;
  busy: boolean;
  onSignIn: () => void;
  onSwitchAccount: () => void;
}) {
  const owner = refusal.ownerHint;

  if (refusal.reason === "sign-in-required") {
    return (
      <Shell>
        <div className="space-y-2">
          <h1 className="text-lg font-semibold">
            Sign in to finish connecting
          </h1>
          <p className="text-sm text-muted-foreground">
            {owner
              ? `This connection request was created by ${owner}. Sign in to that account to continue.`
              : "This connection request was created by an MCPJam account. Sign in to continue."}
          </p>
          <p className="text-sm text-muted-foreground">
            This link is still valid — nothing has been used up.
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          className="w-full rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50"
          onClick={onSignIn}
        >
          {busy ? "Opening sign-in…" : "Sign in"}
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="space-y-2">
        <h1 className="text-lg font-semibold">
          This link belongs to a different account
        </h1>
        <p className="text-sm text-muted-foreground">
          {signedInAs ? (
            <>
              You are signed in as{" "}
              <span className="font-medium text-foreground">{signedInAs}</span>
              .{" "}
            </>
          ) : null}
          {owner
            ? `This connection request was created by ${owner}.`
            : "This connection request was created by a different MCPJam account."}
        </p>
        {/* Named explicitly because the CLI is where these links come from, and
            an agent driving it cannot see which account it is acting as. The
            mismatch is almost always "the browser and the terminal are logged
            into different accounts", and `whoami` is the one command that
            settles it. */}
        <p className="text-sm text-muted-foreground">
          If you started this from the MCPJam CLI, that is the account it is
          logged into — <code className="font-mono text-xs">mcpjam whoami</code>{" "}
          will confirm which.
        </p>
        <p className="text-sm text-muted-foreground">
          This link is still valid. Switch accounts and open it again.
        </p>
      </div>
      <button
        type="button"
        disabled={busy}
        className="w-full rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50"
        onClick={onSwitchAccount}
      >
        {busy ? "Signing out…" : "Switch account"}
      </button>
    </Shell>
  );
}
