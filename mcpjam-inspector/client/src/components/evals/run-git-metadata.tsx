import type { EvalSuiteRun } from "./types";
import { RunSourceBadge } from "./run-source-badge";
import type { RunOriginInput } from "@/lib/evals/run-origin";

export function readRunPullRequest(
  metadata: EvalSuiteRun["ciMetadata"] | null,
) {
  try {
    const url = new URL(
      metadata?.prUrl?.trim() || metadata?.runUrl?.trim() || "",
    );
    const match = url.pathname.match(
      /^\/[^/]+\/[^/]+\/pull\/([1-9]\d*)(?:\/|$)/,
    );
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !match ||
      (!metadata?.prUrl?.trim() && url.hostname !== "github.com")
    )
      return null;
    return { url: url.href, number: match[1] };
  } catch {
    return null;
  }
}

export function RunPlatformBadge({
  run,
}: {
  /** The run row (or a `{ source }` stand-in). See `RunSourceBadge`. */
  run: RunOriginInput;
}) {
  return <RunSourceBadge run={run} />;
}

function safeHttpUrl(raw: string | null | undefined): string | null {
  try {
    const url = new URL(raw?.trim() ?? "");
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.href.replace(/\/$/, "");
  } catch {
    return null;
  }
}

function repositoryFromUrl(raw: string | null): {
  name: string;
  url: string;
} | null {
  if (!raw) return null;
  const url = new URL(raw);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return {
    name: `${parts[0]}/${parts[1]}`,
    url: `${url.origin}/${parts[0]}/${parts[1]}`,
  };
}

/** Git values and their safe, explicit destinations. */
export function readRunGitMetadata(
  metadata: EvalSuiteRun["ciMetadata"] | null,
) {
  const branch = metadata?.branch?.trim() || null;
  const commitSha = metadata?.commitSha?.trim() || null;
  const runUrl = safeHttpUrl(metadata?.runUrl);
  let repositoryInfo = repositoryFromUrl(safeHttpUrl(metadata?.repositoryUrl));
  const pr = readRunPullRequest(metadata);
  if (!repositoryInfo && pr) {
    repositoryInfo = repositoryFromUrl(pr.url);
  }
  if (!repositoryInfo && runUrl) {
    const url = new URL(runUrl);
    if (url.hostname === "github.com") {
      repositoryInfo = repositoryFromUrl(runUrl);
    }
  }
  const repositoryUrl = repositoryInfo?.url ?? null;
  const branchUrl =
    safeHttpUrl(metadata?.branchUrl) ??
    (repositoryUrl && branch
      ? `${repositoryUrl}/tree/${encodeURIComponent(branch)}`
      : null);
  const commitUrl =
    repositoryUrl && commitSha
      ? `${repositoryUrl}/commit/${encodeURIComponent(commitSha)}`
      : null;
  return {
    branch,
    branchUrl,
    commitSha,
    commitUrl,
    runUrl,
    repository: repositoryInfo?.name ?? null,
    repositoryUrl,
    pullRequestNumber: pr?.number ?? null,
    pullRequestUrl: pr?.url ?? null,
    pipelineId: metadata?.pipelineId?.trim() || null,
    jobId: metadata?.jobId?.trim() || null,
  };
}

export type RunGitMetadataValue = ReturnType<typeof readRunGitMetadata>;

function GitLink({
  href,
  label,
  title,
  mono = false,
}: {
  href: string | null;
  label: string | null;
  title?: string;
  mono?: boolean;
}) {
  if (!href || !label) return <span className="text-muted-foreground">—</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`block max-w-48 truncate text-xs text-foreground hover:underline focus-visible:outline-ring ${mono ? "font-mono" : ""}`}
      title={title ?? label}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {label}
    </a>
  );
}

export function RunCommitCell({ git }: { git: RunGitMetadataValue | null }) {
  return (
    <GitLink
      href={git?.commitUrl ?? null}
      label={git?.commitSha?.slice(0, 7) ?? null}
      title={git?.commitSha ?? undefined}
      mono
    />
  );
}

export function RunPullRequestCell({
  git,
}: {
  git: RunGitMetadataValue | null;
}) {
  return (
    <GitLink
      href={git?.pullRequestUrl ?? null}
      label={git?.pullRequestNumber ? `#${git.pullRequestNumber}` : null}
      title={
        git?.pullRequestNumber
          ? `Open pull request #${git.pullRequestNumber}`
          : undefined
      }
    />
  );
}

export function RunBranchCell({ git }: { git: RunGitMetadataValue | null }) {
  return (
    <GitLink
      href={git?.branchUrl ?? null}
      label={git?.branch ?? null}
      title={git?.branch ? `Open branch ${git.branch}` : undefined}
    />
  );
}
