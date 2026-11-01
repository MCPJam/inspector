import { useRef } from "react";
import type { TaskInputPrompt } from "@/lib/task-input-prompt";
import { ElicitationDialog } from "../ElicitationDialog";
import { UrlElicitationConsent } from "../elicitation/UrlElicitationConsent";

/** Task answers share the ordinary host's form and URL-consent surfaces. */
export function TaskInputDialog({
  prompt,
  serverId,
  serverName,
  timestamp,
  onResponse,
  loading,
}: {
  prompt: TaskInputPrompt;
  serverId: string;
  serverName?: string;
  timestamp: string;
  onResponse: (
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ) => Promise<boolean>;
  loading: boolean;
}) {
  const inFlight = useRef(false);
  const respond = async (
    action: "accept" | "decline" | "cancel",
    content?: Record<string, unknown>,
  ) => {
    if (inFlight.current) return;
    inFlight.current = true;
    let acknowledged = false;
    try {
      acknowledged = await onResponse(action, content);
    } finally {
      // A successful key stays closed until its keyed component unmounts.
      if (!acknowledged) inFlight.current = false;
    }
  };
  if (prompt.mode === "url")
    return (
      <UrlElicitationConsent
        request={{
          rendezvousId: prompt.key,
          serverId,
          serverName,
          message: prompt.message,
          url: prompt.url,
        }}
        onResponse={respond}
        loading={loading}
      />
    );
  return (
    <ElicitationDialog
      elicitationRequest={{
        requestId: prompt.key,
        serverId,
        serverName,
        message: prompt.message,
        schema: prompt.schema,
        timestamp,
        origin: "mrtr",
      }}
      onResponse={respond}
      loading={loading}
    />
  );
}
