import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { useProjectClientInitStatus } from "@/hooks/use-project-client-initialization";

/**
 * Why an empty project has no client to pick yet, in place of the selector.
 * The Client tab stays disabled until a client exists; this says why.
 */
export function ProjectClientInitNotice({ projectId }: { projectId: string }) {
  const init = useProjectClientInitStatus(projectId, "default");
  if (!init || init.state.status === "idle") return null;
  const { state, retry } = init;

  if (state.status !== "failed") {
    return (
      <div
        role="status"
        className="flex h-8 items-center gap-1.5 px-1 text-xs text-muted-foreground"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        Preparing a client…
      </div>
    );
  }
  if (state.refused) {
    return (
      <p role="status" className="px-1 text-xs text-muted-foreground">
        {state.message}
      </p>
    );
  }
  return (
    <div role="alert" className="flex h-8 items-center gap-2 px-1 text-xs">
      <span className="text-muted-foreground">
        Could not prepare a client. Try again.
      </span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 rounded-xl px-2.5 text-xs"
        onClick={retry}
      >
        <RotateCcw className="mr-1.5 size-3.5" aria-hidden />
        Retry
      </Button>
    </div>
  );
}
