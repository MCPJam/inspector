import Ajv from "ajv";

const ajv = new Ajv({ strict: false });

/** An automatic task call sends {}, so its schema must accept that value. */
export function acceptsEmptyToolArguments(
  schema: Record<string, unknown> | undefined,
): boolean {
  if (!schema || schema.$async === true) return false;
  try {
    return ajv.compile(schema)({}) === true;
  } catch {
    // An unsupported schema cannot establish that an automatic call is ready.
    return false;
  }
}
