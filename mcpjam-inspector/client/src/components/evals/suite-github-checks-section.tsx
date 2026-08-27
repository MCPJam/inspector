import { useEffect, useRef, useState } from "react";
import { Github, Plus } from "lucide-react";
import { toast } from "@/lib/toast";
import { Button } from "@mcpjam/design-system/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { useAppNavigate } from "@/lib/app-navigation";
import { githubChecksWriteErrorMessage } from "@/lib/github-checks-errors";
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
  type InstallationRepo,
} from "@/hooks/useGithubChecksSettings";
import {
  OutagePolicyExplainer,
  OutagePolicySelectItems,
} from "@/components/settings/github-checks-outage-policy";

/**
 * "Run this suite on every pull request", on the suite itself.
 *
 * Discovery at the point of intent. Someone looking at a suite they want
 * enforced is the only person who wants this feature at that moment, and no
 * amount of nav placement creates that moment — so the affordance lives here
 * and the full management surface stays in Settings → Integrations.
 *
 * Deliberately NARROWER than the settings page: connect this suite to a repo,
 * and see which repos already run it. Changing a repo's suite, pausing it, or
 * disconnecting are all repo-level decisions that belong where every repo is
 * visible at once — offering them here would let you retarget a repo away from
 * the suite you are standing on, which reads as a mistake even when it is not.
 *
 * The outage policy is the ONE thing this narrow surface still has to ask for.
 * It is set at connect time and it is not editable here, so skipping it would
 * make this the path that quietly produces rows nobody chose a policy for —
 * exactly the legacy state the settings page has to warn about.
 *
 * Renders nothing at all when GitHub Checks is unavailable for the org.
 */
export function SuiteGithubChecksSection({
  suiteId,
  projectId,
  organizationId,
}: {
  suiteId: string;
  projectId?: string | null;
  organizationId?: string | null;
}) {
  const appNavigate = useAppNavigate();
  const { availability, repos, connectVerifiedRepo, listInstallationRepos } =
    useGithubChecksSettings(organizationId);

  const [installationRepos, setInstallationRepos] = useState<
    InstallationRepo[] | null
  >(null);
  const [pickerRepo, setPickerRepo] = useState("");
  // Unset until chosen. A default here would be a decision made for someone.
  const [pickerPolicy, setPickerPolicy] = useState<
    GithubCheckOutagePolicy | ""
  >("");
  const [connecting, setConnecting] = useState(false);

  // Whether this instance is still on screen. The `ErrorBoundary` wrapping this
  // section in `suite-iterations-view` is KEYED BY organizationId, so switching
  // organizations remounts the component with a connect still in flight. That
  // completion belongs to the organization that is gone — and while React drops
  // the state writes for an unmounted tree, `toast` is global and would happily
  // announce a repository connected to an organization the user has left. An
  // org-id ref cannot see this: the remounted instance starts with a fresh one.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isEnabled = availability?.state === "enabled";

  useEffect(() => {
    let cancelled = false;
    setInstallationRepos(null);
    setPickerRepo("");
    setPickerPolicy("");
    if (!isEnabled) {
      return () => {
        cancelled = true;
      };
    }
    void listInstallationRepos()
      .then((repositories) => {
        if (!cancelled) setInstallationRepos(repositories);
      })
      .catch(() => {
        // Silent here, unlike the settings page. This section is incidental to
        // the suite you came to look at, and a toast about GitHub you did not
        // ask about would be noise; the picker simply stays empty and the
        // manage link still works.
        if (!cancelled) setInstallationRepos([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isEnabled, listInstallationRepos]);

  if (!isEnabled) return null;

  const allRepos = repos ?? [];
  const connectedToThisSuite = allRepos.filter(
    (row) => row.suiteId === suiteId
  );
  // Every repo already connected to ANY suite is excluded: a repo runs exactly
  // one suite, so offering one that is spoken for would produce a rejected
  // write, or silently retarget it away from the suite it is on today.
  const alreadyConnected = new Set(
    allRepos.map((row) => row.repoFullName.toLowerCase())
  );
  const connectableRepos =
    repos === undefined
      ? []
      : (installationRepos ?? []).filter(
          (repo) => !alreadyConnected.has(repo.fullName.toLowerCase())
        );

  // Selection, labelling and the connect payload are shared with the settings
  // page through `@/lib/github-repo-picker` — the same contract, stated once.
  const pickedRepo = findRepoByPickerValue(connectableRepos, pickerRepo);
  const showAccountLabels = shouldShowAccountLabels(connectableRepos);

  const handleConnect = async () => {
    if (!pickedRepo || !projectId || !pickerPolicy) return;
    setConnecting(true);
    try {
      // The server-VERIFIED connect: it proves the selected installation can
      // actually reach this repository before any row is written, and the
      // reference and repository id say WHICH installation and WHICH repository
      // — both re-verified server-side.
      await connectVerifiedRepo(
        verifiedConnectArgs(pickedRepo, {
          projectId,
          suiteId,
          outagePolicy: pickerPolicy,
        })
      );
      if (!mountedRef.current) return;
      setPickerRepo("");
      setPickerPolicy("");
      toast.success("Repository connected.");
    } catch (error) {
      // Same rule for the failure: an error about an organization the user has
      // already left is noise they cannot act on.
      if (!mountedRef.current) return;
      toast.error(githubChecksWriteErrorMessage(error));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="space-y-3">
      {connectedToThisSuite.length > 0 ? (
        <div className="space-y-2">
          {connectedToThisSuite.map((row) => (
            <div
              key={row._id}
              className="flex items-center gap-2 text-sm"
              data-testid={`suite-github-repo-${row.repoFullName}`}
            >
              <Github className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="truncate">{row.repoFullName}</span>
              {!row.enabled ? (
                <span className="text-xs text-muted-foreground">(paused)</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          No repositories run this suite yet.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {/* Valued by REPOSITORY ID, not name: two connected accounts can each
            have a `widgets`, and the id is what the connect is keyed on. */}
        <Select value={pickerRepo} onValueChange={setPickerRepo}>
          <SelectTrigger className="w-72" aria-label="Repository">
            <SelectValue placeholder="Select a repository" />
          </SelectTrigger>
          <SelectContent>
            {connectableRepos.map((repo) => (
              <SelectItem key={repo.repositoryId} value={pickerValueFor(repo)}>
                {pickerLabelFor(repo, showAccountLabels)}
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
          size="sm"
          onClick={() => void handleConnect()}
          disabled={connecting || !pickedRepo || !projectId || !pickerPolicy}
        >
          <Plus className="mr-2 size-3.5" aria-hidden /> Connect
        </Button>
      </div>

      <OutagePolicyExplainer className="space-y-1 text-xs text-muted-foreground" />

      {installationRepos !== null && connectableRepos.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No repositories available to connect. Install the MCPJam GitHub App on
          a repository, or free one up in{" "}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => appNavigate("/settings/integrations/github")}
          >
            Settings → Integrations
          </button>
          .
        </p>
      ) : (
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={() => appNavigate("/settings/integrations/github")}
        >
          Manage in Settings → Integrations
        </button>
      )}
    </div>
  );
}
