import type { FormEvent } from "react";
import { ScoreSiteShell } from "./ScoreSiteShell";
import {
  scoreRunnerBusyLabel,
  scoreRunnerHeadline,
  scoreRunnerLead,
  type ScoreRunnerPhase,
} from "./score-runner-view-model";

/**
 * Where "Debug these failures in MCPJam" sends a visitor.
 *
 * A plain link, deliberately. Carrying the guest project across would need
 * the guest promotion proof, and that proof is a bearer credential that can
 * claim a guest's projects — putting it in a URL leaks it to history,
 * referrers and logs. Until a one-shot exchange exists, the honest CTA is
 * a link, not a parameter that promotes nothing.
 */
export const SCORE_DEBUG_HREF = "https://app.mcpjam.com/servers";

export type ScoreRunnerViewProps = {
  urlInput: string;
  onUrlChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
  emailInput: string;
  onEmailChange: (value: string) => void;
  onEmailSubmit: (event: FormEvent) => void;
  phase: ScoreRunnerPhase;
  error: string | null;
  busy: boolean;
  formDisabled: boolean;
  appReadyMessage: string | null;
  resultUrl: string | null;
  copied: boolean;
  onCopy: () => void;
  showAuthorize: boolean;
  onAuthorize: () => void;
  authorizeBusy: boolean;
};

function SubmitLabel({
  phase,
  busy,
}: {
  phase: ScoreRunnerPhase;
  busy: boolean;
}) {
  const busyLabel = scoreRunnerBusyLabel(phase);
  if (busy && busyLabel) return busyLabel;
  return "Score this server";
}

const FEATURED_SCORES = [
  ["https://mcp.linear.app/mcp", "71"],
  ["https://api.githubcopilot.com/mcp/", "84"],
  ["https://mcp.notion.com/mcp", "77"],
] as const;

function FeaturedScoreContents({
  server,
  score,
}: {
  server: string;
  score: string;
}) {
  return (
    <>
      <div className="min-w-0 grow truncate pr-3 font-[family-name:var(--font-score-mono)] text-base leading-[22px] text-[var(--score-fg)] group-hover:text-[var(--score-primary)]">
        {server}
      </div>
      <div className="shrink-0 font-[family-name:var(--font-score-mono)] text-lg font-semibold leading-6 text-[var(--score-primary)]">
        {score}
      </div>
      <div className="w-14 shrink-0 font-[family-name:var(--font-score-mono)] text-base leading-[22px] text-[var(--score-muted)]">
        / 100
      </div>
    </>
  );
}

function FeaturedScores({
  onSelect,
}: {
  onSelect?: (serverUrl: string) => void;
}) {
  return (
    <section className="score-featured flex w-full flex-col items-center pt-14 md:px-12">
      <h2 className="w-full max-w-[640px] text-[13px] font-semibold leading-[18px] tracking-[0.04em] text-[var(--score-fg)] min-[1360px]:w-[640px]">
        Featured scores
      </h2>
      <div className="flex w-full max-w-[640px] flex-col pt-2 min-[1360px]:w-[640px]">
        {FEATURED_SCORES.map(([server, score], index) => {
          const rowClassName = `${onSelect ? "group" : ""} flex h-14 shrink-0 items-center border-t border-[var(--score-border)] text-left ${
            index === FEATURED_SCORES.length - 1 ? "border-b" : ""
          }`;
          return onSelect ? (
            <button
              type="button"
              key={server}
              onClick={() => onSelect(server)}
              aria-label={`Use ${server}`}
              className={`${rowClassName} transition-colors hover:bg-[var(--score-surface)]`}
            >
              <FeaturedScoreContents server={server} score={score} />
            </button>
          ) : (
            <div key={server} className={rowClassName}>
              <FeaturedScoreContents server={server} score={score} />
            </div>
          );
        })}
      </div>
      <p className="w-full max-w-[640px] pt-3 text-[13px] leading-[18px] text-[var(--score-muted)] min-[1360px]:w-[640px]">
        These are real runs. Yours comes by email.
      </p>
    </section>
  );
}

