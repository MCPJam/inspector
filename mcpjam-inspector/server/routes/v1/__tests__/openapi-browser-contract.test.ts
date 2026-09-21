import { readFileSync } from "node:fs";
import Ajv from "ajv/dist/2020";
import { expect, it } from "vitest";
const schemas = JSON.parse(
  readFileSync(
    new URL("../../../../../docs/reference/openapi.json", import.meta.url),
    "utf8",
  ),
).components.schemas;
const ajv = new Ajv({ strict: false, validateFormats: false });
it("accepts browserless detail and rejects malformed browser values", () => {
  const validate = ajv.compile({
    ...schemas.ChatSessionDetail.properties.browser,
    components: { schemas },
  });
  expect(validate(null)).toBe(true);
  expect(validate({ browserSessionId: "logical", state: "active" })).toBe(true);
  expect(validate("active")).toBe(false);
});
it("requires exactly one typed desktop identity for a trace box", () => {
  const validate = ajv.compile(
    schemas.ChatSessionTraceTurn.properties.browser.properties.box,
  );
  expect(validate({ sandboxRowId: "box" })).toBe(true);
  expect(validate({ computerId: "computer" })).toBe(true);
  for (const value of [
    {},
    "live",
    { sandboxRowId: 1 },
    { computerId: "c", sandboxRowId: "s" },
  ])
    expect(validate(value)).toBe(false);
});
