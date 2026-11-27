import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  MCPJAM_EVENTS_EXTENSION_ID,
  readEventsHostSetting,
} from "@mcpjam/sdk/browser";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "@/lib/client-config-v2";
import { ClientEventsTab } from "../ClientEventsTab";

function draft(
  events: unknown,
  extra: Partial<HostConfigInputV2> = {},
): HostConfigInputV2 {
  return {
    ...emptyHostConfigInputV2(),
    hostStyle: "mcpjam",
    ...(events === undefined
      ? {}
      : {
          mcpProfile: {
            profileVersion: 1,
            extensions: { [MCPJAM_EVENTS_EXTENSION_ID]: events },
          },
        }),
    ...extra,
  };
}

function renderTab(
  value: HostConfigInputV2,
  opts: { hosted?: boolean; readOnly?: boolean } = {},
) {
  let current = value;
  const view = render(
    <ClientEventsTab
      draft={value}
      onDraftChange={(updater) => {
        current = updater(current);
      }}
      hosted={opts.hosted ?? false}
      readOnly={opts.readOnly}
    />,
  );
  return { ...view, saved: () => current };
}

const ALL = { poll: true, push: true, webhook: true };
const switchFor = (label: string) =>
  screen.getByRole("switch", { name: label });

describe("ClientEventsTab", () => {
  it("names each mode the way the spec does, with its method", () => {
    renderTab(draft(ALL));
    expect(switchFor("Poll (events/poll)")).toBeTruthy();
    expect(switchFor("Push (events/stream)")).toBeTruthy();
    expect(switchFor("Webhook (events/subscribe)")).toBeTruthy();
  });

  it("S1: an MCPJam client, local, receives every mode and the agent can subscribe", () => {
    renderTab(draft(ALL));
    const status = screen.getByTestId("client-events-status");
    expect(status.textContent).toContain(
      "Receives events by Poll, Push and Webhook.",
    );
    expect(status.textContent).toContain(
      "The agent can subscribe from chat, by Poll or Push.",
    );
    // The local webhook limit is explained under its row.
    expect(screen.getByText(/local webhook needs your consent/)).toBeTruthy();
  });

  it("S2: all modes off says so, and saves the change", () => {
    const { saved, unmount } = renderTab(draft(ALL));
    fireEvent.click(switchFor("Push (events/stream)"));
    expect(readEventsHostSetting(saved())).toEqual({
      kind: "valid",
      modes: ["poll", "webhook"],
    });
    unmount();
    const off = renderTab(draft({}));
    expect(off.getByTestId("client-events-status").textContent).toContain(
      "Receives no events. Turn on a delivery mode below.",
    );
  });

  it("S3: ChatGPT Work's webhook lets the hosted agent subscribe, but not the local one", () => {
    const work = draft({ webhook: true }, { hostStyle: "chatgpt-work" });
    const hosted = renderTab(work, { hosted: true });
    expect(hosted.getByTestId("client-events-status").textContent).toContain(
      "The agent can subscribe from chat, by Webhook.",
    );
    hosted.unmount();
    renderTab(work);
    expect(screen.getByTestId("client-events-status").textContent).toContain(
      "The agent can't subscribe from chat by Webhook here, because a local webhook needs your consent each time. Turn on Poll or Push",
    );
  });

  it("S4: a vendor harness shows none, read-only, naming the harness", () => {
    renderTab(draft(ALL, { harness: "codex" }), { hosted: true });
    expect(screen.getByTestId("client-events-harness").textContent).toContain(
      "Codex runs this client's agent loop",
    );
    expect(screen.getByTestId("client-events-status").textContent).toContain(
      "Pick another client in the Playground.",
    );
    for (const name of [
      "Poll (events/poll)",
      "Push (events/stream)",
      "Webhook (events/subscribe)",
    ]) {
      const toggle = switchFor(name);
      expect(toggle.getAttribute("aria-checked")).toBe("false");
      expect(toggle.hasAttribute("disabled")).toBe(true);
    }
  });

  it("S5: Push only, hosted, says Push needs MCPJam running locally", () => {
    renderTab(draft({ push: true }), { hosted: true });
    expect(screen.getByTestId("client-events-status").textContent).toContain(
      "hosted MCPJam can't deliver push yet",
    );
    expect(
      screen.getByText(/Push subscriptions need MCPJam running locally/),
    ).toBeTruthy();
  });

  it("S6: an unreadable setting receives nothing, and a toggle repairs it", () => {
    const { saved } = renderTab(draft({ sse: true }));
    expect(screen.getByTestId("client-events-status").textContent).toContain(
      "its saved setting can't be read",
    );
    fireEvent.click(switchFor("Poll (events/poll)"));
    expect(readEventsHostSetting(saved())).toEqual({
      kind: "valid",
      modes: ["poll"],
    });
  });

  it("S7: a viewer without edit rights can't change it", () => {
    renderTab(draft(ALL), { readOnly: true });
    expect(switchFor("Poll (events/poll)").hasAttribute("disabled")).toBe(true);
  });

  it("ignores the Apps style: nothing saved receives no events", () => {
    renderTab(draft(undefined));
    expect(screen.getByTestId("client-events-status").textContent).toContain(
      "Receives no events.",
    );
  });
});
