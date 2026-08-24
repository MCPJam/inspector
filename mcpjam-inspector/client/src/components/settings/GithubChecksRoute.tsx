import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router";
import { useConvexAuth } from "convex/react";
import { ChevronLeft, Github, Plus, Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { useAppNavigate } from "@/lib/app-navigation";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Switch } from "@mcpjam/design-system/switch";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { useOrganizationQueries } from "@/hooks/useOrganizations";
import {
  OutagePolicyExplainer,
  OutagePolicySelectItems,
} from "./github-checks-outage-policy";
import { SettingsSection } from "../setting/SettingsSection";
import { SettingsPageShell } from "./SettingsPageShell";
import {
  githubChecksWriteErrorMessage,
  GITHUB_BINDING_STATUS_COPY,
  GITHUB_CONNECTION_STATUS_COPY,
  GITHUB_CONNECTION_STATUS_LABEL,
  GITHUB_UNBIND_CONFIRMATION,
} from "@/lib/github-checks-errors";
import { redirectToGithub } from "@/lib/github-external-redirect";
import {
  findRepoByPickerValue,
  pickerLabelFor,
  pickerValueFor,
  shouldShowAccountLabels,
  verifiedConnectArgs,
} from "@/lib/github-repo-picker";
import {
  useGithubChecksSettings,
  type GithubCheckOutagePolicy,
  type GithubCheckRepoConfigRow,
  type GithubInstallationBinding,
  type InstallationRepo,
  type SuiteOption,
} from "@/hooks/useGithubChecksSettings";

/**
 * `/settings/integrations/github` — connect repositories to a GitHub PR check.
 * (`/settings/github-checks` still resolves; the router redirects it here.)
 *
 * Availability is BACKEND-decided (see `useGithubChecksSettings`); this
 * component never consults a client-side flag. It renders three states:
 *
 *   undefined → nothing (still asking)
 *   disabled  → redirect to /settings
 *   enabled   → the page
 *
 * The `undefined` case must not redirect. While the query is in flight we do
 * not yet know whether the user is allowed here, and bouncing on "don't know"
 * would strand a legitimately-enabled user who cold-loads the URL.
 */

interface GithubChecksRouteProps {
  activeOrganizationId?: string | null;
}

/**
 * The row's current check state.
 *
 * This deliberately does NOT claim where the recipe came from. The backend
 * contract carries no provenance field, and deriving one from the `enabled`
 * toggle would state something we have not been told — a repo shown as
 * "declared in mcpjam.yaml" when nobody checked is worse than saying nothing.
 * The page-level copy explains where recipes come from in general; when the
 * backend returns provenance per repo, it belongs here.
 */
function RepoCheckState({ enabled }: { enabled: boolean }) {
  return (
    <span className="text-xs text-muted-foreground">
      {enabled ? "Checks run on every pull request" : "Checks paused"}
    </span>
  );
}

/**
 * Live GitHub visibility, or nothing.
 *
 * `undefined` is UNKNOWN, and it arrives four ways: GitHub omitted the flag,
 * the repository is not in the current installation listing, the listing has
 * not loaded yet, or the listing failed. None of those is evidence that a
 * repository is public, so none of them renders a badge. Guessing wrong here
 * labels somebody's private repository as public on their own settings page.
 */
function RepoVisibilityBadge({ isPrivate }: { isPrivate?: boolean }) {
  if (isPrivate === undefined) return null;
  return (
    <Badge variant="outline" className="shrink-0">
      {isPrivate ? "Private" : "Public"}
    </Badge>
  );
}

/**
 * Whether this connection is actually ready, and what to do if it is not.
 *
 * The status is DERIVED BY THE BACKEND from three facts this app never sees —
 * a verified repository identity, an active org ↔ installation binding, and
 * per-repository access. It is deliberately NOT inferred from the visibility
 * badge above: absence there means "GitHub did not tell us", which is a
 * different thing from "something is wrong", and conflating them would put a
 * scary warning on a perfectly healthy repository whose `private` flag GitHub
 * happened to omit.
 *
 * `verified` renders nothing at all. A badge saying "fine" on every healthy row
 * is noise that makes the three rows that need attention harder to find.
 */
