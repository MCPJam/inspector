import { Badge } from "@/components/ui/badge";
import type { EvalSuiteRun } from "./types";
import { GitBranch, GitCommit, Link as LinkIcon } from "lucide-react";

interface CiMetadataDisplayProps {
  ciMetadata?: EvalSuiteRun["ciMetadata"];
  compact?: boolean;
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
}: CiMetadataDisplayProps) {
  const branch = ciMetadata?.branch?.trim();
  const shortSha = formatCommitSha(ciMetadata?.commitSha);
  const runUrl = ciMetadata?.runUrl?.trim();
  const hasMetadata = !!branch || !!shortSha || !!runUrl;

  if (!hasMetadata) {
    return null;
  }

  const content = (
    <>
      {branch && (
        <Badge variant="outline" className="font-mono">
          <GitBranch className="mr-1 h-3 w-3" />
          {branch}
        </Badge>
      )}
      {shortSha && (
        <Badge variant="outline" className="font-mono">
          <GitCommit className="mr-1 h-3 w-3" />
          {shortSha}
        </Badge>
      )}
      {runUrl && (
        <a
          href={runUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center text-xs text-primary hover:underline"
        >
          <LinkIcon className="mr-1 h-3 w-3" />
          Pipeline
        </a>
      )}
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
