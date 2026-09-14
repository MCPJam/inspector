import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  CASE_FIELD_ALIASES_V2,
  DEFAULT_EVAL_VOCABULARY,
  EVAL_VOCABULARY_CAPABILITY,
  EVAL_VOCABULARY_HEADER,
  SUITE_SETTINGS_ALIASES_V2,
  evalVocabularyMiddleware,
  parseEvalVocabulary,
  readEvalVocabulary,
  varyByEvalVocabulary,
} from "../eval-vocabulary.js";
import { WebRouteError } from "../../routes/web/errors.js";

/**
 * The vocabulary header is the ONE thing that decides which spellings a body
 * may use, so its parse has to be exact: a lenient reader that mapped "2 "
 * and "two" to different answers would silently reinterpret `iterations`
 * (a floor under 1, an exact count under 2) for the caller who typoed.
 */
describe("parseEvalVocabulary", () => {
  it("defaults to vocabulary 1 when the header is absent or blank", () => {
    expect(DEFAULT_EVAL_VOCABULARY).toBe(1);
    expect(parseEvalVocabulary(undefined)).toBe(1);
    expect(parseEvalVocabulary(null)).toBe(1);
    expect(parseEvalVocabulary("")).toBe(1);
    expect(parseEvalVocabulary("   ")).toBe(1);
  });

  it("reads the two vocabularies, trimmed", () => {
    expect(parseEvalVocabulary("1")).toBe(1);
    expect(parseEvalVocabulary("2")).toBe(2);
    expect(parseEvalVocabulary(" 2 ")).toBe(2);
  });

  it.each(["3", "two", "2.0", "v2", "0"])(
    "refuses %j with a 400 that names both accepted values",
    (raw) => {
      let caught: unknown;
      try {
        parseEvalVocabulary(raw);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WebRouteError);
      const error = caught as WebRouteError;
      expect(error.status).toBe(400);
      expect(error.message).toContain(EVAL_VOCABULARY_HEADER);
      expect(error.message).toContain('"1" or "2"');
      expect(error.message).toContain(JSON.stringify(raw));
    },
  );
});

describe("the middleware and the reader agree", () => {
  function app() {
    const hono = new Hono();
    hono.use("/evals/*", evalVocabularyMiddleware());
    hono.get("/evals/read", (c) =>
      c.json({ vocabulary: readEvalVocabulary(c) }),
    );
    // A route OUTSIDE the middleware's patterns still reads the header — the
    // reader falls back to parsing so a handler is never left guessing.
    hono.get("/bare", (c) => c.json({ vocabulary: readEvalVocabulary(c) }));
    hono.get("/vary", (c) => {
      c.header("Vary", "Accept-Encoding");
      varyByEvalVocabulary(c);
      return c.json({ ok: true });
    });
    hono.onError((error, c) => {
      if (error instanceof WebRouteError) {
        return c.json({ message: error.message }, error.status as 400);
      }
      throw error;
    });
    return hono;
  }

  it("stores the parsed vocabulary for the handler", async () => {
    const res = await app().request("/evals/read", {
      headers: { [EVAL_VOCABULARY_HEADER]: "2" },
    });
    expect(await res.json()).toEqual({ vocabulary: 2 });
    const bare = await app().request("/evals/read");
    expect(await bare.json()).toEqual({ vocabulary: 1 });
  });

  it("refuses a bad value before the handler runs", async () => {
    const res = await app().request("/evals/read", {
      headers: { [EVAL_VOCABULARY_HEADER]: "3" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain(
      EVAL_VOCABULARY_HEADER,
    );
  });

  it("falls back to parsing on a route the middleware did not cover", async () => {
    const res = await app().request("/bare", {
      headers: { [EVAL_VOCABULARY_HEADER]: "2" },
    });
    expect(await res.json()).toEqual({ vocabulary: 2 });
  });

  it("appends to an existing Vary rather than clobbering it", async () => {
    const res = await app().request("/vary");
    const vary = res.headers.get("vary") ?? "";
    expect(vary).toContain("Accept-Encoding");
    expect(vary).toContain(EVAL_VOCABULARY_HEADER);
  });
});

describe("the advertised capability", () => {
  it("is the pinned block, and its field map is the alias tables", () => {
    // The contract's literal (docs/evals-vocabulary-consolidation.md,
    // "Capability"). Pinned as a value so a drift in either the tables or the
    // block is a failing test, not a client reading the wrong spellings.
    expect(EVAL_VOCABULARY_CAPABILITY).toEqual({
      version: 2,
      evaluatorKinds: ["assertion", "judge"],
      assertionKinds: expect.arrayContaining(["noToolErrors"]),
      fields: {
        assertions: ["checks", "predicates"],
        defaultAssertions: ["defaultPredicates"],
        iterations: ["repetitions"],
        legacyIterations: ["runs"],
      },
    });
    expect(EVAL_VOCABULARY_CAPABILITY.fields.assertions).toBe(
      CASE_FIELD_ALIASES_V2.assertions,
    );
    expect(EVAL_VOCABULARY_CAPABILITY.fields.defaultAssertions).toBe(
      SUITE_SETTINGS_ALIASES_V2.defaultAssertions,
    );
  });

  it("never lists `iterations` as a legacy spelling of the floor", () => {
    // Under vocabulary 1 that key IS the floor; under vocabulary 2 it is the
    // exact count. Advertising it here would tell a canonical client that
    // sending `iterations` means "floor", which is the one reading the
    // negotiated vocabulary exists to rule out.
    expect(EVAL_VOCABULARY_CAPABILITY.fields.legacyIterations).not.toContain(
      "iterations",
    );
  });
});
