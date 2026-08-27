import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BenchQuote } from "@/lib/apis/bench-api";
import { BenchQuoteScreen } from "../BenchQuoteScreen";

function quote(overrides: Partial<BenchQuote> = {}): BenchQuote {
  return {
    quoteId: "q_1",
    definition: {
      profileId: "connector-bench",
      version: "v2",
      definitionHash: "abcdef0123456789abcdef",
      categorySlug: "crm",
    },
    estimate: { cellsMicros: 400_000, judgesMicros: 100_000 },
    quotedMaxMicros: 500_000,
    availableMicros: 2_000_000,
    payerKind: "org_credits",
    plan: { cases: 12, cells: 4, repetitions: 3, estimatedWallClockMs: 600_000 },
    ...overrides,
  };
}

function renderQuote(
  overrides: Partial<Parameters<typeof BenchQuoteScreen>[0]> = {},
) {
  const props = {
    quote: quote(),
    writeConsent: false,
    onWriteConsentChange: vi.fn(),
    onStart: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
  render(<BenchQuoteScreen {...props} />);
  return props;
}

function startButton() {
  return screen.getByText("Start the benchmark").closest("button");
}

describe("the exam's identity and size are on the screen", () => {
  it("names the definition, its version and its hash", () => {
    renderQuote();
    expect(screen.getByText(/connector-bench v2 · crm/)).toBeInTheDocument();
    expect(screen.getByText("abcdef0123456789")).toBeInTheDocument();
    expect(
      screen.getByText(
        /12 cases · 4 cells · 3 repetitions each · about 10 minutes/,
      ),
    ).toBeInTheDocument();
  });

  it("calls the estimate a ceiling rather than a bill", () => {
    renderQuote();
    expect(screen.getByText("$0.50")).toBeInTheDocument();
    expect(screen.getByText(/A ceiling, not a bill/)).toBeInTheDocument();
    expect(screen.getByText(/You have \$2\.00\./)).toBeInTheDocument();
  });

  it("warns only when the backend disclosed a balance that falls short", () => {
    renderQuote({ quote: quote({ availableMicros: 100_000 }) });
    expect(
      screen.getByText(/That is more than you have available/),
    ).toBeInTheDocument();
  });

  it("says nothing about a shortfall when the balance is undisclosed", () => {
    renderQuote({ quote: quote({ availableMicros: null }) });
    expect(
      screen.queryByText(/That is more than you have available/),
    ).not.toBeInTheDocument();
  });
});

describe("write operations need explicit consent", () => {
  it("previews each write and blocks the start until it is agreed to", async () => {
    const props = renderQuote({
      quote: quote({
        writeOperations: [
          {
            toolName: "create_page",
            summary: "creates a page and deletes it afterwards",
            artifactNamePrefix: "mcpjam-benchmark-run_1-0",
          },
        ],
      }),
    });

    expect(screen.getByText("create_page")).toBeInTheDocument();
    expect(
      screen.getByText(/creates a page and deletes it afterwards/),
    ).toBeInTheDocument();
    expect(startButton()).toBeDisabled();

    await userEvent.click(screen.getByRole("checkbox"));
    expect(props.onWriteConsentChange).toHaveBeenCalledWith(true);
  });

  it("starts once consent is given", () => {
    renderQuote({
      writeConsent: true,
      quote: quote({ writeOperations: [{ toolName: "create_page" }] }),
    });
    expect(startButton()).not.toBeDisabled();
  });

  it("states plainly when an exam only reads", () => {
    renderQuote();
    expect(screen.getByText(/This exam only reads/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(startButton()).not.toBeDisabled();
  });
});

describe("a guest is told the contribution is gone either way", () => {
  it("says non-refundable before the button, not after", () => {
    renderQuote({
      quote: quote({
        payerKind: "guest_subsidy",
        guest: { runsRemainingToday: 1, dailyRunLimit: 1 },
      }),
      onSignIn: vi.fn(),
    });

    expect(screen.getByText(/1 of 1 run left today/)).toBeInTheDocument();
    expect(screen.getByText("not refundable")).toBeInTheDocument();
    expect(
      screen.getByText(/cancelling, or a run that fails, does not give it back/i),
    ).toBeInTheDocument();
  });

  it("blocks the start and offers sign-in when today's run is spent", () => {
    renderQuote({
      quote: quote({
        payerKind: "guest_subsidy",
        guest: { runsRemainingToday: 0, dailyRunLimit: 1 },
      }),
      onSignIn: vi.fn(),
      onTopUp: vi.fn(),
    });

    expect(screen.getByText(/You have used today.s guest run/)).toBeInTheDocument();
    expect(startButton()).toBeDisabled();
    expect(screen.getByText("Sign in")).toBeInTheDocument();
    expect(screen.getByText("Add credits")).toBeInTheDocument();
  });
});

describe("a definition that moved is a new decision", () => {
  it("refuses to start and offers a re-quote instead of doing it silently", async () => {
    const onRequote = vi.fn();
    renderQuote({ definitionChanged: true, onRequote });

    expect(
      screen.getByText(/The exam changed while this quote was open/),
    ).toBeInTheDocument();
    expect(startButton()).toBeDisabled();

    await userEvent.click(screen.getByText("Price it again"));
    expect(onRequote).toHaveBeenCalledTimes(1);
  });
});
