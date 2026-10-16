import { describe, expect, it, vi } from "vitest";
import {
  McpjamLeaseClient,
  McpjamLeaseError,
  classifyMcpjamLeaseError,
} from "../src/mcpjam-model-lease.js";

describe("platform admission lease refusals", () => {
  it("recognizes a fee refusal without a reason field as billing", () => {
    const error = new McpjamLeaseError("Add credits.", {
      code: "PAYMENT_REQUIRED",
      status: 402,
      details: { code: "platform_fee_refused" },
    });
    expect(classifyMcpjamLeaseError(error)).toBe("billing");
  });
  it("surfaces an upgrade refusal without retrying the mint", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          {
            code: "UPGRADE_REQUIRED",
            message: "Upgrade the SDK.",
            details: { code: "client_upgrade_required" },
          },
          { status: 426 }
        )
      );
    const client = new McpjamLeaseClient({
      baseUrl: "https://app.example.com",
      apiKey: "sk_test",
      project: "default",
      model: "openai/gpt-5",
      fetchImpl,
    });
    await expect(client.getLease()).rejects.toMatchObject({
      code: "UPGRADE_REQUIRED",
      status: 426,
      message: "Upgrade the SDK.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
