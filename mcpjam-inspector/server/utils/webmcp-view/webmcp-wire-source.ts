import { WEBMCP_APP_CONTRACT } from "@mcpjam/sdk/widget-runtime";

/** Shared ES2017 source: evaluated in each isolated realm, never stringified functions. */
export const WEBMCP_WIRE_SOURCE = `
const webmcpWire = (() => {
  const contract = ${JSON.stringify(WEBMCP_APP_CONTRACT)};
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const snapshot = value => JSON.parse(JSON.stringify(value === undefined ? null : value));
  const message = error => {
    try { return String(error && error.message !== undefined ? error.message : error).slice(0, 4096); }
    catch (failure) { return "Tool result could not be encoded"; }
  };
  const failure = error => ({content: [{type: "text", text: message(error)}], isError: true});
  const success = value => {
    const result = {
      content: [{type: "text", text: typeof value === "string" ? value : JSON.stringify(value)}],
      structuredContent: object(value) ? value : {result: value}
    };
    if (bytes(result) > contract.maxResultBytes) throw new Error("Tool result exceeds the 256 KiB limit");
    return result;
  };
  const tool = value => {
    try {
      if (!object(value)) return null;
      const {name, description, inputSchema, title, annotations} = value;
      if (typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(name)) return null;
      if (typeof description !== "string" || !description.trim()) return null;
      if (inputSchema !== undefined && (!object(inputSchema) ||
          (inputSchema.type !== undefined && inputSchema.type !== "object"))) return null;
      const schema = snapshot(inputSchema === undefined ? {type: "object"} : inputSchema);
      schema.type = "object";
      if (bytes(schema) > contract.maxSchemaBytes) return null;
      const result = {name, description: description.slice(0, contract.maxDescriptionChars), inputSchema: schema};
      if (typeof title === "string") result.title = title.slice(0, contract.maxDescriptionChars);
      if (object(annotations) && typeof annotations.readOnlyHint === "boolean") {
        result.annotations = {readOnlyHint: annotations.readOnlyHint};
      }
      return result;
    } catch (error) { return null; }
  };
  return {contract, bytes, object, snapshot, message, failure, success, tool};
})();
`;
