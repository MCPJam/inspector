/**
 * Candidates for the decision questions: text a cheap rule picks out of what
 * a model reads for the decision model to judge. A rule only proposes; telling
 * a direction from a fact is the model's question. Each question's candidates
 * come best first, so a run that cannot ask them all asks the likeliest
 * violations. Pure. Safe from the browser entry.
 */

import {
  findToolDirectionCandidates,
  sentences,
  textFields,
  type ToolTextEvidence,
} from "../tool-directions.js";
import {
  DIRECTORY_DECISION_LIMITS as LIMITS,
  DIRECTORY_DECISION_QUESTIONS,
  decisionHints,
  type DirectoryDecisionCandidate,
  type DirectoryDecisionDirectory,
  type DirectoryDecisionItem,
  type DirectoryDecisionQuestionId,
} from "./catalog.js";

/** A tool as a model reads it. Shape-compatible with MCP's `Tool`. */
export interface DirectoryDecisionTool extends ToolTextEvidence {
  annotations?: unknown;
}

/** What a run read that a model reads too. */
export interface DirectoryDecisionEvidence {
  tools?: readonly DirectoryDecisionTool[];
  /** The server's `instructions` from `initialize`. */
  instructions?: string;
  /** Listing text a model reads, such as a plugin package's descriptions. */
  listing?: readonly { field: string; text: string }[];
}

type Proposal = Omit<DirectoryDecisionCandidate, "key"> & { rank: number };

/** Characters of one field read, as the direction scan reads them. */
const MAX_FIELD_CHARS = 20_000;

/** A word list by stem: "creat" covers create, creates, created, creating. */
const stems = (list: string) =>
  new RegExp(`\\b(?:${list})(?:e|es|ed|ing|s)?\\b`, "i");

// What a description says a tool does, as each hint speaks to it.
const WRITES = stems(
  "creat|add|insert|updat|edit|modif(?:y|ies|ied|ying)|chang|sav|writ|written|send|sent|post|publish|submit|submitt|upload|delet|remov|archiv|mov|renam|cancel|cancell|schedul|purchas|pay|paid|transfer|transferr|deploy|install|trigger|overwrit|overwritten"
);
const READS = stems(
  "get|list|read|fetch|retriev|search|find|view|show|return|quer(?:y|ies|ied|ying)|inspect|describ|count|lookup"
);
const DESTROYS = stems(
  "delet|remov|overwrit|overwritten|drop|dropp|destroy|eras|purg|wip|truncat|revok|replac|permanently|irreversibl"
);
const REACHES_OUT =
  /\b(?:internet|web|websites?|webhooks?|urls?|external|third[- ]party|public(?:ly)?|e-?mails?|sms|slack|tweets?|social media)\b|https?:\/\//i;
const ADDS = stems(
  "creat|add|insert|append|increment|generat|send|sent|post|submit|submitt"
);

