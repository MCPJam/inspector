import type {
  HostedElicitationAction,
  HostedElicitationRequestEvent,
  HostedElicitationUrlRequiredEvent,
} from "@/shared/hosted-elicitation";
import { ElicitationDialog } from "../ElicitationDialog";
import { UrlElicitationConsent } from "./UrlElicitationConsent";

/**
 * A tool call failed with `-32042`: the server needs an out-of-band interaction
 * finished before it can serve the request.
 *
 * Advisory — the call already failed, so nothing is waiting on an answer and
 * there is no rendezvous. The user opens the URL, then retries (the tool result
 * carries a retry hint for the model, and they can also just ask again).
 *
 * Renders the same consent surface as a live URL elicitation so the safety rules
 * (full URL shown, no prefetch, domain emphasis, punycode warnings) hold on this
 * path too — a URL is no safer for having arrived via an error.
 */
export function UrlElicitationRequiredDialog({
  event,
  onDismiss,
}: {
  event: HostedElicitationUrlRequiredEvent | null;
  onDismiss: (toolCallId?: string) => void;
}) {
  const first = event?.elicitations[0];
  if (!event || !first) return null;

  return (
    <UrlElicitationConsent
      advisory
      request={{
        rendezvousId: first.elicitationId,
        serverId: event.serverId,
        serverName: event.serverName,
        message:
          first.message ??
          "This tool needs you to finish something at the link below before it can run.",
        url: first.url,
      }}
      onResponse={() => onDismiss(event.toolCallId)}
    />
  );
}

/**
 * Renders whichever elicitation UI the request's mode calls for.
 *
 * The two modes are genuinely different interactions, not styling variants:
 * form mode collects data the client may read, URL mode gets consent to send
 * the user somewhere the client must NOT observe. Keeping the split here means
 * neither component has to know the other exists.
 *
 * Chat surfaces render this; ToolsTab/TasksTab keep using `ElicitationDialog`
 * directly, since local payloads carry no mode.
 */
export function ElicitationRequestDialog({
  request,
  onRespond,
  loading,
}: {
  request: HostedElicitationRequestEvent | null;
  onRespond: (answer: {
    rendezvousId: string;
    action: HostedElicitationAction;
    content?: Record<string, unknown>;
  }) => void | Promise<void>;
  loading?: boolean;
}) {
  if (!request) return null;

  if (request.mode === "url") {
    return (
      <UrlElicitationConsent
        request={{
          rendezvousId: request.rendezvousId,
          serverId: request.serverId,
          serverName: request.serverName,
          message: request.message,
          url: request.url,
        }}
        onResponse={(action) =>
          onRespond({ rendezvousId: request.rendezvousId, action })
        }
        loading={loading}
      />
    );
  }

  return (
    <ElicitationDialog
      elicitationRequest={{
        // The dialog keys off requestId; the rendezvousId is what the answer
        // travels on, so it's the identity that matters here.
        requestId: request.rendezvousId,
        message: request.message,
        schema: request.requestedSchema as Record<string, unknown> | undefined,
        timestamp: new Date(request.expiresAt).toISOString(),
        serverId: request.serverId,
        serverName: request.serverName,
      }}
      onResponse={async (action, parameters) =>
        onRespond({
          rendezvousId: request.rendezvousId,
          action: action as HostedElicitationAction,
          // Content rides accepts only; the backend rejects it otherwise.
          ...(action === "accept" && parameters ? { content: parameters } : {}),
        })
      }
      loading={loading}
    />
  );
}
