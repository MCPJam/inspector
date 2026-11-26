// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { record } from "posthog-js/dist/rrweb";
import { InfoLogEntry } from "@/components/oauth/InfoLogEntry";
import { HTTPHistoryEntry } from "@/components/oauth/HTTPHistoryEntry";
import { TokenValue } from "@/components/connection/shared/TokenValue";
import { SESSION_RECORDING_OPTIONS } from "../session-privacy/posthog-replay";

const ACCESS_TOKEN = "at_SNTLq7Zxaccess";
const REFRESH_TOKEN = "rt_SNTLq7Zxrefresh";
const CLIENT_SECRET = "cs_SNTLq7Zxsecret";

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

    const snapshot = recordedSnapshot();
    expect(snapshot).toContain("Authorization flow steps");
    for (const secret of [ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET]) {
      expect(snapshot).not.toContain(secret);
    }
  });
});
