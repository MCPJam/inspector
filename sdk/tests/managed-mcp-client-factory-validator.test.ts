import { describe, expect, it } from "vitest";
import type { ClientOptions } from "@modelcontextprotocol/client";
import { createManagedMcpClient } from "../src/mcp-client-manager/managed-mcp-client-factory.js";
import { OfficialSdkClientAdapter } from "../src/mcp-client-manager/official-sdk-client-adapter.js";
import { DialectAwareJsonSchemaValidator } from "../src/mcp-client-manager/dialect-aware-json-schema-validator.js";

const clientInfo = { name: "test", version: "0.0.0" };

// Reach the validator the upstream Client actually stored. It lives on the
// private `_jsonSchemaValidator` field; the factory's whole job here is to
// ensure it is never the rejecting upstream default.
function storedValidator(adapter: OfficialSdkClientAdapter): unknown {
  return (adapter.inner as unknown as { _jsonSchemaValidator: unknown })
    ._jsonSchemaValidator;
}

describe("createManagedMcpClient validator wiring", () => {
  it("defaults to the dialect-aware validator when none is supplied", () => {
    const adapter = createManagedMcpClient({
      clientInfo,
      clientOptions: { capabilities: {} },
    }) as OfficialSdkClientAdapter;

    expect(storedValidator(adapter)).toBeInstanceOf(
      DialectAwareJsonSchemaValidator
    );
  });

  it("keeps the dialect-aware default when a caller passes jsonSchemaValidator: undefined", () => {
    // Regression for cubic P2: an explicit undefined in clientOptions must not
    // spread over the default and drop us back to Client's rejecting validator.
    const adapter = createManagedMcpClient({
      clientInfo,
      clientOptions: {
        capabilities: {},
        jsonSchemaValidator: undefined,
      } as ClientOptions,
    }) as OfficialSdkClientAdapter;

    expect(storedValidator(adapter)).toBeInstanceOf(
      DialectAwareJsonSchemaValidator
    );
  });

  it("lets a real caller-supplied validator win", () => {
    const custom = new DialectAwareJsonSchemaValidator();
    const adapter = createManagedMcpClient({
      clientInfo,
      clientOptions: {
        capabilities: {},
        jsonSchemaValidator: custom,
      },
    }) as OfficialSdkClientAdapter;

    expect(storedValidator(adapter)).toBe(custom);
  });
});
