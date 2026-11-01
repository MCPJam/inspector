import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolveDeployment,
  type DeploymentCredential,
} from "../src/deployment/resolve.js";

const A = "https://a.example.test";
const B = "https://b.example.test";
const CLOUD = "https://app.mcpjam.com";

let directory: string;
const loginFiles: Record<string, string> = {};

/** A saved login made against `apiUrl`, or one that recorded no server. */
async function savedLogin(name: string, apiUrl?: string): Promise<void> {
  const path = join(directory, `${name}.json`);
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      issuer: "https://login.example.test",
      clientId: "client",
      tokenEndpoint: "https://login.example.test/token",
      accessToken: "saved-token",
      ...(apiUrl ? { apiUrl } : {}),
    })
  );
  loginFiles[name] = path;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "mcpjam-deployment-"));
  loginFiles["none-saved"] = join(directory, "never-written.json");
  await savedLogin("for-b", `${B}/api/v1`);
  await savedLogin("for-b-spelled", "HTTPS://B.Example.TEST:443/api/v1/");
  await savedLogin("unrecorded");
  await savedLogin("unparsable", "ftp://b.example.test/api/v1");
  await savedLogin("with-query", `${B}/api/v1?tenant=acme`);
  await savedLogin("not-a-url", "b.example.test");
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

type Row = {
  name: string;
  flag?: string;
  env?: NodeJS.ProcessEnv;
  login?:
    | "none-saved"
    | "for-b"
    | "for-b-spelled"
    | "unrecorded"
    | "unparsable"
    | "with-query"
    | "not-a-url";
  credential: DeploymentCredential;
  expect:
    { baseUrl: string; source: string } | { code: string; message?: RegExp };
};

