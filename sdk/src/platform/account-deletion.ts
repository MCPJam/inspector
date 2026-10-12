import { z } from "zod";

export const accountDeletionCapabilitiesSchema = z.object({
  available: z.boolean(),
  protocolVersion: z.literal(1),
  scopeTypes: z.tuple([z.literal("account")]),
  canCancel: z.literal(false),
});
export const accountDeletionInspectionSchema = z.object({
  ready: z.boolean(),
  checkpointSha256: z.string().regex(/^[a-f0-9]{64}$/),
  identityCoverageReady: z.boolean(),
  obligations: z.array(
    z.object({
      code: z.enum([
        "transfer_ownership",
        "ownership_unresolved",
        "scope_deleting",
        "inventory_limit",
      ]),
      organizationId: z.string().optional(),
    })
  ),
});
export const accountDeletionReceiptSchema = z.object({
  requestId: z.string(),
  scope: z.object({ type: z.literal("account"), id: z.string() }),
  state: z.string(),
  acceptedAt: z.number(),
  dueAt: z.number(),
  canCancel: z.literal(false),
  journalConfirmedAt: z.number().nullable(),
  liveDataDeletedAt: z.number().nullable(),
  closedAt: z.number().nullable(),
});
export type AccountDeletionCapabilities = z.infer<
  typeof accountDeletionCapabilitiesSchema
>;
export type AccountDeletionInspection = z.infer<
  typeof accountDeletionInspectionSchema
>;
export type AccountDeletionReceipt = z.infer<
  typeof accountDeletionReceiptSchema
>;
export type AccountDeletionRecovery = {
  receiptSecret: string;
  idempotencyKey: string;
};

/** Safe errors contain neither a provider message nor the receipt bearer. */
export class AccountDeletionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super("The account deletion request could not be verified.");
  }
}

type Config = {
  baseUrl: string;
  authenticatedFetch: typeof fetch;
  publicFetch?: typeof fetch;
};
export class AccountDeletionClient {
  constructor(private readonly config: Config) {}

  private async failureCode(response: Response): Promise<string> {
    try {
      const error = z
        .object({ code: z.string().regex(/^ACCOUNT_[A-Z_]+$/) })
        .safeParse(await response.json());
      return error.success
        ? error.data.code
        : "ACCOUNT_DELETION_TRANSPORT_FAILED";
    } catch {
      return "ACCOUNT_DELETION_TRANSPORT_FAILED";
    }
  }

  private async call(
    path: string,
    body?: unknown,
    publicRead = false
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await (
        publicRead
          ? (this.config.publicFetch ?? fetch)
          : this.config.authenticatedFetch
      )(`${this.config.baseUrl}/${path}`, {
        method: body === undefined ? "GET" : "POST",
        cache: "no-store",
        credentials: publicRead ? "omit" : "same-origin",
        headers:
          body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AccountDeletionError(0, "ACCOUNT_DELETION_TRANSPORT_FAILED");
    }
    if (!response.ok) {
      throw new AccountDeletionError(
        response.status,
        await this.failureCode(response)
      );
    }
    try {
      return await response.json();
    } catch {
      throw new AccountDeletionError(0, "ACCOUNT_DELETION_RESPONSE_INVALID");
    }
  }

  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success)
      throw new AccountDeletionError(0, "ACCOUNT_DELETION_RESPONSE_INVALID");
    return result.data;
  }
  async capabilities(): Promise<AccountDeletionCapabilities> {
    return this.parse(
      accountDeletionCapabilitiesSchema,
      await this.call("capabilities")
    );
  }
  async inspect(): Promise<AccountDeletionInspection> {
    return this.parse(
      accountDeletionInspectionSchema,
      await this.call("inspect")
    );
  }
  async request(
    args: AccountDeletionRecovery & { ownershipCheckpointSha256: string }
  ): Promise<AccountDeletionReceipt> {
    if (!(await this.capabilities()).available)
      throw new AccountDeletionError(503, "ACCOUNT_DELETION_UNAVAILABLE");
    return this.parse(
      accountDeletionReceiptSchema,
      await this.call("request", args)
    );
  }
  async receipt(
    args: AccountDeletionRecovery
  ): Promise<AccountDeletionReceipt | null> {
    return this.parse(
      accountDeletionReceiptSchema.nullable(),
      await this.call("receipt", args, true)
    );
  }
}
