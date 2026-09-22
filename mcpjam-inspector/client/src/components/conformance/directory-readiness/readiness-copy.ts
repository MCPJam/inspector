/**
 * The engine's vocabulary, translated for the person reading it.
 *
 * A lane's `missingInputs` are machine tokens — `authorizationRequests`,
 * `intrusive`, `submissionProfile` — named for the runner option that would
 * close the gap. Printing them raw produced sentences like "Supply
 * authorizationRequests, intrusive to close this gap", which reads as a bug
 * to anyone who has not read the SDK. The token IS the right wire format;
 * this map is the right screen format, and each entry says what to actually
 * DO, because "supply X" is only an instruction if you know where X comes
 * from.
 *
 * Unknown tokens fall back to themselves rather than being hidden: a token
 * this build does not know is a gap the reader still deserves to see, and a
 * raw name is a better clue than silence.
 */

const INPUT_GUIDANCE: Record<string, string> = {
  authorizationRequests:
    "Complete an OAuth authorization against this server — the OAuth suite above drives one — so the auth checks can observe a real flow.",
  intrusive:
    "Intrusive probes (dynamic client registration, refresh rotation) mutate the target, so they only run from the CLI on a server you own: `mcpjam readiness check claude <url> --intrusive-dcr --intrusive-refresh`.",
  submissionProfile:
    "Describe the directory listing itself (name, description, test accounts, attestations) with a submission profile — gradeable today via the CLI's `--submission-profile <file>`.",
  toolListing:
    "This run could not read the server's tool listing, so every check over the tools reports a gap rather than a guess.",
  appsResult:
    "Widget evidence was unavailable — the apps dial did not complete on this run.",
  pluginBundle:
    "The plugin package is bytes on your machine, so it grades locally: `mcpjam readiness check openai --submission-mode <mode> --package <dir|zip>`.",
  importedSkills:
    "This run could not read the server's skills listing (`skills/list`).",
  draftSnapshot:
    "Comparing against the published version needs a draft snapshot this run did not have.",
  publishedSnapshot:
    "Comparing against the published version needs its snapshot — first submissions have none, and this lane will not apply.",
  serverUrl: "This submission shape grades an MCP server; none was supplied.",
};

/** One actionable sentence per missing input, in the run's own order. */
export function describeMissingInputs(tokens: readonly string[]): string[] {
  return tokens.map((token) => INPUT_GUIDANCE[token] ?? `Supply ${token}.`);
}

/**
 * What a finding's class costs the submitter, in five words or fewer.
 *
 * Shown as a chip on every non-passing row because the class is what decides
 * whether a finding moved the verdict — a `heuristic` and a `runtime-blocker`
 * can both read "violated" and mean completely different things, and a reader
 * who cannot tell them apart will fix the wrong one first.
 */
export const CLASS_LABEL: Record<string, string> = {
  "runtime-blocker": "Blocks runtime",
  required: "Required",
  recommended: "Recommended",
  "manual-review": "Human review",
  heuristic: "Advice",
};

/** Render order inside a lane: what the submitter must act on first. */
export const FINDING_STATUS_ORDER: Record<string, number> = {
  violated: 0,
  "not-evaluated": 1,
  informational: 2,
  satisfied: 3,
  "not-applicable": 4,
};

/**
 * Whether an unauthenticated run hit a server that wants OAuth.
 *
 * Two facts have to agree before the banner shows. `authMode: "headless"`
 * says this run carried no token — a fact about US. A satisfied
 * `*.unauthenticated-challenge` finding (or an `authorizationRequests` gap)
 * says the server answered 401 with a proper challenge — a fact about THEM,
 * and a point in their favour, since challenging correctly is what the rules
 * require. Only together do they mean "connect and re-run closes these gaps";
 * either alone could be a token that expired mid-run or a server with no auth
 * at all.
 */
export function detectAuthWall(report: {
  context?: { authMode?: string };
  lanes?: Array<{ coverage: { missingInputs: string[] } }>;
  findings?: Array<{ id: string; status: string; details?: unknown }>;
}): { waiting: number } | null {
  if (report.context?.authMode !== "headless") return null;

  const challenged = (report.findings ?? []).some(
    (finding) =>
      finding.id.includes("unauthenticated-challenge") &&
      finding.status === "satisfied",
  );
  const authGap = (report.lanes ?? []).some((lane) =>
    lane.coverage.missingInputs.includes("authorizationRequests"),
  );
  if (!challenged && !authGap) return null;

  const waiting = (report.findings ?? []).filter(
    (finding) => finding.status === "not-evaluated",
  ).length;
  return { waiting };
}