const rows: Row[] = [
  {
    name: "nothing named, key: MCPJam Cloud",
    credential: "api-key",
    expect: { baseUrl: CLOUD, source: "default" },
  },
  {
    name: "nothing named, no saved login: MCPJam Cloud",
    login: "none-saved",
    credential: "oauth",
    expect: { baseUrl: CLOUD, source: "default" },
  },
  {
    name: "flag",
    flag: `${A}/api/v1`,
    credential: "api-key",
    expect: { baseUrl: A, source: "flag" },
  },
  {
    name: "MCPJAM_API_URL",
    env: { MCPJAM_API_URL: `${A}/api/v1` },
    credential: "api-key",
    expect: { baseUrl: A, source: "env" },
  },
  {
    name: "MCPJAM_BASE_URL, the older format",
    env: { MCPJAM_BASE_URL: A },
    credential: "api-key",
    expect: { baseUrl: A, source: "env" },
  },
  {
    name: "both variables, one server spelled two ways",
    env: {
      MCPJAM_API_URL: `${A}/api/v1/`,
      MCPJAM_BASE_URL: "HTTPS://A.EXAMPLE.TEST:443",
    },
    credential: "api-key",
    expect: { baseUrl: A, source: "env" },
  },
  {
    name: "both variables, two servers",
    env: { MCPJAM_API_URL: `${A}/api/v1`, MCPJAM_BASE_URL: B },
    credential: "api-key",
    expect: {
      code: "DEPLOYMENT_CONFLICT",
      message:
        /MCPJAM_API_URL .* and MCPJAM_BASE_URL .* name different MCPJam servers/,
    },
  },
  {
    name: "two servers in the variables stop even when a flag is given",
    flag: `${A}/api/v1`,
    env: { MCPJAM_API_URL: `${A}/api/v1`, MCPJAM_BASE_URL: B },
    credential: "api-key",
    expect: { code: "DEPLOYMENT_CONFLICT" },
  },
  {
    name: "flag over the variables",
    flag: `${A}/api/v1`,
    env: { MCPJAM_API_URL: `${B}/api/v1` },
    credential: "api-key",
    expect: { baseUrl: A, source: "flag" },
  },
  {
    name: "saved login is the credential: its server",
    login: "for-b",
    credential: "oauth",
    expect: { baseUrl: B, source: "oauth" },
  },
  {
    name: "saved login for B, flag for A",
    flag: `${A}/api/v1`,
    login: "for-b",
    credential: "oauth",
    expect: {
      code: "LOGIN_DEPLOYMENT_MISMATCH",
      message:
        /^Your saved login is for https:\/\/b\.example\.test\/api\/v1; this command targets https:\/\/a\.example\.test\/api\/v1\. Run `mcpjam cloud login --api-url https:\/\/a\.example\.test\/api\/v1`/,
    },
  },
  {
    name: "saved login for B, variable for A",
    env: { MCPJAM_API_URL: `${A}/api/v1` },
    login: "for-b",
    credential: "oauth",
    expect: {
      code: "LOGIN_DEPLOYMENT_MISMATCH",
      message: /Run `mcpjam cloud login` to sign in there/,
    },
  },
  {
    name: "saved login for B, flag for B spelled differently",
    flag: "https://B.EXAMPLE.TEST/api/v1/",
    login: "for-b-spelled",
    credential: "oauth",
    expect: { baseUrl: B, source: "flag" },
  },
  {
    name: "saved login for B, key and flag for A: the key goes to A",
    flag: `${A}/api/v1`,
    login: "for-b",
    credential: "api-key",
    expect: { baseUrl: A, source: "flag" },
  },
  {
    name: "saved login for B, key and nothing named: MCPJam Cloud",
    login: "for-b",
    credential: "api-key",
    expect: { baseUrl: CLOUD, source: "default" },
  },
  {
    name: "login that recorded no server is an MCPJam Cloud login",
    login: "unrecorded",
    credential: "oauth",
    expect: { baseUrl: CLOUD, source: "oauth" },
  },
  {
    name: "login that recorded no server, flag for A",
    flag: `${A}/api/v1`,
    login: "unrecorded",
    credential: "oauth",
    expect: { code: "LOGIN_DEPLOYMENT_MISMATCH" },
  },
  {
    name: "login that recorded no server, flag for MCPJam Cloud",
    flag: `${CLOUD}/api/v1`,
    login: "unrecorded",
    credential: "oauth",
    expect: { baseUrl: CLOUD, source: "flag" },
  },
  {
    name: "login whose recorded server is not an http(s) address is refused, not sent to Cloud",
    login: "unparsable",
    credential: "oauth",
    expect: {
      code: "LOGIN_DEPLOYMENT_MISMATCH",
      message: /^Your saved login records the server "ftp:\/\/b\.example\.test\/api\/v1"/,
    },
  },
  {
    name: "login an older CLI made with a query is refused, the query masked",
    login: "with-query",
    credential: "oauth",
    expect: {
      code: "LOGIN_DEPLOYMENT_MISMATCH",
      message: /^Your saved login records the server "https:\/\/b\.example\.test\/api\/v1\?\*\*\*", which is not a usable server address\. Run `mcpjam cloud login`/,
    },
  },
  {
    name: "login whose recorded server is not a URL is refused without repeating it",
    login: "not-a-url",
    credential: "oauth",
    expect: {
      code: "LOGIN_DEPLOYMENT_MISMATCH",
      message: /^Your saved login records a server that is not a usable server address\./,
    },
  },
  {
    name: "signing in again is never blocked by an unusable recorded server",
    login: "with-query",
    credential: "none",
    expect: { baseUrl: CLOUD, source: "default" },
  },
  {
    name: "an API key is never blocked by an unusable recorded server",
    login: "with-query",
    credential: "api-key",
    expect: { baseUrl: CLOUD, source: "default" },
  },
  {
    name: "signing in reuses the saved login's server",
    login: "for-b",
    credential: "none",
    expect: { baseUrl: B, source: "oauth" },
  },
  {
    name: "signing in elsewhere is never blocked by the saved login",
    flag: `${A}/api/v1`,
    login: "for-b",
    credential: "none",
    expect: { baseUrl: A, source: "flag" },
  },
  {
    name: "an unparsable flag",
    flag: "staging.example.test",
    credential: "api-key",
    expect: {
      code: "API_URL_INVALID",
      message:
        /^Invalid --api-url value\. Expected a full URL like https:\/\/app\.mcpjam\.com\/api\/v1\.$/,
    },
  },
  {
    name: "a non-http variable",
    env: { MCPJAM_BASE_URL: "ftp://a.example.test" },
    credential: "api-key",
    expect: {
      code: "API_URL_INVALID",
      message: /^Invalid MCPJAM_BASE_URL value .* Expected an http\(s\) URL/,
    },
  },
];

describe("resolveDeployment", () => {
  it.each(rows)("$name", (row) => {
    const resolve = () =>
      resolveDeployment({
        ...(row.flag ? { apiUrl: row.flag } : {}),
        credential: row.credential,
        env: row.env ?? {},
        authFilePath: loginFiles[row.login ?? "none-saved"],
      });
    if ("code" in row.expect) {
      let thrown: unknown;
      try {
        resolve();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: row.expect.code });
      if (row.expect.message) {
        expect((thrown as Error).message).toMatch(row.expect.message);
      }
      return;
    }
    const resolved = resolve();
    expect(resolved).toEqual({
      baseUrl: row.expect.baseUrl,
      apiUrl: `${row.expect.baseUrl}/api/v1`,
      source: row.expect.source,
    });
  });

  it("takes an SDK baseUrl option as the flag", () => {
    expect(
      resolveDeployment({ baseUrl: `${A}/`, env: { MCPJAM_BASE_URL: B } })
    ).toEqual({ apiUrl: `${A}/api/v1`, baseUrl: A, source: "flag" });
  });

  it("keeps a server's path prefix", () => {
    expect(
      resolveDeployment({ apiUrl: `${A}/mcpjam/api/v1`, env: {} })
    ).toMatchObject({ apiUrl: `${A}/mcpjam/api/v1`, baseUrl: `${A}/mcpjam` });
  });
});
