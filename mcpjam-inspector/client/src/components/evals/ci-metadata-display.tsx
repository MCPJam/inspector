import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { EvalSuiteRun } from "./types";
import { GitBranch, GitCommit, Link as LinkIcon } from "lucide-react";

interface CiMetadataDisplayProps {
  ciMetadata?: EvalSuiteRun["ciMetadata"];
  compact?: boolean;
  compactMode?: "full" | "chip";
  interactive?: boolean;
}

function getGitHubRepoBaseUrl(runUrl?: string): string | null {
  if (!runUrl) return null;
  try {
    const url = new URL(runUrl);
    if (url.hostname !== "github.com") return null;
    const pathParts = url.pathname.split("/").filter(Boolean);
    if (pathParts.length < 2) return null;
    return `${url.origin}/${pathParts[0]}/${pathParts[1]}`;
  } catch {
    return null;
  }
}

function formatCommitSha(commitSha?: string): string | null {
  if (!commitSha) return null;
  const trimmed = commitSha.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 7);
}

export function CiMetadataDisplay({
  ciMetadata,
  compact = false,
  compactMode = "full",
  interactive = true,
}: CiMetadataDisplayProps) {
  const branch = ciMetadata?.branch?.trim();
  const fullSha = ciMetadata?.commitSha?.trim();
  const shortSha = formatCommitSha(fullSha);
  const runUrl = ciMetadata?.runUrl?.trim();
  const repoBaseUrl = getGitHubRepoBaseUrl(runUrl);
  const branchUrl = branch
    ? repoBaseUrl
      ? `${repoBaseUrl}/tree/${encodeURIComponent(branch)}`
      : runUrl
    : undefined;
  const commitUrl = shortSha
    ? repoBaseUrl
      ? `${repoBaseUrl}/commit/${encodeURIComponent(fullSha ?? shortSha)}`
      : runUrl
    : undefined;
  const hasMetadata = !!branch || !!shortSha || !!runUrl;

  if (!hasMetadata) {
    return null;
  }

  const chip = (
    <Badge variant="outline" className="shrink-0 font-mono">
      CI
    </Badge>
  );

  if (compactMode === "chip") {
    const details = [
      branch ? { label: "Branch", value: branch } : null,
      shortSha ? { label: "Commit", value: shortSha } : null,
      runUrl ? { label: "Pipeline", value: "Available" } : null,
    ].filter(Boolean) as Array<{ label: string; value: string }>;

    const chipWithTooltip =
      details.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex shrink-0">{chip}</span>
          </TooltipTrigger>
          <TooltipContent align="start">
            <div className="space-y-1 text-xs">
              {details.map((detail) => (
                <div key={detail.label} className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">{detail.label}:</span>
                  <span className="font-mono">{detail.value}</span>
                </div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      ) : (
        chip
      );

    if (compact) {
      return <div className="flex flex-wrap items-center gap-1.5">{chipWithTooltip}</div>;
    }

    return (
      <div className="rounded-md border bg-muted/20 px-3 py-2">
        <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
          CI Metadata
        </div>
        <div className="flex flex-wrap items-center gap-1.5">{chipWithTooltip}</div>
      </div>
    );
  }

  const content = (
    <>
      {branch &&
        (interactive && branchUrl ? (
          <a
            href={branchUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <Badge
              variant="outline"
              className="shrink-0 font-mono hover:border-primary/50 hover:text-primary"
            >
              <GitBranch className="mr-1 h-3 w-3" />
              {branch}
            </Badge>
          </a>
        ) : (
          <Badge variant="outline" className="shrink-0 font-mono">
            <GitBranch className="mr-1 h-3 w-3" />
            {branch}
          </Badge>
        ))}
      {shortSha &&
        (interactive && commitUrl ? (
          <a
            href={commitUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            <Badge
              variant="outline"
              className="shrink-0 font-mono hover:border-primary/50 hover:text-primary"
            >
              <GitCommit className="mr-1 h-3 w-3" />
              {shortSha}
            </Badge>
          </a>
        ) : (
          <Badge variant="outline" className="shrink-0 font-mono">
            <GitCommit className="mr-1 h-3 w-3" />
            {shortSha}
          </Badge>
        ))}
      {runUrl &&
        (interactive ? (
          <a
            href={runUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center whitespace-nowrap text-xs text-primary hover:underline"
          >
            <LinkIcon className="mr-1 h-3 w-3" />
            Pipeline
          </a>
        ) : (
          <Badge variant="outline" className="shrink-0">
            <LinkIcon className="mr-1 h-3 w-3" />
            Pipeline
          </Badge>
        ))}
    </>
  );

  if (compact) {
    return <div className="flex flex-wrap items-center gap-1.5">{content}</div>;
  }

  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
        CI Metadata
      </div>
      <div className="flex flex-wrap items-center gap-1.5">{content}</div>
    </div>
  );
}
