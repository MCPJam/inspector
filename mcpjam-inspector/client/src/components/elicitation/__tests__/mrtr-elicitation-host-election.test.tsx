import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import {
  MrtrElicitationHost,
  __resetMrtrHostElection,
} from "../MrtrElicitationHost";
import { useMrtrElicitationStore } from "@/stores/mrtr-elicitation-store";

/**
 * PR7 (§12.6) — the reused elicitation dialog is now mounted on the chat
 * `Thread` (so it overlays an MCP App whose App-initiated tool call returned
 * `input_required`) IN ADDITION to PR2's per-tab mounts. Multiple hosts can be
 * co-visible; the module-level election must render exactly ONE dialog for a
 * round so co-mounted hosts never stack duplicates.
 */

const FORM_ROUND = {
  type: "mrtr_input_request",
  opId: "op-1",
  roundKey: "op-1:0",
  round: 0,
  serverId: "srv",
  requests: [
    {
      key: "k1",
      mode: "form",
      message: "MRTR_ELECTION_PROMPT",
      requestedSchema: {
        type: "object",
        properties: { name: { type: "string" } },
      },
    },
  ],
  timestamp: new Date().toISOString(),
};

beforeEach(() => {
  __resetMrtrHostElection();
  useMrtrElicitationStore.getState().__reset();
});

afterEach(() => {
  cleanup();
  __resetMrtrHostElection();
  useMrtrElicitationStore.getState().__reset();
});

function ingest(event: unknown) {
  act(() => {
    useMrtrElicitationStore.getState().__ingest(event);
  });
}

describe("MrtrElicitationHost — single-active-dialog election", () => {
  it("renders exactly one dialog when a single host is mounted", () => {
    render(<MrtrElicitationHost />);
    ingest(FORM_ROUND);
    expect(
      document.body.querySelectorAll('[role="dialog"]').length,
    ).toBe(1);
  });

  it("renders exactly one dialog when THREE hosts are co-mounted", () => {
    render(
      <>
        <MrtrElicitationHost />
        <MrtrElicitationHost />
        <MrtrElicitationHost />
      </>,
    );
    ingest(FORM_ROUND);

    // Three hosts share one round; the election collapses them to one dialog.
    expect(
      document.body.querySelectorAll('[role="dialog"]').length,
    ).toBe(1);
    // The leaf element carrying the prompt text renders exactly once — no
    // stacked duplicate dialog bodies.
    const leaves = Array.from(document.body.querySelectorAll("*")).filter(
      (el) => el.textContent === "MRTR_ELECTION_PROMPT" && el.children.length === 0,
    );
    expect(leaves.length).toBe(1);
  });

  it("promotes a survivor when the primary host unmounts", () => {
    // Two independent renders so we can unmount one without the other.
    const first = render(<MrtrElicitationHost />);
    render(<MrtrElicitationHost />);
    ingest(FORM_ROUND);
    expect(document.body.querySelectorAll('[role="dialog"]').length).toBe(1);

    // Unmount the (elected primary) first host — the survivor takes over and
    // still shows exactly one dialog.
    act(() => {
      first.unmount();
    });
    expect(document.body.querySelectorAll('[role="dialog"]').length).toBe(1);
  });

  it("shows no dialog when there is no active round", () => {
    render(
      <>
        <MrtrElicitationHost />
        <MrtrElicitationHost />
      </>,
    );
    expect(document.body.querySelectorAll('[role="dialog"]').length).toBe(0);
  });
});
