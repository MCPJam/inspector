import { useCallback } from "react";
import { HostedBrowserBody } from "@/components/browser/HostedBrowserBody";
import { useMintConversationBrowserToken } from "@/hooks/useProjectComputer";

/**
 * The hosted browser a sign-in route started, attached the way the
 * playground's pane attaches a chat's browser: by its session id. The person
 * signs in by taking it over, like any page that needs a person.
 */
export function WebSignInBrowser({
  projectId,
  browserSessionId,
}: {
  projectId: string;
  browserSessionId: string;
}) {
  const mint = useMintConversationBrowserToken();
  const mintToken = useCallback(
    ({ projectId: tokenProjectId }: { projectId: string }) =>
      mint({ projectId: tokenProjectId, conversationId: browserSessionId }),
    [mint, browserSessionId],
  );
  return (
    <HostedBrowserBody
      key={browserSessionId}
      projectId={projectId}
      sessionId={browserSessionId}
      mintToken={mintToken}
      allowProfileSave={false}
    />
  );
}
