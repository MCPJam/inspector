import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { FlaskConical } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { EvalRunner } from "./evals/eval-runner";
import { useChat } from "@/hooks/use-chat";

export function EvalsRunTab() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { user } = useAuth();

  const { availableModels } = useChat({
    systemPrompt: "",
    temperature: 1,
    selectedServers: [],
  });

  if (isLoading) {
    return (
      <div className="p-6">
        <div className="flex h-64 items-center justify-center">
          <div className="text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
            <p className="mt-4 text-muted-foreground">Loading...</p>
          </div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <div className="p-6">
        <EmptyState
          icon={FlaskConical}
          title="Sign in to run evals"
          description="Create an account or sign in to generate and launch evaluation runs."
          className="h-[calc(100vh-200px)]"
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Evaluation runner</h1>
      </div>
      <div className="max-w-4xl">
        <EvalRunner availableModels={availableModels} inline={true} />
      </div>
    </div>
  );
}
