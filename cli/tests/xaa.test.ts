import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildXaaConfig,
  parseAssertionFormat,
  parseClientAuth,
  parseRegistration,
  printRegistrationNotes,
  redactXaaResult,
  resolveConfidentialCimd,
} from "../src/commands/xaa.js";
import { CliError } from "../src/lib/output.js";
import type { XaaFlowResult } from "@mcpjam/sdk";

const base = {
  url: "https://mcp.example.com/mcp",
  issuerBaseUrl: "https://issuer.example.com/api/mcp",
  sub: "user-1",
  clientId: "client-1",
};

// Dynamic-strategy runs derive their identity, so they carry no client-id.
const dynBase = {
  url: "https://mcp.example.com/mcp",
  issuerBaseUrl: "https://issuer.example.com/api/mcp",
  sub: "user-1",
};

test("buildXaaConfig maps the required fields", () => {
  const config = buildXaaConfig({ ...base });

  assert.equal(config.serverUrl, "https://mcp.example.com/mcp");
  assert.equal(config.issuerBaseUrl, "https://issuer.example.com/api/mcp");
  assert.equal(config.subject, "user-1");
  assert.equal(config.clientId, "client-1");
  assert.equal(config.httpsOnly, false);
});

test("buildXaaConfig maps optional fields and the global timeout", () => {
  const config = buildXaaConfig(
    {
      ...base,
      authzServerIssuer: "https://auth.example.com",
      tokenEndpoint: "https://auth.example.com/oauth/token",
      email: "u@example.com",
      clientSecret: "secret-1",
      tokenEndpointAuthMethod: "client_secret_basic",
      scopes: "read:tools write:tools",
      httpsOnly: true,
    },
    12_345
  );

  assert.equal(config.authzServerIssuer, "https://auth.example.com");
  assert.equal(config.tokenEndpoint, "https://auth.example.com/oauth/token");
  assert.equal(config.email, "u@example.com");
  assert.equal(config.clientSecret, "secret-1");
  assert.equal(config.tokenEndpointAuthMethod, "client_secret_basic");
  assert.equal(config.scope, "read:tools write:tools");
  assert.equal(config.timeoutMs, 12_345);
  assert.equal(config.httpsOnly, true);
});

test("buildXaaConfig omits optional fields left unset", () => {
  const config = buildXaaConfig({ ...base });

  assert.equal(config.authzServerIssuer, undefined);
  assert.equal(config.tokenEndpoint, undefined);
  assert.equal(config.email, undefined);
  assert.equal(config.clientSecret, undefined);
  assert.equal(config.scope, undefined);
});

test("buildXaaConfig trims whitespace and treats blank optionals as unset", () => {
  const config = buildXaaConfig({
    ...base,
    url: "  https://mcp.example.com/mcp  ",
    sub: "  user-1  ",
    email: "   ",
    scopes: "   ",
  });

  assert.equal(config.serverUrl, "https://mcp.example.com/mcp");
  assert.equal(config.subject, "user-1");
  assert.equal(config.email, undefined);
  assert.equal(config.scope, undefined);
});

test("parseAssertionFormat accepts the known formats", () => {
  assert.equal(parseAssertionFormat("oidc"), "oidc");
  assert.equal(parseAssertionFormat("saml"), "saml");
});

test("parseAssertionFormat rejects an unknown format", () => {
  assert.throws(
    () => parseAssertionFormat("wsfed"),
    (error: unknown) =>
      error instanceof CliError &&
      /--assertion-format must be oidc or saml/.test(error.message)
  );
});

test("buildXaaConfig leaves both identity axes unset by default (oidc preset)", () => {
  const unset = buildXaaConfig({ ...base });
  assert.equal(unset.identityAssertionFormat, undefined);
  assert.equal(unset.subjectIdentifierFormat, undefined);
  assert.equal("identityAssertionFormat" in unset, false);
  assert.equal("subjectIdentifierFormat" in unset, false);

  // Explicit --assertion-format oidc is identical to omitting the flag: the
  // SDK's own defaults ("oidc" / "oauth-sub") apply.
  const explicit = buildXaaConfig({ ...base, assertionFormat: "oidc" });
  assert.equal("identityAssertionFormat" in explicit, false);
  assert.equal("subjectIdentifierFormat" in explicit, false);
});