export function ScoreRunnerView({
  urlInput,
  onUrlChange,
  onSubmit,
  emailInput,
  onEmailChange,
  onEmailSubmit,
  phase,
  error,
  busy,
  formDisabled,
  appReadyMessage,
  resultUrl,
  copied,
  onCopy,
  showAuthorize,
  onAuthorize,
  authorizeBusy,
}: ScoreRunnerViewProps) {
  const headline = scoreRunnerHeadline(phase);
  const lead = scoreRunnerLead(phase);
  const showUrlForm =
    phase !== "email" && phase !== "authorizing" && phase !== "done";
  const showEmailForm = phase === "email";
  const showFeatured = phase === "form" || phase === "email";

  return (
    <ScoreSiteShell
      compactPreview={phase === "authorizing" || phase === "done"}
      atmosphere={phase === "email" ? "email" : "landing"}
    >
      <div className="flex w-full flex-col items-start gap-6">
        <div className="flex w-full max-w-[720px] flex-col gap-5 pt-10 md:px-12 md:pt-20">
          <h1 className="max-w-[624px] font-[family-name:var(--font-score-display)] text-[clamp(2.5rem,5vw,3.5rem)] font-extrabold leading-[60px] tracking-[-0.04em] text-[var(--score-fg)]">
            {headline}
          </h1>
          <p className="max-w-[624px] text-lg leading-7 text-[var(--score-fg)]">
            {lead}
          </p>

          {showUrlForm && (
            <form
              onSubmit={onSubmit}
              className="flex w-full max-w-[624px] flex-col gap-2 pt-3 sm:flex-row"
            >
              <label className="sr-only" htmlFor="score-server-url">
                MCP server URL
              </label>
              <input
                id="score-server-url"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                value={urlInput}
                onChange={(event) => onUrlChange(event.target.value)}
                placeholder="https://mcp.acme.com/mcp"
                disabled={formDisabled}
                aria-invalid={Boolean(error) && !busy}
                aria-describedby={
                  error ? "score-runner-error" : "score-runner-hint"
                }
                className="h-12 min-w-0 shrink-0 rounded-sm border border-[var(--score-border)] bg-[var(--score-surface)] px-4 font-[family-name:var(--font-score-mono)] text-sm leading-5 text-[var(--score-fg)] placeholder:text-[var(--score-muted)] disabled:opacity-60 sm:flex-1"
              />
              <button
                type="submit"
                disabled={formDisabled}
                aria-busy={busy}
                className="h-12 shrink-0 rounded-sm bg-[var(--score-primary)] px-5 text-[15px] font-semibold text-[var(--score-primary-fg)] disabled:opacity-60"
              >
                <SubmitLabel phase={phase} busy={busy} />
              </button>
            </form>
          )}

          {showUrlForm && (
            <p
              id="score-runner-hint"
              className="text-[13px] leading-[18px] text-[var(--score-muted)]"
            >
              Public URL. No login. About 15 minutes.
            </p>
          )}

          {showEmailForm && (
            <form
              onSubmit={onEmailSubmit}
              noValidate
              className="flex w-full max-w-[624px] flex-col gap-2 pt-3 sm:flex-row"
            >
              <label className="sr-only" htmlFor="score-delivery-email">
                Scorecard email
              </label>
              <input
                id="score-delivery-email"
                type="email"
                inputMode="email"
                autoComplete="email"
                spellCheck={false}
                required
                maxLength={320}
                value={emailInput}
                onChange={(event) => onEmailChange(event.target.value)}
                placeholder="you@acme.com"
                disabled={formDisabled}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? "score-runner-error" : undefined}
                className="h-12 min-w-0 shrink-0 rounded-sm border border-[var(--score-border)] bg-[var(--score-surface)] px-4 font-[family-name:var(--font-score-mono)] text-sm leading-5 text-[var(--score-fg)] placeholder:text-[var(--score-muted)] disabled:opacity-60 sm:flex-1"
              />
              <button
                type="submit"
                disabled={formDisabled}
                className="h-12 shrink-0 rounded-sm bg-[var(--score-primary)] px-5 text-[15px] font-semibold text-[var(--score-primary-fg)] disabled:opacity-60"
              >
                Email the scorecard
              </button>
            </form>
          )}

          {appReadyMessage && (
            <p className="text-[13px] leading-[18px] text-[var(--score-muted)]">
              {appReadyMessage}
            </p>
          )}

          {showAuthorize && (
            <button
              type="button"
              onClick={onAuthorize}
              disabled={authorizeBusy}
              className="h-12 w-fit rounded-sm bg-[var(--score-primary)] px-5 text-[15px] font-semibold text-[var(--score-primary-fg)] disabled:opacity-60"
            >
              {authorizeBusy ? "Redirecting…" : "Authorize and continue"}
            </button>
          )}

          {phase === "done" && (
            <>
              {resultUrl && (
                <div className="flex w-full max-w-[624px] flex-col gap-2 sm:flex-row">
                  <label className="sr-only" htmlFor="score-result-url">
                    Private result link
                  </label>
                  <input
                    id="score-result-url"
                    readOnly
                    value={resultUrl}
                    className="h-12 min-w-0 shrink-0 truncate rounded-sm border border-[var(--score-border)] bg-[var(--score-surface)] px-4 font-[family-name:var(--font-score-mono)] text-sm text-[var(--score-muted)] sm:flex-1"
                  />
                  <button
                    type="button"
                    onClick={onCopy}
                    aria-label={
                      copied ? "Copied result link" : "Copy result link"
                    }
                    className="h-12 shrink-0 rounded-sm border border-[var(--score-border)] bg-[var(--score-surface)] px-5 text-[15px] font-semibold text-[var(--score-primary)]"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              )}
              <a
                href={SCORE_DEBUG_HREF}
                className="inline-flex h-12 w-fit items-center rounded-sm bg-[var(--score-primary)] px-5 text-[15px] font-semibold text-[var(--score-primary-fg)]"
              >
                Debug these failures in MCPJam
              </a>
            </>
          )}

          {error && (
            <div
              id="score-runner-error"
              role="alert"
              className="w-full max-w-[624px] rounded-sm border border-[#C45A3A]/40 bg-[#C45A3A]/10 px-3 py-2 text-[13px] leading-[18px] text-[#E8B4A8]"
            >
              {error}
            </div>
          )}

          {busy && (
            <p role="status" className="sr-only">
              {scoreRunnerBusyLabel(phase) ?? "Working"}
            </p>
          )}
        </div>

        {showFeatured && (
          <FeaturedScores
            onSelect={phase === "form" ? onUrlChange : undefined}
          />
        )}
      </div>
    </ScoreSiteShell>
  );
}
