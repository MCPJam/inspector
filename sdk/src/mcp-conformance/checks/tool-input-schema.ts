import { Ajv } from "@modelcontextprotocol/client/validators/ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { supportedJsonSchemaDialect } from "../../mcp-client-manager/dialect-dispatch-json-schema-validator.js";

const draft2020 = new Ajv2020({ strict: false, validateFormats: false });
const draft07 = new Ajv({ strict: false, validateFormats: false });

export function checkToolInputSchema(
  schema: Record<string, unknown>,
): { status: "invalid" | "unsupported"; reason: string } | undefined {
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
  // Grade the schema with the built-in metaschema so tool references stay offline.
  if (validator.validate(metaSchema, schema) === true) return undefined;

  return {
    status: "invalid",
    reason: validator.errorsText(validator.errors, { dataVar: "inputSchema" }),
  };
}
