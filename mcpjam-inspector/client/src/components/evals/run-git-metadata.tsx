import type { EvalSuiteRun } from "./types";
import { RunSourceBadge } from "./run-source-badge";

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
  source,
  metadata,
}: {
  source: EvalSuiteRun["source"];
  metadata: EvalSuiteRun["ciMetadata"] | null;
}) {
  const pr = readRunPullRequest(metadata);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <RunSourceBadge source={source} />
      {pr && (
        <a
          href={pr.url}
          target="_blank"
          rel="noreferrer"
          className="rounded border border-border px-1.5 py-0 text-[10px] font-medium text-foreground hover:bg-muted hover:underline focus-visible:outline-ring"
          title={`Open pull request #${pr.number}`}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          #{pr.number}
        </a>
      )}
    </div>
  );
}

/** Existing persisted CI fields; repository is recoverable from GitHub URLs. */
export function readRunGitMetadata(
  metadata: EvalSuiteRun["ciMetadata"] | null,
) {
  const branch = metadata?.branch?.trim() || null;
  const commitSha = metadata?.commitSha?.trim() || null;
  let runUrl: string | null = null;
  let repository: string | null = null;
  let repositoryUrl: string | null = null;
  try {
    const url = new URL(metadata?.runUrl?.trim() ?? "");
    if (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
    ) {
      runUrl = url.href;
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.hostname === "github.com" && parts.length >= 2) {
        repository = `${parts[0]}/${parts[1]}`;
        repositoryUrl = `${url.origin}/${repository}`;
      }
    }
  } catch {
    /* Old runs may not contain a CI URL. */
  }
  const pr = readRunPullRequest(metadata);
  if (!repository && pr) {
    const url = new URL(pr.url);
    const parts = url.pathname.split("/").filter(Boolean);
    repository = `${parts[0]}/${parts[1]}`;
    repositoryUrl = `${url.origin}/${repository}`;
  }
  return {
    branch,
    commitSha,
    runUrl,
    repository,
    repositoryUrl,
    pipelineId: metadata?.pipelineId?.trim() || null,
    jobId: metadata?.jobId?.trim() || null,
  };
}

export function RunGitMetadata({
  metadata,
}: {
  metadata: EvalSuiteRun["ciMetadata"] | null;
}) {
  const git = readRunGitMetadata(metadata);
  const hasMetadata = Object.values(git).some(Boolean);
  if (!hasMetadata)
    return <span className="text-muted-foreground">Not recorded</span>;
  const linkClass =
    "truncate text-foreground hover:underline focus-visible:outline-ring";
  return (
    <div
      className="flex max-w-64 flex-col gap-1 text-xs"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {git.repository && (
        <a
          href={git.repositoryUrl!}
          target="_blank"
          rel="noreferrer"
          className={linkClass}
          title={git.repository}
        >
          {git.repository}
        </a>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
        {git.branch && (
          <span className="max-w-40 truncate" title={`Branch: ${git.branch}`}>
            {git.branch}
          </span>
        )}
        {git.commitSha &&
          (git.repositoryUrl ? (
            <a
              href={`${git.repositoryUrl}/commit/${encodeURIComponent(
                git.commitSha,
              )}`}
              target="_blank"
              rel="noreferrer"
              className={`${linkClass} font-mono`}
              title={git.commitSha}
            >
              {git.commitSha.slice(0, 7)}
            </a>
          ) : (
            <span className="font-mono" title={git.commitSha}>
              {git.commitSha.slice(0, 7)}
            </span>
          ))}
        {git.runUrl && (
          <a
            href={git.runUrl}
            target="_blank"
            rel="noreferrer"
            className={linkClass}
          >
            Open CI run
          </a>
        )}
      </div>
      {(git.pipelineId || git.jobId) && (
        <span
          className="truncate text-[10px] text-muted-foreground"
          title={[git.pipelineId, git.jobId].filter(Boolean).join(" · ")}
        >
          {[
            git.pipelineId && `Pipeline ${git.pipelineId}`,
            git.jobId && `Job ${git.jobId}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      )}
    </div>
  );
}
