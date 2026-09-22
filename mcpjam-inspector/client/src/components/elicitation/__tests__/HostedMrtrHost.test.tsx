import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup, act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  HostedMrtrHost,
  __resetHostedMrtrHostElection,
} from "../HostedMrtrHost";
import {
  useHostedMrtrStore,
  type HostedMrtrRound,
} from "@/stores/hosted-mrtr-store";

function round(overrides: Partial<HostedMrtrRound> = {}): HostedMrtrRound {
  return {
    key: "cont-1:0",
    continuationId: "cont-1",
    round: 0,
    serverId: "srv-1",
    serverName: "GitHub",
    method: "tools/call",
    operationLabel: "create_issue",
    requests: [
      {
        key: "k1",
        mode: "form",
        message: "HOSTED_MRTR_PROMPT",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
      },
    ],
    expiresAt: Date.now() + 300_000,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function enqueue(
  value: HostedMrtrRound,
  submit: (responses: Record<string, unknown>) => void = () => {}
) {
  act(() => {
    useHostedMrtrStore.getState().enqueue(value, {
      submit: submit as never,
    });
  });
}

beforeEach(() => {
  __resetHostedMrtrHostElection();
  useHostedMrtrStore.getState().__reset();
});

afterEach(() => {
  cleanup();
  __resetHostedMrtrHostElection();
  useHostedMrtrStore.getState().__reset();
});

describe("HostedMrtrHost", () => {
  it("renders the reused elicitation dialog for a suspended round", () => {
    render(<HostedMrtrHost />);
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(0);

    enqueue(round());

    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(screen.getByText(/HOSTED_MRTR_PROMPT/)).toBeTruthy();
  });

  it("renders exactly one dialog when several hosts are co-mounted", () => {
    render(
      <>
        <HostedMrtrHost />
        <HostedMrtrHost />
        <HostedMrtrHost />
      </>
    );
    enqueue(round());

    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });

  it("renders the modern URL variant for a url-mode request", () => {
    render(<HostedMrtrHost />);
    enqueue(
      round({
        requests: [
          {
            key: "k1",
            mode: "url",
            message: "HOSTED_MRTR_URL_PROMPT",
            url: "https://example.com/authorize",
          },
        ],
      })
    );

    expect(screen.getByText(/HOSTED_MRTR_URL_PROMPT/)).toBeTruthy();
    // MCP MUST: the URL is shown as plain text, never as a clickable anchor.
    expect(document.body.querySelector("a[href]")).toBeNull();
  });

  it("submits the user's ElicitResult under the server's own key", async () => {
    const submit = vi.fn();
    render(<HostedMrtrHost />);
    enqueue(round(), submit);

    await userEvent.click(screen.getByRole("button", { name: /decline/i }));

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith({ k1: { action: "decline" } });
  });

  it("collects a multi-request round one key at a time before submitting", async () => {
    const submit = vi.fn();
    render(<HostedMrtrHost />);
    enqueue(
      round({
        requests: [
          { key: "k1", mode: "form", message: "FIRST_PROMPT" },
          { key: "k2", mode: "form", message: "SECOND_PROMPT" },
        ],
      }),
      submit
    );

    expect(screen.getByText(/FIRST_PROMPT/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /decline/i }));

    // One pending input at a time: the round is not submitted until every key
    // has an answer.
    await waitFor(() => expect(screen.getByText(/SECOND_PROMPT/)).toBeTruthy());
    expect(submit).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /decline/i }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith({
      k1: { action: "decline" },
      k2: { action: "decline" },
    });
  });

  it("closes when the continuation goes terminal server-side", () => {
    render(<HostedMrtrHost />);
    enqueue(round());
    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(1);

    act(() => {
      useHostedMrtrStore.getState().resolveContinuation("cont-1");
    });

    expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(0);
  });
});
