import { Validator, type SchemaDraft } from "@cfworker/json-schema";
import Ajv from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";

const DIALECTS: Record<string, SchemaDraft> = {
  "http://json-schema.org/draft-04/schema": "4",
  "https://json-schema.org/draft-04/schema": "4",
  "http://json-schema.org/draft-07/schema": "7",
  "https://json-schema.org/draft-07/schema": "7",
  "http://json-schema.org/draft/2019-09/schema": "2019-09",
  "https://json-schema.org/draft/2019-09/schema": "2019-09",
  "http://json-schema.org/draft/2020-12/schema": "2020-12",
  "https://json-schema.org/draft/2020-12/schema": "2020-12",
};

/** Check tool arguments using the dialect declared by the tool. */
export function acceptsToolArguments(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): boolean {
  if (!schema || schema.$async === true) return false;
  try {
    const dialect =
      typeof schema.$schema === "string"
        ? schema.$schema.replace(/#$/, "")
        : undefined;
    const draft =
      dialect === undefined
        ? "2020-12"
        : Object.hasOwn(DIALECTS, dialect)
          ? DIALECTS[dialect]
          : undefined;
    if (!draft) return false;
    if (draft === "4") {
      // Ajv 8 does not implement draft-04's boolean numeric limits.
      return new Validator(structuredClone(schema), draft).validate(args).valid;
    }
    const ajv =
      draft === "7"
        ? new Ajv({ strict: false })
        : draft === "2019-09"
          ? new Ajv2019({ strict: false })
          : new Ajv2020({ strict: false });
    // HTTP/HTTPS aliases name the same dialect, but Ajv registers one URI.
    // Keep the dialect's rules and give each check its own reference cache.
    const $schema =
      draft === "7"
        ? "http://json-schema.org/draft-07/schema#"
        : `https://json-schema.org/draft/${draft}/schema`;
    return ajv.compile({ ...schema, $schema })(args) === true;
  } catch {
    // An unsupported schema cannot establish that the tool arguments are ready.
    return false;
  }
}

/** An automatic task call sends {}, so its schema must accept that value. */
export function acceptsEmptyToolArguments(
  schema: Record<string, unknown> | undefined,
): boolean {
  return acceptsToolArguments(schema, {});
}
