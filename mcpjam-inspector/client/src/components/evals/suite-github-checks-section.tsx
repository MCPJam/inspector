import { useEffect, useState } from "react";
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
import {
  GITHUB_CHECKS_UNAVAILABLE_MESSAGE,
  useGithubChecksSettings,
  type InstallationRepo,
} from "@/hooks/useGithubChecksSettings";

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
  const { availability, repos, connectRepo, listInstallationRepos } =
    useGithubChecksSettings(organizationId);

  const [installationRepos, setInstallationRepos] = useState<
    InstallationRepo[] | null
  >(null);
  const [pickerRepo, setPickerRepo] = useState("");
  const [connecting, setConnecting] = useState(false);

  const isEnabled = availability?.state === "enabled";

  useEffect(() => {
    let cancelled = false;
    setInstallationRepos(null);
    setPickerRepo("");
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

  const handleConnect = async () => {
    if (!pickerRepo || !projectId) return;
    setConnecting(true);
    try {
      await connectRepo({
        repoFullName: pickerRepo,
        projectId,
        suiteId,
      });
      setPickerRepo("");
      toast.success("Repository connected.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(
        message.includes("not currently available")
          ? GITHUB_CHECKS_UNAVAILABLE_MESSAGE
          : message
      );
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
        <Button
          size="sm"
          onClick={() => void handleConnect()}
          disabled={connecting || !pickerRepo || !projectId}
        >
          <Plus className="mr-2 size-3.5" aria-hidden /> Connect
        </Button>
      </div>

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