test("buildXaaConfig maps the saml preset onto both identity axes", () => {
  const config = buildXaaConfig({ ...base, assertionFormat: "saml" });

  assert.equal(config.identityAssertionFormat, "saml");
  assert.equal(config.subjectIdentifierFormat, "saml-nameid");
});

test("buildXaaConfig rejects an invalid server URL", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, url: "not-a-url" }),
    (error: unknown) =>
      error instanceof CliError && /Invalid server URL/.test(error.message)
  );
});

test("buildXaaConfig rejects an invalid issuer base URL", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, issuerBaseUrl: "nope" }),
    (error: unknown) =>
      error instanceof CliError && /Invalid issuer base URL/.test(error.message)
  );
});

test("buildXaaConfig rejects an invalid authorization server issuer", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, authzServerIssuer: "bad" }),
    (error: unknown) =>
      error instanceof CliError &&
      /Invalid authorization server issuer/.test(error.message)
  );
});

test("buildXaaConfig rejects an invalid token endpoint", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, tokenEndpoint: "bad" }),
    (error: unknown) =>
      error instanceof CliError && /Invalid token endpoint/.test(error.message)
  );
});

test("buildXaaConfig rejects a blank subject", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, sub: "   " }),
    (error: unknown) =>
      error instanceof CliError && /--sub must not be empty/.test(error.message)
  );
});

test("redactXaaResult masks the ID-JAG token and issued bearer tokens", () => {
  const result = {
    completed: true,
    issuer: "https://issuer.example.com/api/mcp/xaa",
    idJag: {
      token: "eyJraWQ.secret.signature",
      claims: { sub: "user-1", aud: "https://auth.example.com" },
      verified: true,
    },
    redemption: {
      status: 200,
      tokenIssued: true,
      body: {
        access_token: "at-super-secret",
        refresh_token: "rt-super-secret",
        id_token: "idt-super-secret",
        token_type: "Bearer",
        expires_in: 300,
        // A nested/reflected secret the recursive redactor must also catch.
        extra: { access_token: "nested-secret" },
        // The AS reflecting the raw ID-JAG back under non-secret field names.
        assertion: "eyJraWQ.secret.signature",
        error_description: "invalid assertion eyJraWQ.secret.signature",
      },
    },
    mcp: { status: 200, ok: true },
    steps: [],
  } as unknown as XaaFlowResult;

  const redacted = redactXaaResult(result);

  assert.equal(redacted.idJag?.token, "[REDACTED]");
  // Decoded claims stay visible for inspection.
  assert.deepEqual(redacted.idJag?.claims, {
    sub: "user-1",
    aud: "https://auth.example.com",
  });
  const body = redacted.redemption?.body as Record<string, unknown>;
  assert.equal(body.access_token, "[REDACTED]");
  assert.equal(body.refresh_token, "[REDACTED]");
  assert.equal(body.id_token, "[REDACTED]");
  assert.equal(
    (body.extra as Record<string, unknown>).access_token,
    "[REDACTED]"
  );
  // A reflected raw ID-JAG is scrubbed even under non-secret field names.
  assert.equal(body.assertion, "[REDACTED]");
  assert.equal(body.error_description, "invalid assertion [REDACTED]");
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.expires_in, 300);
  // The original result is not mutated.
  assert.equal(result.idJag?.token, "eyJraWQ.secret.signature");
  assert.equal(
    (result.redemption?.body as Record<string, unknown>).access_token,
    "at-super-secret"
  );
});

