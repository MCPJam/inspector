/**
 * The hosted driver: the conversation browser's command API
 * (`POST /v1/chat-sessions/:id/browser/command`), the same commands an agent
 * sends, so the hosted browser keeps its lease, its ledger and the person's
 * ability to take over.
 *
 * Two limits follow from that API. It runs no script in the page, so
 * `evaluate` is unsupported and a page module reads what it needs from the
 * page itself. And an `unknown` outcome may or may not have run, so it is
 * raised as `unknown_outcome` and never retried here: a send that ends that
 * way is settled by reading the chat, not by sending again.
 */
import type {
  BrowserAgentCommand,
  BrowserAgentResult,
} from "@/shared/browser-agent-contract";
import {
  PageDriverError,
  assertOnSites,
  pollUntil,
  type PageDriver,
} from "./page-driver.js";

/** Sends one command; the caller supplies the session and its credentials. */
export type BrowserCommandTransport = (
  command: BrowserAgentCommand,
) => Promise<BrowserAgentResult>;

type Executed = Extract<BrowserAgentResult, { status: "executed" }>;

export function createHostedPageDriver(
  send: BrowserCommandTransport,
  options: { sites: readonly string[] },
): PageDriver {
  const run = async (command: BrowserAgentCommand): Promise<Executed> => {
    const result = await send(command);
    if (result.status === "unknown") {
      throw new PageDriverError(
        "unknown_outcome",
        `The browser could not say whether ${command.op} ran.`,
      );
    }
    if (result.status === "refused") {
      const code =
        result.refusal.code === "origin_not_allowed" ? "site_blocked" : "failed";
      throw new PageDriverError(code, result.refusal.message);
    }
    return result;
  };
  const act = async (
    verb: "click" | "type" | "press",
    selector: string | undefined,
    value?: string,
  ) => {
    const result = await run({
      op: "act",
      verb,
      ...(selector ? { target: { selector } } : {}),
      ...(value !== undefined ? { value } : {}),
      observeAfter: "none",
    });
    if (!result.ok) {
      throw new PageDriverError(
        "not_found",
        result.error?.message ?? `The ${verb} found nothing to act on.`,
      );
    }
  };

  return {
    kind: "hosted",
    canEvaluate: false,
    async navigate(url) {
      assertOnSites(url, options.sites);
      const result = await run({ op: "navigate", url, observeAfter: "none" });
      if (!result.ok) {
        throw new PageDriverError("failed", result.error?.message ?? "The page did not open.");
      }
    },
    async url() {
      const result = await run({ op: "observe", mode: "url" });
      return result.page?.pageContent.url ?? "";
    },
    async evaluate() {
      throw new PageDriverError(
        "unsupported",
        "The hosted browser runs no script in the page.",
      );
    },
    waitFor: pollUntil,
    click: (selector) => act("click", selector),
    type: (selector, text) => act("type", selector, text),
    press: (key, selector) => act("press", selector, key),
    async readText(selector) {
      // The accessibility tree scoped to the element is the closest the API
      // has to an element's text: its names are the text a person sees.
      const result = await run({
        op: "observe",
        mode: "a11y",
        rootSelector: selector,
        filter: "all",
      });
      if (!result.ok) return undefined;
      return result.page?.pageContent.a11y?.trim();
    },
    async pageText() {
      const result = await run({ op: "observe", mode: "text" });
      return result.ok ? (result.page?.pageContent.text ?? "") : "";
    },
  };
}