function RepoConnectionState({
  status,
}: {
  status: GithubCheckRepoConfigRow["connectionStatus"];
}) {
  const label = GITHUB_CONNECTION_STATUS_LABEL[status];
  if (!label) return null;
  return (
    <Badge variant="outline" className="shrink-0">
      {label}
    </Badge>
  );
}

function RepoConnectionExplainer({
  status,
}: {
  status: GithubCheckRepoConfigRow["connectionStatus"];
}) {
  const copy = GITHUB_CONNECTION_STATUS_COPY[status];
  if (!copy) return null;
  return <span className="text-xs text-muted-foreground">{copy}</span>;
}

/**
 * One GitHub account this workspace has connected.
 *
 * `accountLogin` is DISPLAY ONLY — GitHub allows renames, and nothing on either
 * side of this decides anything from it. The raw GitHub installation id is
 * never rendered and never received: `installationRef` is an opaque row id.
 */
function InstallationRow({
  binding,
  onUnbind,
  disabled,
}: {
  binding: GithubInstallationBinding;
  onUnbind: () => void;
  disabled: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between gap-4 px-4 py-3"
      data-testid={`installation-row-${binding.accountLogin}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <div className="size-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
          <Github className="size-4 text-primary" aria-hidden />
        </div>
        <div className="flex flex-col min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium truncate">
              {binding.accountLogin}
            </span>
            <Badge variant="outline" className="shrink-0">
              {binding.accountType === "Organization"
                ? "Organization"
                : "Personal"}
            </Badge>
          </div>
          <span className="text-xs text-muted-foreground">
            {GITHUB_BINDING_STATUS_COPY[binding.status]}
          </span>
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={onUnbind}
        aria-label={`Disconnect ${binding.accountLogin}`}
      >
        Disconnect
      </Button>
    </div>
  );
}

export function GithubChecksRoute({
  activeOrganizationId,
}: GithubChecksRouteProps = {}) {
  const appNavigate = useAppNavigate();
  const {
    availability,
    repos,
    suites,
    bindings,
    connectVerifiedRepo,
    setRepoEnabled,
    setRepoSuite,
    setRepoOutagePolicy,
    setRepoConformance,
    disconnectRepo,
    listInstallationRepos,
    startInstallation,
    startDirectClaim,
    unbindInstallation,
  } = useGithubChecksSettings(activeOrganizationId);

  // `activeOrganizationId` arrives asynchronously during app bootstrap, and the
  // route context types it `string | undefined` with no loading flag — so
  // "absent" and "not resolved yet" look identical from here.
  //
  // BOTH of these supply the missing signal, and neither alone is enough:
  // `useOrganizationQueries().isLoading` is computed as `isAuthenticated && …`,
  // so it reads NOT-loading while Convex auth is still resolving — exactly the
  // window a cold deep link lands in. Only once auth AND the org list have
  // settled is a missing id genuinely missing rather than merely early.
  const { isAuthenticated, isLoading: authLoading } = useConvexAuth();
  const { isLoading: organizationsLoading } = useOrganizationQueries({
    isAuthenticated,
  });

  // `null` = not loaded yet, `[]` = loaded and genuinely empty. The error is
  // tracked separately so a failed fetch never renders as "you have no
  // repositories, go install the App" — that would blame the user for an
  // outage.
  const [installationRepos, setInstallationRepos] = useState<
    InstallationRepo[] | null
  >(null);
  const [installationReposFailed, setInstallationReposFailed] = useState(false);
  const [connecting, setConnecting] = useState(false);
  // Config ids with an enable/disable write in flight. The `Switch` stays bound
  // to the server snapshot until the list refreshes, so two fast clicks would
  // both read the same stale `row.enabled` and send the same value twice.
  const [pendingToggles, setPendingToggles] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  // Policy writes are tracked SEPARATELY from `pendingToggles`: they are
  // different writes on the same row, and one set would have a policy change
  // disable the enable switch (and vice versa) for no reason the user can see.
  const [pendingPolicies, setPendingPolicies] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [pendingConformance, setPendingConformance] = useState<
    ReadonlySet<string>
  >(() => new Set());
  // The picker's value is the repository's NUMERIC ID as a string, not its
  // name. Two accounts can both have a `widgets`, and the id is what the connect
  // is actually keyed on — selecting by name would make the disambiguation the
  // account label provides purely cosmetic.
  const [pickerRepo, setPickerRepo] = useState<string>("");
  // Which binding action is in flight, so the buttons can be disabled without
  // one spinner standing in for all three.
  const [bindingBusy, setBindingBusy] = useState(false);
  // The binding an admin has asked to disconnect, held until they confirm.
  const [pendingUnbind, setPendingUnbind] =
    useState<GithubInstallationBinding | null>(null);
  const [pickerSuite, setPickerSuite] = useState<string>("");
  // `""` is "not chosen", and it is the only initial value this may have. A
  // preselected policy would record a decision the administrator never made —
  // the exact thing the unstamped legacy rows below exist to warn about.
  const [pickerPolicy, setPickerPolicy] = useState<
    GithubCheckOutagePolicy | ""
  >("");

  // The organization a completion belongs to. `activeOrganizationId` is a prop
  // and this component stays mounted across a switch, so an in-flight connect
  // resolves against whatever org is active WHEN IT LANDS — which is not
  // necessarily the one it was submitted for.
  const organizationIdRef = useRef(activeOrganizationId);
  useEffect(() => {
    organizationIdRef.current = activeOrganizationId;
  }, [activeOrganizationId]);

  /**
   * A write refused as unavailable means the surface flipped off underneath
   * us. Showing the stable message and re-reading availability is the honest
   * response — the next render redirects if it is genuinely off now.
   */
  const handleWriteError = useCallback((error: unknown) => {
    toast.error(githubChecksWriteErrorMessage(error));
  }, []);

  useEffect(() => {
    // Switching orgs must not let the previous org's in-flight result land on
    // the new one: `connectVerifiedRepo` sends the CURRENT org id, so a stale
    // selection would be submitted against an org that repo does not belong to.
    // Reset the picker and ignore any completion after cleanup.
    let cancelled = false;
    setInstallationRepos(null);
    setInstallationReposFailed(false);
    setPickerRepo("");
    setPickerSuite("");
    setPickerPolicy("");

    if (availability?.state !== "enabled") {
      return () => {
        cancelled = true;
      };
    }

    void listInstallationRepos()
      .then((repositories) => {
        if (!cancelled) setInstallationRepos(repositories);
      })
      .catch((error) => {
        if (cancelled) return;
        setInstallationReposFailed(true);
        handleWriteError(error);
      });

    return () => {
      cancelled = true;
    };
    // `activeOrganizationId` is listed even though nothing in the body reads it
    // directly: the org IS what this effect resets for, and depending only on
    // the callback's identity would tie the reset to a memoization detail of
    // the hook rather than to the switch itself.
  }, [
    activeOrganizationId,
    availability?.state,
    listInstallationRepos,
    handleWriteError,
  ]);

  // Without an active organization the availability query never runs, so
  // treating that as "still loading" would leave the page blank forever. But
  // redirecting the instant the id is missing would bounce a deep link during
  // the ordinary bootstrap window, so wait for the org list to settle first.
  // Once it has, there is nothing org-less to configure here — send them back
  // to Settings, the same call the Organization tab makes by omitting itself.
  if (!activeOrganizationId) {
    if (authLoading || organizationsLoading) return null;
    return <Navigate to="/settings" replace />;
  }

  // Tri-state. Only an explicit `disabled` redirects.
  if (availability === undefined) return null;
  if (availability.state === "disabled") {
    return <Navigate to="/settings" replace />;
  }

  const suiteOptions: SuiteOption[] = suites ?? [];
  const rows: GithubCheckRepoConfigRow[] = repos ?? [];

  const suiteById = (suiteId: string) =>
    suiteOptions.find((s) => s._id === suiteId);

  /**
   * Send the admin to GitHub to install, or to authorize a claim.
   *
   * Both start server-side — the URL carries a one-time state whose hash the
   * backend stored — so this only follows what it is handed, through a helper
   * that refuses anything not on github.com.
   */
  const beginBindingFlow = async (kind: "install" | "claim") => {
    setBindingBusy(true);
    try {
      const { url } =
        kind === "install"
          ? await startInstallation().then((r) => ({ url: r.installUrl }))
          : await startDirectClaim().then((r) => ({ url: r.authorizeUrl }));
      redirectToGithub(url);
    } catch (error) {
      handleWriteError(error);
      // Only cleared on failure: on success the browser is already leaving, and
      // re-enabling the button would invite a second click that burns a second
      // link session.
      setBindingBusy(false);
    }
  };

  const handleUnbindConfirmed = async () => {
    const binding = pendingUnbind;
    if (!binding) return;
    setPendingUnbind(null);
    setBindingBusy(true);
    try {
      await unbindInstallation({ installationRef: binding.installationRef });
      toast.success(`Disconnected ${binding.accountLogin}.`);
    } catch (error) {
      handleWriteError(error);
    } finally {
      setBindingBusy(false);
    }
  };

  const handleConnect = async () => {
    const suite = suiteById(pickerSuite);
    const repo = findRepoByPickerValue(connectableRepos, pickerRepo);
    // The same three-way rule the button enforces, enforced again here. The
    // disabled attribute is a hint to a person; this is the invariant, and the
    // policy half of it is why: a connect that quietly omitted `outagePolicy`
    // would store a row nobody chose a policy for — the legacy state this whole
    // screen exists to stop creating.
    if (!repo || !suite?.projectId || !pickerPolicy) {
      toast.error("Pick a repository, a suite, and an outage policy first.");
      return;
    }
    // Which org this submission belongs to. Compared against the ref after the
    // await, because the user can switch orgs while GitHub is being asked.
    const submittedForOrganization = activeOrganizationId;
    setConnecting(true);
    try {
      // The project is DERIVED from the suite, never picked separately: the
      // backend requires them to agree, so offering two controls would only
      // create a way to get it wrong.
      await connectVerifiedRepo(
        verifiedConnectArgs(repo, {
          projectId: suite.projectId,
          suiteId: suite._id,
          outagePolicy: pickerPolicy,
        })
      );
      // A completion for the PREVIOUS org lands on a page that is now showing a
      // different one. Clearing selections there would wipe a fresh choice, and
      // the success toast would credit the wrong organization.
      if (organizationIdRef.current !== submittedForOrganization) return;
      setPickerRepo("");
      setPickerSuite("");
      setPickerPolicy("");
      toast.success("Repository connected.");
    } catch (error) {
      // Same rule for the failure: an error about an org the user has already
      // left is noise they cannot act on.
      if (organizationIdRef.current !== submittedForOrganization) return;
      handleWriteError(error);
    } finally {
      setConnecting(false);
    }
  };

  const handleToggle = async (row: GithubCheckRepoConfigRow) => {
    // Ignore a second click while the first is still in flight. Without this,
    // both reads see the same pre-write `row.enabled` and send the identical
    // value twice — the second write is a no-op the backend correctly drops,
    // but the user's second intent is silently lost.
    if (pendingToggles.has(row._id)) return;
    setPendingToggles((current) => new Set(current).add(row._id));
    try {
      await setRepoEnabled({ configId: row._id, enabled: !row.enabled });
    } catch (error) {
      handleWriteError(error);
    } finally {
      setPendingToggles((current) => {
        const next = new Set(current);
        next.delete(row._id);
        return next;
      });
    }
  };

  const handleSuiteChange = async (
    row: GithubCheckRepoConfigRow,
    suiteId: string
  ) => {
    const suite = suiteById(suiteId);
    if (!suite?.projectId) return;
    try {
      await setRepoSuite({
        configId: row._id,
        projectId: suite.projectId,
        suiteId: suite._id,
      });
    } catch (error) {
      handleWriteError(error);
    }
  };

  const handlePolicyChange = async (
    row: GithubCheckRepoConfigRow,
    outagePolicy: GithubCheckOutagePolicy
  ) => {
    // Same reason as the enable toggle: the select stays bound to the server
    // snapshot until the list refreshes, so a second change made before the
    // first settles would be sent against a row state that is already moving.
    if (pendingPolicies.has(row._id)) return;
    setPendingPolicies((current) => new Set(current).add(row._id));
    try {
      // `{ changed: false }` is a successful no-op — the stored policy already
      // said this. Nothing to announce; only a throw is worth a toast.
      await setRepoOutagePolicy({ configId: row._id, outagePolicy });
    } catch (error) {
      handleWriteError(error);
    } finally {
      setPendingPolicies((current) => {
        const next = new Set(current);
        next.delete(row._id);
        return next;
      });
    }
  };

  const handleConformanceToggle = async (row: GithubCheckRepoConfigRow) => {
    if (pendingConformance.has(row._id)) return;
    setPendingConformance((current) => new Set(current).add(row._id));
    try {
      await setRepoConformance({
        configId: row._id,
        conformanceEnabled: row.conformanceEnabled !== true,
      });
    } catch (error) {
      handleWriteError(error);
    } finally {
      setPendingConformance((current) => {
        const next = new Set(current);
        next.delete(row._id);
        return next;
      });
    }
  };

  const handleDisconnect = async (row: GithubCheckRepoConfigRow) => {
    try {
      await disconnectRepo({ configId: row._id });
    } catch (error) {
      handleWriteError(error);
    }
  };

  // ONE normalization for every repository-name comparison on this page, on
  // both sides of every join. The backend stores the canonical lowercase form,
  // so today only the candidate strictly needs it — but two spellings of "the
  // same repository" is exactly how a padded listing entry earns a visibility
  // badge from one comparison while slipping past the already-connected filter
  // beside it, landing in the picker as an offer the submit then refuses.
  const normalizeRepoName = (fullName: string) => fullName.trim().toLowerCase();

  // Live visibility. Only an explicit boolean is recorded: a repository GitHub
  // returned without `private`, one that is not in this listing at all, and a
  // listing that has not loaded or has failed all fall through to `undefined`,
  // which renders no badge.
  const visibilityByRepo = new Map<string, boolean>();
  for (const repo of installationRepos ?? []) {
    if (typeof repo.private === "boolean") {
      visibilityByRepo.set(normalizeRepoName(repo.fullName), repo.private);
    }
  }

  const alreadyConnected = new Set(
    rows.map((row) => normalizeRepoName(row.repoFullName))
  );
  // Offer nothing until the connected list has actually loaded. `rows` is `[]`
  // while `repos` is undefined, so filtering then would advertise repositories
  // that are already connected and get rejected on submit.
  const connectableRepos =
    repos === undefined
      ? []
      : (installationRepos ?? []).filter(
          (repo) => !alreadyConnected.has(normalizeRepoName(repo.fullName))
        );

  // Selection and labelling live in `@/lib/github-repo-picker`, shared with the
  // suite's own picker: which value selects a repository, and what the verified
  // connect is told about it, are a contract with the backend rather than a
  // presentation detail, and two copies drift the first time either side gains
  // a field.
  const showAccountLabels = shouldShowAccountLabels(connectableRepos);

  const bindingRows: GithubInstallationBinding[] = bindings ?? [];

  return (
    <SettingsPageShell
      active="integrations"
      activeOrganizationId={activeOrganizationId}
    >
      {/* This page sits one level below the Integrations directory, and the
            nav's Integrations tab reads as active while you are on it — so
            without this there is no visible way back up. */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => appNavigate("/settings/integrations")}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-3" aria-hidden />
          Integrations
        </button>
        <h2 className="text-lg font-medium">GitHub Checks</h2>
      </div>

      <p className="text-sm text-muted-foreground">
        Connect a repository to run an eval suite as a GitHub check on every
        pull request. The check runs the suite you pick here against the PR's
        preview server. Conformance is a second, opt-in check on the same build
        — existing repositories stay eval-only until you turn it on.
        head commit and reports back as a status check.
      </p>

      <SettingsSection title="GitHub accounts">
        {bindings === undefined ? (
          <div className="flex items-center justify-center px-4 py-8 text-sm text-muted-foreground">
            Loading…
          </div>
        ) : bindingRows.length === 0 ? (
          <div className="space-y-3 px-4 py-8 text-sm text-muted-foreground">
            <p>
              No GitHub accounts connected yet. Install the MCPJam app on the
              account whose repositories you want checked — or, if somebody has
              already installed it from GitHub, claim that installation for this
              workspace.
            </p>
          </div>
        ) : (
          bindingRows.map((binding) => (
            <InstallationRow
              key={binding.installationRef}
              binding={binding}
              disabled={bindingBusy}
              onUnbind={() => setPendingUnbind(binding)}
            />
          ))
        )}

        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <Button
            disabled={bindingBusy}
            onClick={() => void beginBindingFlow("install")}
          >
            <Github className="mr-2 size-4" aria-hidden /> Install on a GitHub
            account
          </Button>
          <Button
            variant="outline"
            disabled={bindingBusy}
            onClick={() => void beginBindingFlow("claim")}
          >
            Claim an existing installation
          </Button>
        </div>
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          Claiming is for an installation somebody already added from GitHub's
          side. You will be asked to sign in to GitHub so we can confirm you
          administer that account — installing the app is not on its own proof
          that it is yours to connect here.
        </p>
      </SettingsSection>

      {/* Explicit confirmation, and the copy says the LIMIT of the consequence
          as well as the consequence: disconnecting stops checks now, and keeps
          every suite and policy choice, so reconnecting is not a rebuild. */}
      <AlertDialog
        open={pendingUnbind !== null}
        onOpenChange={(open) => {
          if (!open) setPendingUnbind(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Disconnect {pendingUnbind?.accountLogin}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {GITHUB_UNBIND_CONFIRMATION}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it connected</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleUnbindConfirmed()}>
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SettingsSection title="Connected repositories">
        {repos === undefined ? (
          <div className="flex items-center justify-center px-4 py-8 text-sm text-muted-foreground">
            Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="space-y-3 px-4 py-8 text-sm text-muted-foreground">
            <p>
              No repositories connected yet. Connect a GitHub account above,
              then connect one of its repositories below to start running checks
              on its pull requests.
            </p>
            <p>
              A repository can declare its check recipe in a{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                mcpjam.yaml
              </code>{" "}
              at the repo root. Without one, MCPJam detects a recipe
              automatically.{" "}
              <a
                className="underline underline-offset-2 hover:text-foreground"
                href="https://docs.mcpjam.com/github-checks"
                target="_blank"
                rel="noreferrer"
              >
                Read the docs
              </a>
              .
            </p>
          </div>
        ) : (
          rows.map((row) => (
            <div
              key={row._id}
              className="flex items-center justify-between gap-4 px-4 py-3 rounded-md border border-border/40 bg-muted/20 transition-colors"
              data-testid={`repo-row-${row.repoFullName}`}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="size-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                  <Github className="size-4 text-primary" aria-hidden />
                </div>
                <div className="flex flex-col min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium truncate">
                      {row.repoFullName}
                    </span>
                    <RepoVisibilityBadge
                      isPrivate={visibilityByRepo.get(
                        normalizeRepoName(row.repoFullName)
                      )}
                    />
                    <RepoConnectionState status={row.connectionStatus} />
                  </div>
                  <RepoCheckState enabled={row.enabled} />
                  <RepoConnectionExplainer status={row.connectionStatus} />
                  {row.outagePolicy === undefined ? (
                    /* Not the same statement as "fail open": the backend does
                       behave that way for an unstamped row, but nobody chose
                       it, and saying so is what lets an administrator tell the
                       two apart. */
                    <span className="text-xs text-muted-foreground">
                      No outage policy chosen — effectively fails open, so the
                      check reports neutral during an MCPJam outage or pause.
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center gap-3 shrink-0">
                <Select
                  value={row.suiteId}
                  onValueChange={(value) => void handleSuiteChange(row, value)}
                >
                  <SelectTrigger
                    className="w-48"
                    aria-label={`Suite for ${row.repoFullName}`}
                  >
                    <SelectValue placeholder="Select a suite" />
                  </SelectTrigger>
                  <SelectContent>
                    {suiteOptions.map((suite) => (
                      <SelectItem key={suite._id} value={suite._id}>
                        {suite.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {/* `?? ""` shows the placeholder rather than a value. Binding
                    this to `fail_open` for an unstamped row would render the
                    administrator's screen as though they had already chosen
                    the default — a claim the stored row does not make. */}
                <Select
                  value={row.outagePolicy ?? ""}
                  disabled={pendingPolicies.has(row._id)}
                  onValueChange={(value) =>
                    void handlePolicyChange(
                      row,
                      value as GithubCheckOutagePolicy
                    )
                  }
                >
                  <SelectTrigger
                    className="w-44"
                    aria-label={`Outage policy for ${row.repoFullName}`}
                  >
                    <SelectValue placeholder="Policy not chosen" />
                  </SelectTrigger>
                  <SelectContent>
                    <OutagePolicySelectItems />
                  </SelectContent>
                </Select>

                <Switch
                  checked={row.enabled}
                  disabled={pendingToggles.has(row._id)}
                  onCheckedChange={() => void handleToggle(row)}
                  aria-label={`Enable checks for ${row.repoFullName}`}
                />

                <Switch
                  checked={row.conformanceEnabled === true}
                  disabled={pendingConformance.has(row._id) || !row.enabled}
                  onCheckedChange={() => void handleConformanceToggle(row)}
                  aria-label={`Enable conformance check for ${row.repoFullName}`}
                />

                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Disconnect ${row.repoFullName}`}
                  onClick={() => void handleDisconnect(row)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </div>
            </div>
          ))
        )}
      </SettingsSection>

      <SettingsSection title="Connect a repository">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          {/* Keyed and valued by REPOSITORY ID. Two connected accounts can
              each have a `widgets`, and the id is what the connect is actually
              keyed on — selecting by name would make the account label below
              purely decorative and let one pick resolve to the other repo. */}
          <Select value={pickerRepo} onValueChange={setPickerRepo}>
            <SelectTrigger className="w-72" aria-label="Repository">
              <SelectValue placeholder="Select a repository" />
            </SelectTrigger>
            <SelectContent>
              {connectableRepos.map((repo) => (
                <SelectItem
                  key={repo.repositoryId}
                  value={pickerValueFor(repo)}
                >
                  {pickerLabelFor(repo, showAccountLabels)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={pickerSuite} onValueChange={setPickerSuite}>
            <SelectTrigger className="w-56" aria-label="Suite">
              <SelectValue placeholder="Select a suite" />
            </SelectTrigger>
            <SelectContent>
              {suiteOptions.map((suite) => (
                <SelectItem key={suite._id} value={suite._id}>
                  {suite.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={pickerPolicy}
            onValueChange={(value) =>
              setPickerPolicy(value as GithubCheckOutagePolicy)
            }
          >
            <SelectTrigger className="w-52" aria-label="Outage policy">
              <SelectValue placeholder="Select an outage policy" />
            </SelectTrigger>
            <SelectContent>
              <OutagePolicySelectItems />
            </SelectContent>
          </Select>

          <Button
            onClick={() => void handleConnect()}
            disabled={
              connecting || !pickerRepo || !pickerSuite || !pickerPolicy
            }
          >
            <Plus className="mr-2 size-4" aria-hidden /> Connect
          </Button>
        </div>

        <OutagePolicyExplainer className="space-y-1 px-4 pb-3 text-xs text-muted-foreground" />

        {installationReposFailed ? (
          <div className="px-4 pb-4 text-sm text-muted-foreground">
            Could not load repositories from GitHub. This is usually temporary —
            reload the page to try again.
          </div>
        ) : installationRepos !== null && installationRepos.length === 0 ? (
          <div className="px-4 pb-4 text-sm text-muted-foreground">
            {bindingRows.length === 0
              ? "No repositories available. Connect a GitHub account above first."
              : "No repositories available. Give the MCPJam app access to the repositories you want checked on GitHub, then reload this page."}
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageShell>
  );
}
