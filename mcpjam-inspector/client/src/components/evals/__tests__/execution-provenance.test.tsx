import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PlatformDisclosedModel } from "@mcpjam/sdk/platform";

import { ExecutionProvenance } from "../execution-provenance";
import { describeRecordedExecution } from "../run-disclosure-hint";

/**
 * CONTRACT: a result shows what it actually ran on, and a deviation from the
 * request is VISIBLE, not tucked behind a disclosure. A row recorded before
 * execution records existed shows nothing (or "not recorded") — never a line
 * guessed from the case's model id. Sits next to the run-disclosure tooltip
 * tests because both answer "where did this model call go".
 */

afterEach(() => {
  cleanup();
});

function record(overrides: Record<string, unknown> = {}) {
  return {
    requested: {
      modelId: "anthropic/claude-sonnet-4.5",
      source: "hosted",
      fallback: { provider: "openrouter", model: "none" },
    },
    resolved: {
      rail: "gateway",
      wireModelId: "anthropic/claude-sonnet-4.5",
      offering: { rail: "gateway", providerKey: "gateway" },
    },
    harness: { id: "claude-code", runtimeVersion: "2.1.3" },
    effectiveSettings: { reasoningEffort: "high", maxOutputTokens: 0 },
    attempts: [
      {
        rail: "gateway",
        wireModelId: "anthropic/claude-sonnet-4.5",
        outcome: "error",
        code: "provider_error",
        at: 1,
      },
      {
        rail: "openrouter",
        wireModelId: "anthropic/claude-sonnet-4.5",
        outcome: "ok",
        at: 2,
      },
    ],
    ...overrides,
  };
}

describe("ExecutionProvenance", () => {
  it("renders nothing for a row recorded before execution records existed", () => {
    const { container } = render(<ExecutionProvenance execution={undefined} />);
    expect(container.innerHTML).toBe("");
  });

  it('says "not recorded" when asked, rather than guessing', () => {
    render(<ExecutionProvenance execution={{ bogus: true }} showNotRecorded />);
    expect(
      screen.getByTestId("execution-provenance-not-recorded").textContent,
    ).toBe("Model provenance not recorded");
    expect(screen.queryByTestId("execution-provenance-line")).toBeNull();
  });

  it("shows the ran-on line with harness, effort and the provider default", () => {
    render(<ExecutionProvenance execution={record()} />);
    const line = screen.getByTestId("execution-provenance-line").textContent;
    expect(line).toBe(
      "Ran on anthropic/claude-sonnet-4.5 via Vercel AI Gateway (MCPJam key), claude-code v2.1.3, effort high, max output provider default",
    );
    expect(line).not.toMatch(/\b0 tokens\b/);
    expect(screen.queryByTestId("execution-deviation-banner")).toBeNull();
    const details = screen.getByTestId(
      "execution-provenance-details",
    ).textContent;
    expect(details).toContain(
      "Requested anthropic/claude-sonnet-4.5 (MCPJam-hosted, OpenRouter fallback permitted)",
    );
    expect(details).toContain(
      "Attempt 1: Vercel AI Gateway · anthropic/claude-sonnet-4.5 · failed (provider_error)",
    );
  });

  it("shows a visible deviation banner when the record carries one", () => {
    render(
      <ExecutionProvenance
        execution={record({
          deviation: {
            kind: "provider_fallback",
            reason:
              "The gateway attempt failed (provider_error); the openrouter fallback served the request.",
          },
        })}
        testIdPrefix="iteration-execution"
      />,
    );
    const banner = screen.getByTestId("iteration-execution-deviation-banner");
    expect(banner.getAttribute("role")).toBe("status");
    expect(banner.textContent).toBe(
      "Deviation: Provider fallback: The gateway attempt failed (provider_error); the openrouter fallback served the request.",
    );
  });

  it("marks a legacy request's source as inferred", () => {
    render(
      <ExecutionProvenance
        execution={record({
          requested: {
            source: "legacy",
            modelId: "anthropic/claude-sonnet-4.5",
          },
        })}
      />,
    );
    expect(
      screen.getByTestId("execution-provenance-details").textContent,
    ).toContain("saved without a source; inferred at run time");
  });

  it("never renders a connection id or a stray secret field", () => {
    const { container } = render(
      <ExecutionProvenance
        execution={{
          ...record(),
          apiKey: "sk-live-secret",
          resolved: {
            rail: "orgCloud",
            wireModelId: "gpt-5",
            connectionRef: { kind: "orgProvider", id: "k17rowid" },
            offering: {
              rail: "orgCloud",
              providerKey: "azure",
              connectionLabel: "Prod Azure",
              apiKey: "sk-live-secret",
            },
          },
        }}
      />,
    );
    expect(
      screen.getByTestId("execution-provenance-line").textContent,
    ).toContain('via org connection "Prod Azure" (azure)');
    expect(container.textContent).not.toContain("sk-live");
    expect(container.textContent).not.toContain("k17rowid");
  });
});

describe("describeRecordedExecution (run disclosure tooltip)", () => {
  function model(
    overrides: Partial<PlatformDisclosedModel>,
  ): Pick<PlatformDisclosedModel, "provenance" | "recorded"> {
    return { ...overrides };
  }

  it("prints nothing for a disclosure read off the current config", () => {
    expect(
      describeRecordedExecution(
        model({ provenance: "inferred-from-current-config" }),
      ),
    ).toBeNull();
    // An older backend sends neither field.
    expect(describeRecordedExecution(model({}))).toBeNull();
  });

  it("names the recorded rails, fallback attempts and deviations", () => {
    expect(
      describeRecordedExecution(
        model({
          provenance: "execution-record",
          recorded: {
            records: 3,
            resolvedRails: ["gateway"],
            attemptedRails: ["gateway", "openrouter"],
            providerKeys: ["gateway"],
            deviations: ["provider_fallback"],
          },
        }),
      ),
    ).toBe(
      "Recorded (3 records): ran via Vercel AI Gateway; also attempted OpenRouter; deviations: Provider fallback",
    );
  });
});
