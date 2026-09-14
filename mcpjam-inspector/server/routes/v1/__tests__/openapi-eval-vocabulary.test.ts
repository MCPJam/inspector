import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * How the spec documents the vocabulary-2 shapes.
 *
 * OpenAPI cannot say "this field exists only when a header is `2`", so an
 * operation that varies by `x-mcpjam-eval-vocabulary` keeps its vocabulary-1
 * `$ref`s (every existing parity test keeps holding on them) and adds:
 *
 *   - the `evalVocabularyHeader` parameter, and
 *   - an `x-mcpjam-eval-vocabulary` extension naming, per vocabulary, the
 *     component schemas its request body and response conform to.
 *
 * This pins that every extension sits behind the header (a shape no request
 * could select is documentation of nothing) and names real `…V2` schemas.
 */

const here = dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(
  readFileSync(
    resolve(here, "../../../../../docs/reference/openapi.json"),
    "utf8",
  ),
) as {
  components: {
    parameters: Record<string, { name: string }>;
    schemas: Record<string, unknown>;
  };
  paths: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        parameters?: Array<{ $ref?: string }>;
        "x-mcpjam-eval-vocabulary"?: Record<
          string,
          { requestBody?: string; response?: string }
        >;
      }
    >
  >;
};

const HEADER_REF = "#/components/parameters/evalVocabularyHeader";

const operations = Object.values(spec.paths).flatMap((methods) =>
  Object.values(methods).filter((op) => typeof op?.operationId === "string"),
);

describe("x-mcpjam-eval-vocabulary in openapi.json", () => {
  it("publishes the header parameter under its wire name", () => {
    expect(spec.components.parameters.evalVocabularyHeader?.name).toBe(
      "x-mcpjam-eval-vocabulary",
    );
  });

  it("documents vocabulary-2 shapes only on operations that carry the header", () => {
    // The header is on every eval operation whose response carries a policy
    // role (the value projection); the extension is on the subset whose
    // FIELD spellings differ. An extension without the header would document
    // a shape no request can select.
    const withHeader = new Set(
      operations
        .filter((op) => op.parameters?.some((p) => p.$ref === HEADER_REF))
        .map((op) => op.operationId),
    );
    const withExtension = operations
      .filter((op) => op["x-mcpjam-eval-vocabulary"] !== undefined)
      .map((op) => op.operationId);
    expect(withExtension.length).toBeGreaterThan(0);
    for (const opId of withExtension) {
      expect(withHeader.has(opId), `${opId} lacks the header`).toBe(true);
    }
  });

  it("names only schemas that exist, and never the vocabulary-1 one", () => {
    for (const op of operations) {
      const ext = op["x-mcpjam-eval-vocabulary"];
      if (!ext) continue;
      const v2 = ext["2"];
      expect(v2, `${op.operationId} documents vocabulary 2`).toBeDefined();
      for (const name of [v2?.requestBody, v2?.response]) {
        if (name === undefined) continue;
        expect(
          spec.components.schemas[name],
          `${op.operationId}: ${name} is not a component schema`,
        ).toBeDefined();
        // A V2 entry pointing at the vocabulary-1 schema would document a
        // header that changes nothing.
        expect(name.endsWith("V2"), `${op.operationId}: ${name}`).toBe(true);
      }
    }
  });
});
