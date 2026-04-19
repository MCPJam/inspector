import { describe, expect, it } from "vitest";
import {
  buildEvalsHash,
  navigateToEvalsRoute,
  parseEvalsRoute,
} from "../evals-router";

describe("evals-router test-edit compare query", () => {
  it("parses test edit with compare=1", () => {
    window.location.hash = "#/evals/suite/s_123/test/t_789/edit?compare=1";
    expect(parseEvalsRoute()).toEqual({
      type: "test-edit",
      suiteId: "s_123",
      testId: "t_789",
      openCompare: true,
    });
  });

  it("parses test edit with compare=true", () => {
    window.location.hash = "#/evals/suite/s_123/test/t_789/edit?compare=true";
    expect(parseEvalsRoute()).toEqual({
      type: "test-edit",
      suiteId: "s_123",
      testId: "t_789",
      openCompare: true,
    });
  });

  it("parses test edit without compare query", () => {
    window.location.hash = "#/evals/suite/s_123/test/t_789/edit";
    expect(parseEvalsRoute()).toEqual({
      type: "test-edit",
      suiteId: "s_123",
      testId: "t_789",
    });
  });

  it("builds test edit with compare=1", () => {
    const hash = buildEvalsHash({
      type: "test-edit",
      suiteId: "s_abc",
      testId: "t_def",
      openCompare: true,
    });
    expect(hash).toBe("#/evals/suite/s_abc/test/t_def/edit?compare=1");
  });

  it("parses test edit with compare and iteration queries", () => {
    window.location.hash =
      "#/evals/suite/s_123/test/t_789/edit?compare=1&iteration=i_42";
    expect(parseEvalsRoute()).toEqual({
      type: "test-edit",
      suiteId: "s_123",
      testId: "t_789",
      openCompare: true,
      iteration: "i_42",
    });
  });

  it("builds test edit with compare=1 and iteration", () => {
    const hash = buildEvalsHash({
      type: "test-edit",
      suiteId: "s_abc",
      testId: "t_def",
      openCompare: true,
      iteration: "i_42",
    });
    expect(hash).toBe(
      "#/evals/suite/s_abc/test/t_def/edit?compare=1&iteration=i_42",
    );
  });

  it("navigates to test edit with compare=1", () => {
    navigateToEvalsRoute({
      type: "test-edit",
      suiteId: "s_abc",
      testId: "t_def",
      openCompare: true,
    });
    expect(window.location.hash).toBe(
      "#/evals/suite/s_abc/test/t_def/edit?compare=1",
    );
  });
});
