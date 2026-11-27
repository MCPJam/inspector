/**
 * The accounts an eval run connected with, as `/api/v1` returns them: the
 * `accounts` field of the run DTO.
 *
 * The backend stores them as `accountsAtRun` and removes each email the
 * caller may not see before the run reaches this server: a project account's
 * email is visible to every project member, a personal account's only to the
 * person who started the run, which for an API key is the key's owner. This
 * module never decides who sees an email. It forwards one when the backend
 * returned it and never adds one.
 *
 * Field by field rather than a spread, like the rest of the run DTO. The
 * stored record also holds the connection's profile id (already in
 * `identity.subject` when the profile answered) and an XAA subject that
 * repeats `name`, and a field added upstream must not reach the public API
 * without someone deciding it should.
 */

import { z } from "zod";

export const runAccountsSchema = z.array(z.object({
  serverId: z.string().min(1),
  accountId: z.string().min(1),
}).strict()).min(1).max(32);

type PublicEvalAccountSelections = z.infer<typeof runAccountsSchema>;
export function accountSelectionsForStorage(accounts: PublicEvalAccountSelections | null) {
  return accounts?.map(({ serverId, accountId }) => ({
    serverId, connectionId: accountId,
  })) ?? null;
}

export function accountSelectionsForRead(accounts: unknown) {
  return runAccountsSchema.safeParse(Array.isArray(accounts) ? accounts.map((row: unknown) => {
    if (!row || typeof row !== "object" || !("serverId" in row) || !("connectionId" in row)) return row;
    return { serverId: row.serverId, accountId: row.connectionId };
  }) : accounts).data;
}

type IdentitySource = "profile" | "token";

export interface RunAccountIdentityDto {
  source: IdentitySource;
  name?: string;
  subject?: string;
  issuer?: string;
  email?: string;
  emailSource?: IdentitySource;
}

export interface RunAccountDto {
  cases?: Array<{
    testCaseId: string;
    source: "case" | "run" | "suite" | "default";
  }>;
  serverId: string;
  /** The account's id in the server accounts API. */
  accountId?: string;
  name: string;
  kind: "personal" | "project" | "xaa";
  reviewer?: true;
  tokenUploaded?: true;
  tokenStoredBy?: string;
  tokenStoredAt?: number;
  tokenExpiresAt?: number;
  identity?: RunAccountIdentityDto;
}

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * The accounts API's spelling (`ServerAccount.kind`): a person's own account
 * is `personal` and a shared server's is `project`. `undefined` for a kind
 * this server does not know, which drops the whole list (see below).
 */
function publicKind(kind: unknown): RunAccountDto["kind"] | undefined {
  if (kind === "account") return "personal";
  if (kind === "shared") return "project";
  if (kind === "xaa") return "xaa";
  return undefined;
}

function identitySource(value: unknown): IdentitySource | undefined {
  return value === "profile" || value === "token" ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function time(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toIdentityDto(raw: unknown): RunAccountIdentityDto | undefined {
  if (!isFields(raw)) return undefined;
  const source = identitySource(raw.source);
  if (!source) return undefined;
  const name = text(raw.name);
  const subject = text(raw.subject);
  const issuer = text(raw.issuer);
  const email = text(raw.email);
  const emailSource = email ? identitySource(raw.emailSource) : undefined;
  if (!name && !subject && !issuer && !email) return undefined;
  return {
    source,
    ...(name ? { name } : {}),
    ...(subject ? { subject } : {}),
    ...(issuer ? { issuer } : {}),
    ...(email ? { email } : {}),
    ...(emailSource ? { emailSource } : {}),
  };
}

function toAccountDto(raw: unknown): RunAccountDto | undefined {
  if (!isFields(raw)) return undefined;
  const serverId = text(raw.serverId);
  const name = text(raw.name);
  const kind = publicKind(raw.kind);
  if (!serverId || !name || !kind) return undefined;
  const accountId = text(raw.connectionId);
  const tokenStoredBy = text(raw.tokenStoredBy);
  const tokenStoredAt = time(raw.tokenStoredAt);
  const tokenExpiresAt = time(raw.tokenExpiresAt);
  const identity = toIdentityDto(raw.identity);
  const cases: NonNullable<RunAccountDto["cases"]> = [];
  if (Array.isArray(raw.cases)) {
    for (const entry of raw.cases) {
      if (!isFields(entry)) return undefined;
      const testCaseId = text(entry.testCaseId);
      const source = entry.source;
      if (
        !testCaseId ||
        (source !== "case" && source !== "run" && source !== "suite" && source !== "default")
      ) return undefined;
      cases.push({ testCaseId, source });
    }
  }
  return {
    serverId,
    ...(accountId ? { accountId } : {}),
    name,
    kind,
    ...(raw.reviewer === true ? { reviewer: true as const } : {}),
    ...(raw.tokenUploaded === true ? { tokenUploaded: true as const } : {}),
    ...(tokenStoredBy ? { tokenStoredBy } : {}),
    ...(tokenStoredAt !== undefined ? { tokenStoredAt } : {}),
    ...(tokenExpiresAt !== undefined ? { tokenExpiresAt } : {}),
    ...(identity ? { identity } : {}),
    ...(cases.length ? { cases } : {}),
  };
}

/**
 * `{ accounts }` for a run that recorded its accounts, else nothing.
 *
 * OMITTED, never defaulted, when the run recorded none: a run from before
 * accounts were recorded says nothing about them, and `[]` would claim it
 * used none. A recorded empty list is passed on as `[]`, because that claim
 * is the run's own.
 *
 * An entry this server cannot read (an unknown `kind`, no server or name)
 * drops the whole list. A list missing one account would name the wrong set
 * of accounts as the ones the run used.
 */
export function toRunAccountsProjection(raw: unknown): {
  accounts?: RunAccountDto[];
} {
  if (!Array.isArray(raw)) return {};
  const accounts: RunAccountDto[] = [];
  for (const entry of raw) {
    const account = toAccountDto(entry);
    if (!account) return {};
    accounts.push(account);
  }
  return { accounts };
}
