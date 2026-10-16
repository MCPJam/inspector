import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { ProjectClientInitNotice } from "@/components/hosts/ProjectClientInitNotice";
import type { ProjectClientInitState } from "@/hooks/use-project-client-initialization";

type Init = { state: ProjectClientInitState; retry: () => void };

/**
 * The composer notice for the Playground's first clients, or null when there
 * is nothing to say. A missing default reads as it does on Connect. A failed
 * comparison lineup does not block chat: the default client is already there.
 */
export function playgroundClientInitNotice({
  projectId,
  defaultInit,
  comparisonInit,
}: {
  projectId: string | null;
  defaultInit: Init;
  comparisonInit: Init;
}): ReactNode {
  if (projectId && defaultInit.state.status !== "idle") {
    return <ProjectClientInitNotice projectId={projectId} />;
  }
  const comparison = comparisonInit.state;
  if (comparison.status !== "failed" || comparison.refused) return null;
  return (
    <div role="alert" className="flex items-center gap-2 px-1 text-xs">
      <span className="text-muted-foreground">
        Could not set up the comparison clients. Try again.
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 shrink-0 rounded-xl px-2.5 text-xs"
        onClick={comparisonInit.retry}
      >
        <RotateCcw className="mr-1.5 size-3.5" aria-hidden />
        Retry
      </Button>
    </div>
  );
}
