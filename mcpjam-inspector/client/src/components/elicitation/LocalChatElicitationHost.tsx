import { toast } from "sonner";
import { HOSTED_MODE } from "@/lib/config";
import { useChatElicitation } from "@/hooks/use-task-elicitation";
import { ElicitationDialog } from "../ElicitationDialog";

/**
 * Shows a question a server asks during a local chat that runs on the
 * process-wide manager (local chat without a project), and sends the answer
 * back.
 *
 * That manager advertises elicitation because its global callback is
 * registered at startup (`server/app.ts`), so a server may ask mid-turn and
 * wait. Its questions arrive on `/api/mcp/elicitation/stream`, where only the
 * Tasks tab listened, for task questions alone, so a chat question waited on a
 * dialog that never appeared. Hosted chat and project chats ask through their
 * turn's own bridge and never come through here, so mounting this beside them
 * shows nothing twice.
 *
 * The local bridge is form-only (URL mode is refused before it reaches the
 * stream), so this is the plain form dialog, labeled as a question the server
 * asked mid-call.
 */
export function LocalChatElicitationHost() {
  const { elicitation, isResponding, respond, clear } = useChatElicitation(
    !HOSTED_MODE,
  );

  if (!elicitation) return null;

  return (
    <ElicitationDialog
      key={elicitation.requestId}
      elicitationRequest={{
        requestId: elicitation.requestId,
        message: elicitation.message,
        schema: elicitation.schema as Record<string, unknown> | undefined,
        timestamp: elicitation.timestamp,
        origin: "legacy-request",
        ...(elicitation.serverId ? { serverId: elicitation.serverId } : {}),
      }}
      loading={isResponding}
      onResponse={async (action, parameters) => {
        try {
          await respond(action, parameters);
        } catch {
          // The question is usually gone server-side (answered, timed out, or
          // its server disconnected), so keeping the dialog would only take
          // more answers that go nowhere.
          // By id: a completion that landed while this answer was in flight
          // may already have moved another question to the head.
          clear(elicitation.requestId);
          toast.error(
            `Couldn't send your answer${elicitation.serverId ? ` to ${elicitation.serverId}` : ""}. Send your message again to retry.`,
          );
        }
      }}
    />
  );
}
