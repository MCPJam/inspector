import { gunzipSync } from "node:zlib";
export type Sink = "posthog" | "sentry" | "axiom" | "other";
export function sinkOf(url: string): Sink {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "other";
  }
  if (/(^|\.)ingest\.([a-z]+\.)?sentry\.io$/i.test(parsed.hostname))
    return "sentry";
  if (/(^|\.)axiom\.(co|cloud)$/i.test(parsed.hostname)) return "axiom";
  if (parsed.origin === "https://us.i.posthog.com") return "posthog";
  if (/^\/(tlm|relay)(\/|$)/.test(parsed.pathname)) return "posthog";
  return "other";
}
export function decodeAxiomBody(body: Uint8Array | null): unknown {
  if (!body?.length) return [];
  const bytes = body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body;
  const text = Buffer.from(bytes).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
  }
}
