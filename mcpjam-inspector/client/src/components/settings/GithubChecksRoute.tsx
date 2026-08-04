import { useCallback, useEffect, useState } from "react";
import { Navigate } from "react-router";
import { useConvexAuth } from "convex/react";
import { Github, Plus, Trash2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import { Switch } from "@mcpjam/design-system/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { useOrganizationQueries } from "@/hooks/useOrganizations";
import { SettingsSection } from "../setting/SettingsSection";
import { SettingsNav } from "./SettingsNav";
import {
  GITHUB_CHECKS_UNAVAILABLE_MESSAGE,
  useGithubChecksSettings,
  type GithubCheckRepoConfigRow,
  type InstallationRepo,
  type SuiteOption,
} from "@/hooks/useGithubChecksSettings";

/**
 * `/settings/github-checks` — connect repositories to a GitHub PR check.
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

export function GithubChecksRoute({
  activeOrganizationId,
}: GithubChecksRouteProps = {}) {
  const {
    availability,
    repos,
    suites,
    connectRepo,
    setRepoEnabled,
    setRepoSuite,
    disconnectRepo,
    listInstallationRepos,
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
  const [pickerRepo, setPickerRepo] = useState<string>("");
  const [pickerSuite, setPickerSuite] = useState<string>("");

  /**
   * A write refused as unavailable means the surface flipped off underneath
   * us. Showing the stable message and re-reading availability is the honest
   * response — the next render redirects if it is genuinely off now.
   */
  const handleWriteError = useCallback((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("not currently available")) {
      toast.error(GITHUB_CHECKS_UNAVAILABLE_MESSAGE);
      return;
    }
    toast.error(message);
  }, []);

  useEffect(() => {
    // Switching orgs must not let the previous org's in-flight result land on
    // the new one: `connectRepo` sends the CURRENT org id, so a stale selection
    // would be submitted against an org that repo does not belong to. Reset the
    // picker and ignore any completion after cleanup.
    let cancelled = false;
    setInstallationRepos(null);
    setInstallationReposFailed(false);
    setPickerRepo("");
    setPickerSuite("");

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
  }, [availability?.state, listInstallationRepos, handleWriteError]);

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

  const handleConnect = async () => {
    const suite = suiteById(pickerSuite);
    if (!pickerRepo || !suite?.projectId) {
      toast.error("Pick a repository and a suite first.");
      return;
    }
    setConnecting(true);
    try {
      // The project is DERIVED from the suite, never picked separately: the
      // backend requires them to agree, so offering two controls would only
      // create a way to get it wrong.
      await connectRepo({
        repoFullName: pickerRepo,
        projectId: suite.projectId,
        suiteId: suite._id,
      });
      setPickerRepo("");
      setPickerSuite("");
      toast.success("Repository connected.");
    } catch (error) {
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

  const handleDisconnect = async (row: GithubCheckRepoConfigRow) => {
    try {
      await disconnectRepo({ configId: row._id });
    } catch (error) {
      handleWriteError(error);
    }
  };

  // Both sides lowercased. The backend stores the canonical lowercase form, so
  // today only the candidate strictly needs it — but relying on that means a
  // contract change silently reintroduces duplicate offers, and normalizing
  // both is free.
  const alreadyConnected = new Set(
    rows.map((row) => row.repoFullName.toLowerCase())
  );
  // Offer nothing until the connected list has actually loaded. `rows` is `[]`
  // while `repos` is undefined, so filtering then would advertise repositories
  // that are already connected and get rejected on submit.
  const connectableRepos =
    repos === undefined
      ? []
      : (installationRepos ?? []).filter(
          (repo) => !alreadyConnected.has(repo.fullName.toLowerCase())
        );

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-10 space-y-8 max-w-3xl">
        <div className="space-y-4">
          <h1 className="text-2xl font-semibold">Settings</h1>
          <SettingsNav
            active="github-checks"
            activeOrganizationId={activeOrganizationId}
          />
        </div>

        <p className="text-sm text-muted-foreground">
          Connect a repository to run an eval suite as a GitHub check on every
          pull request. The check runs the suite you pick here against the PR's
          head commit and reports back as a status check.
        </p>

        <SettingsSection title="Connected repositories">
          {repos === undefined ? (
            <div className="flex items-center justify-center px-4 py-8 text-sm text-muted-foreground">
              Loading…
            </div>
          ) : rows.length === 0 ? (
            <div className="space-y-3 px-4 py-8 text-sm text-muted-foreground">
              <p>
                No repositories connected yet. Install the MCPJam GitHub App on
                a repository, then connect it below to start running checks on
                its pull requests.
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
                    <span className="text-sm font-medium truncate">
                      {row.repoFullName}
                    </span>
                    <RepoCheckState enabled={row.enabled} />
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <Select
                    value={row.suiteId}
                    onValueChange={(value) =>
                      void handleSuiteChange(row, value)
                    }
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

                  <Switch
                    checked={row.enabled}
                    disabled={pendingToggles.has(row._id)}
                    onCheckedChange={() => void handleToggle(row)}
                    aria-label={`Enable checks for ${row.repoFullName}`}
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
            <Select value={pickerRepo} onValueChange={setPickerRepo}>
              <SelectTrigger className="w-64" aria-label="Repository">
                <SelectValue placeholder="Select a repository" />
              </SelectTrigger>
              <SelectContent>
                {connectableRepos.map((repo) => (
                  <SelectItem key={repo.fullName} value={repo.fullName}>
                    {repo.fullName}
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

            <Button
              onClick={() => void handleConnect()}
              disabled={connecting || !pickerRepo || !pickerSuite}
            >
              <Plus className="mr-2 size-4" aria-hidden /> Connect
            </Button>
          </div>

          {installationReposFailed ? (
            <div className="px-4 pb-4 text-sm text-muted-foreground">
              Could not load repositories from GitHub. This is usually temporary
              — reload the page to try again.
            </div>
          ) : installationRepos !== null && installationRepos.length === 0 ? (
            <div className="px-4 pb-4 text-sm text-muted-foreground">
              No repositories available. Install the MCPJam GitHub App on the
              repositories you want checked, then reload this page.
            </div>
          ) : null}
        </SettingsSection>
      </div>
    </div>
  );
}