test("redactXaaResult preserves the secret-free registration diagnostics", () => {
  const result = {
    completed: true,
    issuer: "https://issuer.example.com/api/mcp/xaa",
    registration: {
      strategy: "dcr",
      clientId: "client_generated_123",
      reused: false,
      // `code` is a redacted key and the message mentions "Bearer grant" — both
      // would be false-positive-scrubbed without the verbatim restore.
      warnings: [
        {
          code: "token_exchange_grant_not_echoed",
          message: "The registration echoed the JWT Bearer grant but not …",
        },
      ],
    },
    steps: [],
  } as unknown as XaaFlowResult;

  const redacted = redactXaaResult(result);

  assert.equal(redacted.registration?.clientId, "client_generated_123");
  assert.equal(
    redacted.registration?.warnings[0].code,
    "token_exchange_grant_not_echoed"
  );
  assert.match(redacted.registration?.warnings[0].message ?? "", /JWT Bearer grant/);
});

test("buildXaaConfig requires --client-id for the preregistered strategy", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, clientId: "   " }),
    (error: unknown) =>
      error instanceof CliError &&
      /--client-id is required for the preregistered strategy/.test(error.message)
  );
});

// --- registration strategies --------------------------------------------

test("parseRegistration accepts the three strategies and rejects others", () => {
  assert.equal(parseRegistration("preregistered"), "preregistered");
  assert.equal(parseRegistration("dcr"), "dcr");
  assert.equal(parseRegistration("cimd"), "cimd");
  assert.throws(
    () => parseRegistration("bogus"),
    (error: unknown) =>
      error instanceof CliError &&
      /--registration must be preregistered, dcr, or cimd/.test(error.message)
  );
});

test("buildXaaConfig leaves registrationStrategy unset for the default (preregistered)", () => {
  const config = buildXaaConfig({ ...base });
  assert.equal(config.registrationStrategy, undefined);
});

test("buildXaaConfig maps --registration dcr with no client identity", () => {
  const config = buildXaaConfig({ ...dynBase, registration: "dcr" });
  assert.equal(config.registrationStrategy, "dcr");
  assert.equal(config.clientId, undefined);
  assert.equal(config.clientSecret, undefined);
});

test("buildXaaConfig maps --registration cimd and --client-metadata-url", () => {
  const config = buildXaaConfig({
    ...dynBase,
    registration: "cimd",
    clientMetadataUrl: "https://client.example.com/meta.json",
  });
  assert.equal(config.registrationStrategy, "cimd");
  assert.equal(config.clientIdMetadataUrl, "https://client.example.com/meta.json");
  assert.equal(config.clientId, undefined);
});

test("buildXaaConfig allows --authz-server-issuer with dcr/cimd", () => {
  const config = buildXaaConfig({
    ...dynBase,
    registration: "dcr",
    authzServerIssuer: "https://auth.example.com",
  });
  assert.equal(config.registrationStrategy, "dcr");
  assert.equal(config.authzServerIssuer, "https://auth.example.com");
});

test("buildXaaConfig rejects --client-id with a dynamic strategy", () => {
  assert.throws(
    () => buildXaaConfig({ ...base, registration: "dcr" }),
    (error: unknown) =>
      error instanceof CliError &&
      /--client-id must not be set with --registration dcr/.test(error.message)
  );
});

test("buildXaaConfig rejects --client-secret with a dynamic strategy", () => {
  assert.throws(
    () => buildXaaConfig({ ...dynBase, registration: "cimd", clientSecret: "s" }),
    (error: unknown) =>
      error instanceof CliError &&
      /--client-secret must not be set with --registration cimd/.test(error.message)
  );
});

test("buildXaaConfig rejects --token-endpoint-auth-method with a dynamic strategy", () => {
  assert.throws(
    () =>
      buildXaaConfig({
        ...dynBase,
        registration: "dcr",
        tokenEndpointAuthMethod: "client_secret_post",
      }),
    (error: unknown) =>
      error instanceof CliError &&
      /--token-endpoint-auth-method must not be set with --registration dcr/.test(
        error.message
      )
  );
});

