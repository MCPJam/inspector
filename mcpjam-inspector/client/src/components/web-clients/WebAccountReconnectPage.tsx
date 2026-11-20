import { useState, type ReactNode } from "react";
import { useParams, useSearchParams } from "react-router";
import { useConvexAuth } from "convex/react";
import { getFunctionName } from "convex/server";
import { CircleAlert, CircleCheck, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertTitle } from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import { useSoftQuery } from "@/hooks/use-soft-query";
import { useCanManageProjectClients } from "@/hooks/useProjects";
import { useWebClientsEnabled } from "@/hooks/useWebClientsEnabled";
import { copyToClipboard } from "@/lib/clipboard";
import {
  webAccountsApi,
  type WebAccount,
  type WebReconnectRequest,
} from "@/lib/web-accounts/api";
import {
  webAccountName,
  webClientName,
  webClientSite,
} from "@/lib/web-accounts/clients";
import {
  handBackWebReconnect,
  saveWebAccountProfile,
  startWebAccountSignIn,
  type HandbackResult,
} from "@/lib/web-accounts/routes";
import { SaveWebAccountBar } from "./SaveWebAccountBar";
import { WebSignInBrowser } from "./WebSignInBrowser";

type Outcome = { tone: "success" | "warning"; text: string };

/** What a handback did, and the step that finishes it when it didn't. */
function handbackOutcome(
  result: HandbackResult,
  site: string,
  email?: string,
): Outcome {
  switch (result.status) {
    case "resumed":
      return {
        tone: "success",
        text: `${site} is signed in again. ${result.resumedRuns === 1 ? "1 waiting run resumed." : `${result.resumedRuns} waiting runs resumed.`}`,
      };
    case "not_signed_in":
      return {
        tone: "warning",
        text: `${site} doesn't show a signed-in account yet. Finish signing in, then try again.`,
      };
    case "wrong_identity":
      return {
        tone: "warning",
        text: `The browser is signed in to another ${site} account. Sign in as ${email ?? "this account"}, then try again.`,
      };
    case "not_found":
      return {
        tone: "warning",
        text: "This sign-in request no longer exists. Check the account in its client's Browser settings.",
      };
    case "cancelled":
      return {
        tone: "warning",
        text: "This request was closed because the account was removed, so no runs wait on it.",
      };
  }
}

/**
 * Where an admin signs a web account in again: from the email a waiting run
 * sends, from Take over on a paused run, or from Sign in again in a client's
 * settings. With runs waiting, finishing hands the account back so they
 * resume; with none, it saves the sign-in for the project.
 */
export function WebAccountReconnectPage() {
  const { webAccountId } = useParams();
  const [params] = useSearchParams();
  const enabled = useWebClientsEnabled();
  const projectId = params.get("project");
  if (!enabled || !webAccountId || !projectId) return null;
  return (
    <Reconnect
      webAccountId={webAccountId}
      projectId={projectId}
      requestId={params.get("request")}
    />
  );
}

