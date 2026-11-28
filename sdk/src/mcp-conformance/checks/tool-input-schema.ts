import { Ajv } from "@modelcontextprotocol/client/validators/ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { supportedJsonSchemaDialect } from "../../mcp-client-manager/dialect-dispatch-json-schema-validator.js";
import { checkSchemaReferences, type SchemaIssue } from "./tool-input-schema-references.js";

const options = { strict: false, validateFormats: false } as const;
const draft2020 = new Ajv2020(options);
const draft07 = new Ajv(options);

export function checkToolInputSchema(
  schema: Record<string, unknown>,
): SchemaIssue | undefined {
  const declared = schema.$schema;
  if (declared !== undefined && typeof declared !== "string") {
    return { status: "invalid", reason: "inputSchema.$schema is not a string" };
  }

  const dialect = supportedJsonSchemaDialect(declared);
  if (dialect === undefined) {
    return {
      status: "unsupported",
      reason: `inputSchema declares unsupported JSON Schema dialect ${declared}`,
    };
  }

  const validator = dialect === "draft2020" ? draft2020 : draft07;
  const metaSchema =
    dialect === "draft2020"
      ? "https://json-schema.org/draft/2020-12/schema"
      : "http://json-schema.org/draft-07/schema#";
  if (validator.validate(metaSchema, schema) !== true) {
    return {
      status: "invalid",
      reason: validator.errorsText(validator.errors, { dataVar: "inputSchema" }),
    };
  }

  return checkSchemaReferences(schema, dialect, validator.opts.uriResolver.resolve, (target) =>
    validator.validate(metaSchema, target) === true
      ? undefined
      : validator.errorsText(validator.errors, { dataVar: "target schema" }),
  );
}
