// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { record } from "posthog-js/dist/rrweb";
import { InfoLogEntry } from "@/components/oauth/InfoLogEntry";
import { HTTPHistoryEntry } from "@/components/oauth/HTTPHistoryEntry";
import { TokenValue } from "@/components/connection/shared/TokenValue";
import { UserMessageBubble } from "@/components/chat-v2/thread/user-message-bubble";
import { TextPart } from "@/components/chat-v2/thread/parts/text-part";
import { ToolPart } from "@/components/chat-v2/thread/parts/tool-part";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { SESSION_RECORDING_OPTIONS } from "../session-privacy/posthog-replay";

const ACCESS_TOKEN = "at_SNTLq7Zxaccess";
const REFRESH_TOKEN = "rt_SNTLq7Zxrefresh";
const CLIENT_SECRET = "cs_SNTLq7Zxsecret";
const PASTED_KEY = "sk_SNTLq7Zxpasted";
const MODEL_TOKEN = "md_SNTLq7Zxreply";
const TOOL_TOKEN = "tl_SNTLq7Zxresult";

function recordedSnapshot(): string {
  const events: Array<{ type: number }> = [];
  const stop = record({
    ...SESSION_RECORDING_OPTIONS,
    emit: (event) => {
      events.push(event as { type: number });
    },
  });
  stop?.();
  return JSON.stringify(events.filter((event) => event.type === 2));
}

afterEach(() => cleanup());

describe("full replay of the OAuth debugger's secret views", () => {
  it("masks tokens in logs, HTTP history and token rows, and keeps interface prose", () => {
    render(
      <div>
        <h2>Authorization flow steps</h2>
        <InfoLogEntry
          label="OAuth Tokens"
          timestamp={0}
          defaultOpen
          data={{ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN }}
        />
        <HTTPHistoryEntry
          method="POST"
          url="https://auth.example.com/token"
          status={200}
          defaultOpen
          requestHeaders={{ Authorization: `Bearer ${ACCESS_TOKEN}` }}
          requestBody={{ client_secret: CLIENT_SECRET }}
          responseBody={{ access_token: ACCESS_TOKEN }}
        />
        <TokenValue label="Access Token" value={ACCESS_TOKEN} />
        <span className="font-mono">{REFRESH_TOKEN}</span>
      </div>,
    );

    // Autocapture skips only the class, so every annotation carries both.
    for (const surface of document.querySelectorAll("[data-ph-no-capture]")) {
      expect(surface.classList.contains("ph-no-capture")).toBe(true);
    }
    const snapshot = recordedSnapshot();
    expect(snapshot).toContain("Authorization flow steps");
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET]) {
      expect(snapshot).not.toContain(secret);
    }
  });
});

describe("full replay of a chat", () => {
  it("masks user messages, model replies and tool results, and keeps the chrome", () => {
    render(
      <PreferencesStoreProvider themeMode="light" themePreset="default">
        <h2>Playground chat</h2>
        <UserMessageBubble>
          <TextPart
            role="user"
            text={`Please check my key ${PASTED_KEY} before lunch`}
          />
        </UserMessageBubble>
        <TextPart
          role="assistant"
          text={`Your account balance note reads ${MODEL_TOKEN} today`}
        />
        <ToolPart
          part={
            {
              type: "tool-lookup_customer",
              toolCallId: "call-1",
              state: "output-available",
              input: {},
              output: {},
              traceDisplayText: `Customer Jane Roe lives at ${TOOL_TOKEN} street`,
            } as never
          }
        />
      </PreferencesStoreProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /lookup_customer/i }));
    expect(screen.getByText(/Jane Roe/)).toBeInTheDocument();

    const snapshot = recordedSnapshot();
    expect(snapshot).toContain("Playground chat");
    // The tool name renders in monospace, which `full` already masks.
    expect(snapshot).toContain("Result");
    for (const content of [
      PASTED_KEY,
      "before lunch",
      MODEL_TOKEN,
      "balance note",
      TOOL_TOKEN,
      "Jane Roe",
    ]) {
      expect(snapshot).not.toContain(content);
    }
  });
});