/** Telling the model which plugin or tool to pick. */
const STEERS =
  /\b(?:always|only)\s+(?:use|call|choose|pick|recommend|suggest)\s+(?:this|our|these)\b|\bprefer\s+(?:this|our|these)\b|\b(?:instead\s+of|rather\s+than|over)\s+(?:all\s+|any\s+)?(?:other|another|competing|alternative)\b|\b(?:do\s+not|don't|never|avoid)\s+(?:\w+\s+){0,2}(?:other|another|competing|alternative)\s+(?:\w+\s+)?(?:plugins?|apps?|tools?|connectors?|servers?|services?)\b/i;
/** Comparing it with alternatives. */
const COMPARES =
  /\b(?:better|faster|cheaper|more\s+(?:accurate|reliable)|superior)\s+(?:than|to)\b|\bcompetitors?\b|\bunlike\s+(?:other|most|competing)\b/i;
/** Secrets and protected context. */
const SECRETS =
  /\bpass(?:word|code|phrase)s?\b|\bapi[\s_-]?keys?\b|\b(?:access|bearer|refresh|auth|session|id)[\s_-]?tokens?\b|\b(?:client[\s_-]?)?secrets?\b|\bprivate[\s_-]?keys?\b|\b(?:one[\s-]time|verification|security|2fa|mfa|otp)\s+(?:codes?|pins?)\b|\bcookies?\b|\bcredentials?\b|\bsystem\s+(?:prompt|message|instructions)\b|\b(?:hidden|developer)\s+(?:instructions|prompts?|messages?)\b|\b(?:conversation|chat)\s+(?:history|logs?|transcripts?)\b/i;
/** The strongest secret candidates ask for one. */
const ASKS =
  /\b(?:pass|provide|enter|paste|include|send|supply|give|share|reveal|print|repeat|output|attach|forward|copy)\b/i;

const GENERATORS: Record<
  DirectoryDecisionQuestionId,
  (evidence: DirectoryDecisionEvidence) => Proposal[]
> = {
  "claude.decision.cross-tool-direction": ({ tools = [] }) =>
    findToolDirectionCandidates(tools).map(({ quote, references, ...at }) => ({
      ...at,
      text: quote,
      references: references.slice(0, LIMITS.maxReferences),
      rank: 1,
    })),
  "openai.decision.fair-play": (evidence) =>
    sentenceProposals(evidence, (text) => {
      const steers = text.search(STEERS);
      if (steers >= 0) return [2, steers];
      const compares = text.search(COMPARES);
      return compares >= 0 ? [1, compares] : [0, 0];
    }),
  "openai.decision.secret-seeking": (evidence) =>
    sentenceProposals(evidence, (text) => {
      const secrets = starts(text, SECRETS);
      if (secrets.length === 0) return [0, 0];
      const asks = starts(text, ASKS);
      if (asks.length === 0) return [1, secrets[0]!];
      // Centre on the request nearest a secret, so a long sentence that names
      // one secret early and asks for another later shows the request.
      let best: [ask: number, secret: number] = [asks[0]!, secrets[0]!];
      for (const ask of asks) {
        for (const secret of secrets) {
          if (Math.abs(ask - secret) < Math.abs(best[0] - best[1])) {
            best = [ask, secret];
          }
        }
      }
      return [2, Math.min(...best)];
    }),
  "both.decision.annotation-matches-behaviour": ({ tools = [] }) =>
    tools.flatMap(annotationProposal),
};

/** Every candidate for the questions `directory`'s runs ask. */
export function findDecisionCandidates(
  directory: DirectoryDecisionDirectory,
  evidence: DirectoryDecisionEvidence
): DirectoryDecisionItem[] {
  return DIRECTORY_DECISION_QUESTIONS.filter((question) =>
    question.directories.includes(directory)
  ).flatMap(({ id }) => keyed(id, GENERATORS[id](evidence)));
}

/** Where each match of `pattern` starts in `text`. */
function starts(text: string, pattern: RegExp): number[] {
  const flags = `${pattern.flags.replace("g", "")}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))].map(
    (match) => match.index
  );
}

/**
 * Each sentence of the model-readable text that `rank` ranks above zero.
 * `rank` also says where its signal starts, so a long sentence's excerpt keeps
 * the words that made it a candidate.
 */
function sentenceProposals(
  { tools = [], instructions, listing = [] }: DirectoryDecisionEvidence,
  rank: (sentence: string) => [rank: number, at: number]
): Proposal[] {
  const fields: Array<{ tool?: string; field: string; text: string }> = [
    ...tools.flatMap((t) =>
      textFields(t).map(([field, text]) => ({ tool: t.name, field, text }))
    ),
    ...(instructions ? [{ field: "instructions", text: instructions }] : []),
    ...listing,
  ];
  return fields.flatMap(({ tool, field, text }) =>
    sentences(text.slice(0, MAX_FIELD_CHARS)).flatMap((sentence) => {
      const [value, at] = rank(sentence);
      if (value === 0) return [];
      const named = tool ? { tool } : {};
      return [{ ...named, field, text: excerpt(sentence, at), rank: value }];
    })
  );
}

/**
 * A tool whose description mentions behaviour one of its hints may deny,
 * ranked by how many hints it may contradict.
 */
function annotationProposal(tool: DirectoryDecisionTool): Proposal[] {
  const annotations = decisionHints(tool.annotations);
  const text = tool.description ?? "";
  if (!annotations) return [];
  const writes = text.search(WRITES);
  const readsOnly = writes < 0 ? text.search(READS) : -1;
  const destroys = text.search(DESTROYS);
  const { readOnlyHint, destructiveHint, openWorldHint, idempotentHint } =
    annotations;
  // Where each mention a hint may deny starts.
  const mentions = [
    readOnlyHint === true ? writes : -1,
    readOnlyHint === false ? readsOnly : -1,
    destructiveHint === false ? destroys : -1,
    destructiveHint === true && destroys < 0 ? readsOnly : -1,
    openWorldHint === false ? text.search(REACHES_OUT) : -1,
    idempotentHint === true ? text.search(ADDS) : -1,
  ].filter((index) => index >= 0);
  if (mentions.length === 0) return [];
  return [
    {
      tool: tool.name,
      field: "description",
      text: excerpt(text, Math.min(...mentions)),
      annotations,
      rank: mentions.length,
    },
  ];
}

/** The text, or the part around `at` that fits the bound: verbatim either way. */
function excerpt(text: string, at = 0): string {
  const max = LIMITS.maxTextChars;
  const start = Math.max(0, Math.min(at - 200, text.length - max));
  return text.slice(start, start + max);
}

/** Best first, each under a key unique within its question. */
function keyed(
  questionId: DirectoryDecisionQuestionId,
  proposals: Proposal[]
): DirectoryDecisionItem[] {
  const seen = new Map<string, number>();
  return proposals
    .sort((a, b) => b.rank - a.rank)
    .map(({ rank: _rank, ...candidate }) => {
      const at = [candidate.tool, candidate.field].filter(Boolean).join(" ");
      const base = at.slice(0, LIMITS.maxKeyChars - 10);
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      const key = count === 1 ? base : `${base} #${count}`;
      return { questionId, candidate: { key, ...candidate } };
    });
}