test("buildXaaConfig rejects --token-endpoint with a dynamic strategy", () => {
  assert.throws(
    () =>
      buildXaaConfig({
        ...dynBase,
        registration: "dcr",
        tokenEndpoint: "https://auth.example.com/oauth/token",
      }),
    (error: unknown) =>
      error instanceof CliError &&
      /--token-endpoint must not be set with --registration dcr/.test(
        error.message
      )
  );
});

test("buildXaaConfig rejects --client-metadata-url without cimd", () => {
  assert.throws(
    () =>
      buildXaaConfig({
        ...base,
        clientMetadataUrl: "https://client.example.com/meta.json",
      }),
    (error: unknown) =>
      error instanceof CliError &&
      /--client-metadata-url is only valid with --registration cimd/.test(
        error.message
      )
  );
});

test("buildXaaConfig rejects a non-positive timeout", () => {
  assert.throws(
    () => buildXaaConfig({ ...base }, 0),
    (error: unknown) =>
      error instanceof CliError &&
      /--timeout must be a positive/.test(error.message)
  );
});

test("buildXaaConfig requires a secret for confidential client auth", () => {
  assert.throws(
    () =>
      buildXaaConfig({
        ...base,
        tokenEndpointAuthMethod: "client_secret_basic",
      }),
    (error: unknown) =>
      error instanceof CliError && /requires --client-secret/.test(error.message),
  );
});

