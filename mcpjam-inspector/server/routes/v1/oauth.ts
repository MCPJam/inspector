/**
 * Public v1 OAuth surface: the deprecated token import.
 *
 * `POST .../oauth/import-tokens` is an alias for "upload to my default
 * account" until its sunset. It takes its old body and answers its old
 * response, and in between it is the accounts API's upload: the same token
 * checks and the same backend call, with `account: { default: true }`. An
 * account it creates is hosted-only; an existing default it writes into keeps
 * whatever rule it had, so a caller who also uses that account locally is not
 * cut off by the alias.
 *
 * `serverUrl` still travels so the backend can refuse one that is not the
 * server's saved URL. `authorizationServerUrl`, `oauthResourceUrl` and
 * `tokens.id_token` are dropped without an error, because existing callers
 * send them and the API takes neither a caller's URLs nor ID tokens.
 */
import { Hono } from "hono";
import { z } from "zod";
import { readJsonObjectBody } from "./adapter.js";
import { markDeprecated } from "./deprecation.js";
import { v1Resource } from "./envelope.js";
import {
  clientFields,
  parseUpload,
  tokenFields,
  uploadAccountTokens,
} from "./server-accounts.js";

const oauth = new Hono();

// Set at release to the day the accounts API ships. The alias is removed 90
// days later, and its Sunset header says when.
const ACCOUNTS_API_RELEASED_AT = Date.UTC(2026, 10, 11);
const IMPORT_TOKENS_SUNSET = new Date(
  ACCOUNTS_API_RELEASED_AT + 90 * 24 * 60 * 60 * 1000,
).toUTCString();

// Lenient, unlike `PUT .../accounts/:account`: unknown keys are stripped,
// which is how the old body's extra fields drop out.
const importTokensSchema = z.object({
  serverUrl: z.string().min(1),
  clientInformation: z.object(clientFields),
  tokens: z.object(tokenFields),
});

oauth.post(
  "/projects/:projectId/servers/:serverId/oauth/import-tokens",
  async (c) => {
    markDeprecated(
      c,
      "/api/v1/projects/{projectId}/servers/{serverId}/accounts",
    );
    c.header("Sunset", IMPORT_TOKENS_SUNSET);
    const body = parseUpload(importTokensSchema, await readJsonObjectBody(c));
    const { expiresAt } = await uploadAccountTokens(c, {
      ...body,
      account: { default: true },
      hostedOnly: "whenCreated",
    });
    return v1Resource(c, { imported: true, expiresAt });
  },
);

export default oauth;
