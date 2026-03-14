import { useState, useCallback, useRef } from "react";
import type { TriageContext, OverviewTriageContext } from "./ai-insights";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AiTriageResult {
  summary: string;
  generatedAt: number;
}

export interface UseAiTriageReturn {
  result: AiTriageResult | null;
  loading: boolean;
  error: string | null;
  generate: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STORAGE_KEY = "mcp-inspector-provider-tokens";

function getOpenRouterApiKey(): string | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const tokens = JSON.parse(stored);
    return tokens.openrouter?.trim() || null;
  } catch {
    return null;
  }
}

function getOpenRouterModel(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return "anthropic/claude-sonnet-4";
    const tokens = JSON.parse(stored);
    const models = tokens.openRouterSelectedModels;
    if (Array.isArray(models) && models.length > 0) {
      return models[0];
    }
  } catch {
    // fall through
  }
  return "anthropic/claude-sonnet-4";
}

async function callOpenRouter(
  prompt: string,
  systemPrompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const apiKey = getOpenRouterApiKey();
  if (!apiKey) {
    throw new Error(
      "OpenRouter API key not configured. Add your key in Settings → LLM Providers.",
    );
  }

  const model = getOpenRouterModel();

  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://www.mcpjam.com/",
        "X-Title": "MCPJam Inspector",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 1024,
      }),
      signal,
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    if (response.status === 401) {
      throw new Error(
        "Invalid OpenRouter API key. Check your key in Settings → LLM Providers.",
      );
    }
    throw new Error(`OpenRouter request failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Empty response from OpenRouter");
  }
  return content;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert MCP server evaluation analyst. You analyze eval/test run results and provide concise, actionable triage summaries for engineering teams.

Your summaries should:
- Lead with the most important finding
- Identify regression patterns (was passing, now failing)
- Flag flaky tests (intermittent pass/fail)
- Note coverage gaps (suites not running)
- Be concise — 2-4 sentences max
- Use technical language appropriate for engineers
- Focus on what to fix and why, not just what failed`;

function buildCommitTriagePrompt(ctx: TriageContext): string {
  const failureDetails = ctx.failures
    .map((f) => {
      const tagStr = f.tags.length > 0 ? ` [${f.tags.join(", ")}]` : "";
      const testList =
        f.testNames.length > 0
          ? `\n    Tests: ${f.testNames.join(", ")}`
          : "";
      return `  - ${f.suiteName}${tagStr}: ${f.failedCases}/${f.totalCases} failed (${f.passRate}% pass rate)${testList}`;
    })
    .join("\n");

  const passedStr =
    ctx.passedSuites.length > 0
      ? `\nPassed suites (${ctx.passedSuites.length}): ${ctx.passedSuites.join(", ")}`
      : "";

  const notRunStr =
    ctx.notRunSuites.length > 0
      ? `\nNot run (${ctx.notRunSuites.length}): ${ctx.notRunSuites.join(", ")}`
      : "";

  return `Analyze this eval run and provide a triage summary:

Commit: ${ctx.commitSha}${ctx.branch ? ` (branch: ${ctx.branch})` : ""}
Total: ${ctx.totalSuites} suites, ${ctx.totalCases.total} cases (${ctx.totalCases.passed} passed, ${ctx.totalCases.failed} failed)

Failures (${ctx.failures.length}):
${failureDetails}
${passedStr}${notRunStr}

Provide a concise triage summary (2-4 sentences). Highlight regressions and flaky patterns. Suggest what to investigate first.`;
}

function buildOverviewTriagePrompt(ctx: OverviewTriageContext): string {
  const failureDetails = ctx.failingSuites
    .map((f) => {
      const tagStr = f.tags.length > 0 ? ` [${f.tags.join(", ")}]` : "";
      return `  - ${f.name}${tagStr}: ${f.failedCases} failures, ${f.passRate} pass rate`;
    })
    .join("\n");

  return `Analyze the current state of all eval suites and provide a brief summary:

Total suites: ${ctx.totalSuites}
Fully passing: ${ctx.passingSuites}
Suites with failed cases: ${ctx.failingSuites.length}
Never run: ${ctx.neverRunSuites}

Suites with failures:
${failureDetails}

Provide a concise overview summary (2-3 sentences). Focus on the most critical issues and patterns across all suites. Note that some suites may have an overall "passed" status due to pass rate thresholds while still having individual case failures.`;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Hook for generating AI triage for a commit detail view.
 * Caches results by commit SHA to avoid redundant calls.
 */
export function useCommitAiTriage(ctx: TriageContext | null): UseAiTriageReturn {
  const [result, setResult] = useState<AiTriageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastCtxRef = useRef<string | null>(null);

  const generate = useCallback(() => {
    if (!ctx) return;

    // Avoid re-generating for the same context
    const ctxKey = `${ctx.commitSha}-${ctx.failures.length}`;
    if (lastCtxRef.current === ctxKey && result) return;

    // Cancel any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    lastCtxRef.current = ctxKey;

    const prompt = buildCommitTriagePrompt(ctx);

    callOpenRouter(prompt, SYSTEM_PROMPT, controller.signal)
      .then((summary) => {
        if (!controller.signal.aborted) {
          setResult({ summary, generatedAt: Date.now() });
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
  }, [ctx, result]);

  return { result, loading, error, generate };
}

/**
 * Hook for generating AI triage for the overview panel.
 */
export function useOverviewAiTriage(
  ctx: OverviewTriageContext | null,
): UseAiTriageReturn {
  const [result, setResult] = useState<AiTriageResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastCtxRef = useRef<string | null>(null);

  const generate = useCallback(() => {
    if (!ctx) return;

    const ctxKey = `overview-${ctx.failingSuites.length}-${ctx.totalSuites}`;
    if (lastCtxRef.current === ctxKey && result) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);
    lastCtxRef.current = ctxKey;

    const prompt = buildOverviewTriagePrompt(ctx);

    callOpenRouter(prompt, SYSTEM_PROMPT, controller.signal)
      .then((summary) => {
        if (!controller.signal.aborted) {
          setResult({ summary, generatedAt: Date.now() });
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
  }, [ctx, result]);

  return { result, loading, error, generate };
}