function Reconnect({
  webAccountId,
  projectId,
  requestId,
}: {
  webAccountId: string;
  projectId: string;
  requestId: string | null;
}) {
  const { isAuthenticated } = useConvexAuth();
  const args = isAuthenticated ? { projectId } : "skip";
  const accounts = useSoftQuery<WebAccount[]>(
    getFunctionName(webAccountsApi.list),
    args,
  );
  const requests = useSoftQuery<WebReconnectRequest[]>(
    getFunctionName(webAccountsApi.reconnectRequests),
    args,
  );
  const role = useCanManageProjectClients({ isAuthenticated, projectId });
  const [browserSessionId, setBrowserSessionId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();

  const account = accounts.data?.find((a) => a.webAccountId === webAccountId);
  if (accounts.error || requests.error || (accounts.data && !account))
    return (
      <Page>
        <p role="alert" className="text-sm text-destructive">
          Couldn't find this web account in the project. Ask a project admin for
          a new link.
        </p>
      </Page>
    );
  if (!account || !requests.data || role.isLoading)
    return (
      <Page>
        <p role="status" className="text-sm text-muted-foreground">
          Loading the sign-in request…
        </p>
      </Page>
    );
  // The email names its request; Sign in again from settings finds the
  // account's open one, so its waiting runs resume either way.
  const request = requests.data.find((r) =>
    requestId
      ? r.requestId === requestId
      : r.webAccountId === webAccountId && r.status === "open",
  );
  const site = webClientSite(account.vendor);
  const open = !request || request.status === "open";

  const run = async (step: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setOutcome(undefined);
    try {
      await step();
    } catch {
      // A route failure says nothing a person can act on beyond trying again.
      setOutcome({ tone: "warning", text: fallback });
    } finally {
      setBusy(false);
    }
  };
  const takeOver = () =>
    run(async () => {
      const started = await startWebAccountSignIn(projectId, webAccountId);
      setBrowserSessionId(started.browserSessionId);
    }, `Couldn't open a browser to sign in to ${site}. Try again.`);
  const finish = (handback: string) =>
    run(async () => {
      const result = await handBackWebReconnect(projectId, handback);
      setOutcome(handbackOutcome(result, site, account.accountEmail));
    }, "Couldn't resume the waiting runs. Try again.");

  const rows: Array<[string, string]> = [
    [
      "What happened",
      request?.reason ??
        (account.status === "needs_sign_in"
          ? `${site} signed this account out.`
          : "Signing in again replaces the account's saved sign-in."),
    ],
    ...(request
      ? [
          [
            "Waiting runs",
            request.waitingRunCount === 1
              ? "1 run waits for this account and continues once it's signed in."
              : `${request.waitingRunCount} runs wait for this account and continue once it's signed in.`,
          ] as [string, string],
        ]
      : []),
    ["Who can finish it", "A project admin, by signing in here."],
  ];

  return (
    <Page>
      <header className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">
          Sign in to {site} again
        </h1>
        <p className="text-sm text-muted-foreground">
          {webAccountName(account)} on {webClientName(account.vendor)}
        </p>
      </header>
      <dl className="space-y-2.5 text-sm">
        {rows.map(([term, detail]) => (
          <div key={term} className="space-y-0.5">
            <dt className="text-xs text-muted-foreground">{term}</dt>
            <dd className="text-foreground">{detail}</dd>
          </div>
        ))}
      </dl>
      {outcome ? (
        <Alert variant={outcome.tone} data-testid="reconnect-outcome">
          {outcome.tone === "success" ? (
            <CircleCheck aria-hidden />
          ) : (
            <CircleAlert aria-hidden />
          )}
          <AlertTitle className="line-clamp-none">{outcome.text}</AlertTitle>
        </Alert>
      ) : null}
      {!open ? (
        <p className="text-sm text-muted-foreground">
          {request?.status === "resolved"
            ? "This account was signed in again, and its waiting runs resumed."
            : "This request was closed because the account was removed."}
        </p>
      ) : !role.canManage ? (
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>
            Send this page to a project admin. Only an admin can sign in to a
            project account.
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              void copyToClipboard(window.location.href).then((copied) =>
                copied
                  ? toast.success("Link copied. Send it to a project admin.")
                  : toast.error("Couldn't copy the link. Try again."),
              )
            }
          >
            <Link2 aria-hidden />
            Copy link for an admin
          </Button>
        </div>
      ) : !browserSessionId ? (
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => void takeOver()}
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
          Take over the browser
        </Button>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {request ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-3 py-2 text-xs">
              <p className="font-medium text-foreground">
                Sign in to {site} in the browser below, then finish to resume
                the waiting runs.
              </p>
              <Button
                type="button"
                size="sm"
                disabled={busy}
                onClick={() => void finish(request.requestId)}
              >
                {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
                Finish and resume runs
              </Button>
            </div>
          ) : (
            <SaveWebAccountBar
              vendor={account.vendor}
              expectedEmail={account.accountEmail}
              onSave={() =>
                saveWebAccountProfile(projectId, webAccountId, browserSessionId)
              }
            />
          )}
          <div className="flex h-[520px] flex-col">
            <WebSignInBrowser
              projectId={projectId}
              browserSessionId={browserSessionId}
            />
          </div>
        </div>
      )}
    </Page>
  );
}

function Page({ children }: { children: ReactNode }) {
  return (
    <main
      data-testid="web-account-reconnect"
      className="mx-auto w-full max-w-3xl space-y-4 p-6"
    >
      {children}
    </main>
  );
}
