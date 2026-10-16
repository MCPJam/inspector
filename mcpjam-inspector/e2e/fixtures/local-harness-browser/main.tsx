import React from "react";
import { createRoot } from "react-dom/client";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  isToolUIPart,
} from "ai";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { TooltipProvider } from "@mcpjam/design-system/tooltip";
import { PreferencesStoreProvider } from "@app/client/src/stores/preferences/preferences-provider";
import { ToolPart } from "@app/client/src/components/chat-v2/thread/parts/tool-part";
import {
  transcriptToUIMessages,
  type PendingHarnessApproval,
} from "@app/client/src/lib/transcript-to-ui-messages";
import "@app/client/src/index.css";
const transport = new DefaultChatTransport({ api: "/api/chat" });
async function history() {
  const response = await fetch("/api/history");
  const data: {
    transcript: ModelMessage[];
    pending: PendingHarnessApproval[];
  } = await response.json();
  return transcriptToUIMessages(data.transcript, data.pending);
}
function App({ initial }: { initial: Awaited<ReturnType<typeof history>> }) {
  const chat = useChat({
    transport,
    messages: initial,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  });
  return (
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <TooltipProvider>
        <main className="min-h-screen bg-background text-foreground p-12">
          <div className="mx-auto max-w-2xl space-y-6">
            <h1 className="text-2xl font-semibold">
              Local harness approval regression
            </h1>
            <p>
              Isolated fixture: actual runner and transport, simulated runtime
              process.
            </p>
            <button
              onClick={() =>
                void chat.sendMessage({ text: "Run the requested commands" })
              }
            >
              Send
            </button>
            <button
              onClick={async () => {
                await fetch("/api/stop", { method: "POST" });
                chat.setMessages(await history());
              }}
            >
              Stop
            </button>
            <p role="status">{chat.status}</p>
            {chat.error && <p role="alert">{chat.error.message}</p>}
            {chat.messages.flatMap((message) =>
              message.parts
                .filter(isToolUIPart)
                .map((part) => (
                  <ToolPart
                    key={part.toolCallId}
                    part={part}
                    approvalId={
                      part.state === "approval-requested"
                        ? part.approval.id
                        : undefined
                    }
                    onApprove={(id) =>
                      void chat.addToolApprovalResponse({ id, approved: true })
                    }
                    onDeny={(id) =>
                      void chat.addToolApprovalResponse({ id, approved: false })
                    }
                  />
                )),
            )}
          </div>
        </main>
      </TooltipProvider>
    </PreferencesStoreProvider>
  );
}
history()
  .then((initial) =>
    createRoot(document.getElementById("root")!).render(
      <App initial={initial} />,
    ),
  )
  .catch((error) => {
    document.getElementById("root")!.textContent = String(error);
  });
