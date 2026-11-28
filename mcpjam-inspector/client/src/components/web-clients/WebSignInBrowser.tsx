import { useCallback } from "react";
import { HostedBrowserBody } from "@/components/browser/HostedBrowserBody";
import { useMintConversationBrowserToken } from "@/hooks/useProjectComputer";

/**
 * The hosted browser a sign-in route started, attached the way the
 * playground's pane attaches a chat's browser: by the chat it belongs to,
 * which the browser token names. The person signs in by taking it over,
 * like any page that needs a person.
 */
export function WebSignInBrowser({
  projectId,
  chatSessionId,
}: {
  projectId: string;
  /** The chat the sign-in browser belongs to. */
  chatSessionId: string;
}) {
  const mint = useMintConversationBrowserToken();
  const mintToken = useCallback(
    ({ projectId: tokenProjectId }: { projectId: string }) =>
      mint({ projectId: tokenProjectId, conversationId: chatSessionId }),
    [mint, chatSessionId],
  );
  return (
    <HostedBrowserBody
      key={chatSessionId}
      projectId={projectId}
      sessionId={chatSessionId}
      mintToken={mintToken}
      allowProfileSave={false}
    />
  );
}
