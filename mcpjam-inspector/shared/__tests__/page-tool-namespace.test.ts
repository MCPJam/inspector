import { describe, it, expect } from "vitest";
import {
  isClientFulfilledToolName,
  isPageToolAlias,
  isAppToolAlias,
  isUiToolName,
  pageToolCallNeedsApproval,
  PAGE_TOOL_ALIAS_REGEX,
} from "../client-fulfilled-tools";

describe("page tool namespace", () => {
  it("recognises well-formed aliases and rejects near-misses", () => {
    expect(isPageToolAlias("page_1a2b3c4d")).toBe(true);
    expect(isPageToolAlias("page_ABCDEF01")).toBe(true);
    expect(isPageToolAlias("page_1a2b3c")).toBe(false); // too short
    expect(isPageToolAlias("page_1a2b3c4d5")).toBe(false); // too long
    expect(isPageToolAlias("page-1a2b3c4d")).toBe(false); // wrong separator
    expect(isPageToolAlias("pages_1a2b3c4d")).toBe(false);
    expect(isPageToolAlias("add_to_cart")).toBe(false);
  });

  it("stays disjoint from the app and ui namespaces", () => {
    // Overlap would mean one namespace's approval policy silently applying to
    // another's tools.
    expect(isAppToolAlias("page_1a2b3c4d")).toBe(false);
    expect(isUiToolName("page_1a2b3c4d")).toBe(false);
    expect(isPageToolAlias("app_1a2b3c4d")).toBe(false);
    expect(isPageToolAlias("ui_snapshot_app")).toBe(false);
  });

  it("counts as client-fulfilled, which is what wires the server gates", () => {
    // Both the pause predicate and the skip gate key off this one function, so
    // this single assertion is what stops a page tool being executed
    // server-side or leaving a turn waiting on a result nobody will send.
    expect(isClientFulfilledToolName("page_1a2b3c4d")).toBe(true);
    expect(isClientFulfilledToolName("app_1a2b3c4d")).toBe(true);
    expect(isClientFulfilledToolName("ui_snapshot_app")).toBe(true);
    expect(isClientFulfilledToolName("some_server_tool")).toBe(false);
  });

  it("satisfies the model-facing tool-name charset", () => {
    // `^[a-zA-Z0-9_-]{1,64}$` is enforced for Anthropic and Bedrock. Page
    // authors can name a tool anything, which is the reason aliases exist.
    const anthropicCharset = /^[a-zA-Z0-9_-]{1,64}$/;
    expect(anthropicCharset.test("page_1a2b3c4d")).toBe(true);
    expect(PAGE_TOOL_ALIAS_REGEX.source).toContain("page_");
  });

  it("always requires approval for a model-driven call", () => {
    // Not a flag, and not derived from annotations: page annotations are claims
    // by the party whose code would run, and Chromium does not carry their
    // values through for imperative registrations anyway.
    expect(pageToolCallNeedsApproval()).toBe(true);
  });
});