test("printRegistrationNotes strips control chars from a hostile RAS client_id", () => {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (
    s: string,
  ) => {
    captured += s;
    return true;
  };
  try {
    printRegistrationNotes({
      completed: false,
      issuer: "https://issuer.example.com/api/mcp/xaa",
      registration: {
        strategy: "dcr",
        clientId: "evil\u001b[2Kspoof\nSECOND",
        reused: false,
        warnings: [],
      },
      steps: [],
    } as unknown as XaaFlowResult);
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
  assert.ok(!captured.includes("\u001b"), "escape sequence must be stripped");
  assert.match(captured, /"evil\[2KspoofSECOND"/);
});

// --- confidential CIMD (--client-auth private-key-jwt) -------------------

test("parseClientAuth accepts none and both private-key-jwt spellings", () => {
  assert.equal(parseClientAuth("none"), "none");
  assert.equal(parseClientAuth("private-key-jwt"), "private_key_jwt");
  assert.equal(parseClientAuth("private_key_jwt"), "private_key_jwt");
});

test("parseClientAuth rejects an unknown method", () => {
  assert.throws(
    () => parseClientAuth("client_secret_basic"),
    (error: unknown) =>
      error instanceof CliError &&
      /--client-auth must be none or private-key-jwt/.test(error.message)
  );
});

test("buildXaaConfig maps --client-auth private-key-jwt with cimd", () => {
  const config = buildXaaConfig({
    ...dynBase,
    registration: "cimd",
    clientAuth: "private_key_jwt",
  });
  assert.equal(config.registrationStrategy, "cimd");
  assert.equal(config.clientAuth, "private_key_jwt");
  // The reflector URL is computed later, in resolveConfidentialCimd.
  assert.equal(config.clientIdMetadataUrl, undefined);
});

test("buildXaaConfig omits clientAuth for the default (none)", () => {
  const config = buildXaaConfig({ ...dynBase, registration: "cimd" });
  assert.equal(config.clientAuth, undefined);
});

test("buildXaaConfig rejects --client-auth private-key-jwt without cimd", () => {
  assert.throws(
    () =>
      buildXaaConfig({
        ...dynBase,
        registration: "dcr",
        clientAuth: "private_key_jwt",
      }),
    (error: unknown) =>
      error instanceof CliError &&
      /--client-auth private-key-jwt is only valid with --registration cimd/.test(
        error.message
      )
  );
});

test("buildXaaConfig rejects private-key-jwt combined with --client-metadata-url", () => {
  assert.throws(
    () =>
      buildXaaConfig({
        ...dynBase,
        registration: "cimd",
        clientAuth: "private_key_jwt",
        clientMetadataUrl: "https://client.example.com/meta.json",
      }),
    (error: unknown) =>
      error instanceof CliError &&
      /--client-metadata-url cannot be combined with --client-auth private-key-jwt/.test(
        error.message
      )
  );
});

test("buildXaaConfig rejects --cimd-metadata-origin without private-key-jwt", () => {
  assert.throws(
    () =>
      buildXaaConfig({
        ...dynBase,
        registration: "cimd",
        cimdMetadataOrigin: "http://localhost:6274",
      }),
    (error: unknown) =>
      error instanceof CliError &&
      /--cimd-metadata-origin is only valid with --client-auth private-key-jwt/.test(
        error.message
      )
  );
});

test("resolveConfidentialCimd computes the hosted reflector URL from the client key", () => {
  const keyDir = mkdtempSync(path.join(os.tmpdir(), "xaa-cli-cimd-"));
  const prevKeyDir = process.env.XAA_IDP_KEY_DIR;
  process.env.XAA_IDP_KEY_DIR = keyDir;
  try {
    const config = buildXaaConfig({
      ...dynBase,
      registration: "cimd",
      clientAuth: "private_key_jwt",
    });
    resolveConfidentialCimd(config, true);
    assert.match(
      config.clientIdMetadataUrl ?? "",
      /^https:\/\/app\.mcpjam\.com\/\.well-known\/oauth\/xaa-cimd\//
    );
    // A hosted HTTPS reflector never needs the loopback carve-out.
    assert.equal(config.allowLoopbackClientMetadata, undefined);
  } finally {
    if (prevKeyDir === undefined) delete process.env.XAA_IDP_KEY_DIR;
    else process.env.XAA_IDP_KEY_DIR = prevKeyDir;
    rmSync(keyDir, { recursive: true, force: true });
  }
});

test("resolveConfidentialCimd opts into the loopback carve-out for an http localhost origin", () => {
  const keyDir = mkdtempSync(path.join(os.tmpdir(), "xaa-cli-cimd-"));
  const prevKeyDir = process.env.XAA_IDP_KEY_DIR;
  process.env.XAA_IDP_KEY_DIR = keyDir;
  try {
    const config = buildXaaConfig({
      ...dynBase,
      registration: "cimd",
      clientAuth: "private_key_jwt",
      cimdMetadataOrigin: "http://localhost:6274",
    });
    resolveConfidentialCimd(config, true);
    assert.match(
      config.clientIdMetadataUrl ?? "",
      /^http:\/\/localhost:6274\/\.well-known\/oauth\/xaa-cimd\//
    );
    assert.equal(config.allowLoopbackClientMetadata, true);
  } finally {
    if (prevKeyDir === undefined) delete process.env.XAA_IDP_KEY_DIR;
    else process.env.XAA_IDP_KEY_DIR = prevKeyDir;
    rmSync(keyDir, { recursive: true, force: true });
  }
});

test("resolveConfidentialCimd rejects an http loopback origin under --https-only", () => {
  const keyDir = mkdtempSync(path.join(os.tmpdir(), "xaa-cli-cimd-"));
  const prevKeyDir = process.env.XAA_IDP_KEY_DIR;
  process.env.XAA_IDP_KEY_DIR = keyDir;
  try {
    const config = buildXaaConfig({
      ...dynBase,
      registration: "cimd",
      clientAuth: "private_key_jwt",
      cimdMetadataOrigin: "http://localhost:6274",
      httpsOnly: true,
    });
    assert.throws(
      () => resolveConfidentialCimd(config, true),
      (error: unknown) =>
        error instanceof CliError &&
        /--cimd-metadata-origin is an http loopback URL, but --https-only is set/.test(
          error.message
        )
    );
  } finally {
    if (prevKeyDir === undefined) delete process.env.XAA_IDP_KEY_DIR;
    else process.env.XAA_IDP_KEY_DIR = prevKeyDir;
    rmSync(keyDir, { recursive: true, force: true });
  }
});
