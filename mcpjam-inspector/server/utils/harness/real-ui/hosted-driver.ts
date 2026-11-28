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
  type PageDriverErrorCode,
} from "./page-driver.js";

/** Sends one command; the caller supplies the session and its credentials. */
export type BrowserCommandTransport = (
  command: BrowserAgentCommand,
) => Promise<BrowserAgentResult>;

type Executed = Extract<BrowserAgentResult, { status: "executed" }>;

/**
 * The driver's code for a command that was refused or a read that failed. A
 * person holding the browser gets its own code because the turn can wait for
 * them; anything else is a plain failure, never an element that is absent.
 */
function failureCode(code: string | undefined): PageDriverErrorCode {
  if (code === "origin_not_allowed") return "site_blocked";
  if (code === "lease_held" || code === "lease_parked") return "person_has_browser";
  return "failed";
}

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
      throw new PageDriverError(failureCode(result.refusal.code), result.refusal.message);
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
    // Reads and acts find their element with Playwright's engine in the browser.
    playwrightSelectors: true,
    pressesOnElement: false,
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
    async press(key, selector) {
      // The browser presses where focus is and takes no selector for a key,
      // so a key meant for one element is refused rather than sent to another.
      if (selector) {
        throw new PageDriverError("unsupported", `The hosted browser can't press ${key} on ${selector}.`);
      }
      await act("press", undefined, key);
    },
    async readText(selector) {
      // The element's `innerText`, found by Playwright's engine in the
      // browser: the same element and text the Playwright driver reads.
      const result = await run({ op: "observe", mode: "text", rootSelector: selector });
      if (result.ok) return result.page?.pageContent.text?.trim();
      if (result.error?.code === "unknown_selector") return undefined;
      // Anything else is a read that failed, never an element that is absent.
      throw new PageDriverError(
        failureCode(result.error?.code),
        result.error?.message ?? "The browser could not read the page.",
      );
    },
    async pageText() {
      const result = await run({ op: "observe", mode: "text" });
      return result.ok ? (result.page?.pageContent.text ?? "") : "";
    },
  };
}
