import { randomBytes, randomInt, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const environments = {
  production: {
    clientId: "client_01K4C1TVPBE7JTBFQJF9SDW9P9",
    authkitOrigin: "https://login.mcpjam.com",
    authorizeProxy: "https://auth.mcpjam.com/user_management/authorize",
  },
  development: {
    clientId: "client_01KTN2EWHHJCKRB8RSR307X4SG",
    authkitOrigin: "https://deep-vanilla-68-test.authkit.app",
  },
};

// No API key, cookies, sign-in, or token exchange. Stop BEFORE loading AuthKit
// bootstrap: its redirect proves URI admission, not a completed login.
// Production has one known authorization proxy hop; never follow arbitrary URLs.
export async function probeCallback(config, redirectUri, fetchImpl = fetch) {
  const url = new URL("https://api.workos.com/user_management/authorize");
  const verifier = randomBytes(32).toString("base64url");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    provider: "authkit",
    response_type: "code",
    redirect_uri: redirectUri,
    state: randomBytes(16).toString("base64url"),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  let current = url;
  for (let hop = 0; hop < 2; hop += 1) {
    let response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Never print underlying errors/URLs containing authorization parameters.
      throw new Error("WorkOS authorization probe failed or timed out");
    }
    await response.body?.cancel();
    if (![302, 303, 307, 308].includes(response.status)) {
      throw new Error(
        `WorkOS returned HTTP ${response.status}; admission is unverified`,
      );
    }
    let location;
    try {
      location = new URL(response.headers.get("location"));
    } catch {
      throw new Error("WorkOS returned a missing or invalid redirect Location");
    }
    if (location.username || location.password) {
      throw new Error("WorkOS returned credentials in a redirect Location");
    }
    if (
      hop === 0 &&
      config.authorizeProxy &&
      `${location.origin}${location.pathname}` === config.authorizeProxy
    ) {
      current = location;
      continue;
    }
    if (location.origin !== config.authkitOrigin) {
      throw new Error("WorkOS returned an unexpected AuthKit origin");
    }
    if (location.pathname === "/redirect-uri-invalid") return false;
    if (location.pathname === "/bootstrap") return true;
    throw new Error(
      "WorkOS returned an unexpected AuthKit path; admission is unverified",
    );
  }
  throw new Error("WorkOS authorization proxy did not reach AuthKit");
}

export function callbackCases(highPort = randomInt(49152, 65536)) {
  return [
    ...["localhost", "127.0.0.1"].flatMap((host) =>
      [6274, 6276, 7000, highPort].map((port) => ({
        uri: `http://${host}:${port}/callback`,
        allowed: true,
      })),
    ),
    { uri: "http://localhost.evil.invalid:6276/callback", allowed: false },
    { uri: "http://127.0.0.1.evil.invalid:6276/callback", allowed: false },
  ];
}

export async function checkCallbacks(config, cases, probe = probeCallback) {
  // Sequential and bounded: 10 cases, each with at most one known proxy hop.
  const results = [];
  for (const item of cases) {
    try {
      const admitted = await probe(config, item.uri);
      results.push({
        ...item,
        ok: admitted === item.allowed,
        detail: admitted ? "accepted" : "rejected",
      });
    } catch (error) {
      results.push({ ...item, ok: false, detail: error.message });
    }
  }
  return results;
}

async function main(args) {
  if (args.length > 1 || (args[0] && !Object.hasOwn(environments, args[0]))) {
    throw new Error(
      "Usage: node .github/scripts/check-workos-loopback.mjs [production|development]",
    );
  }
  const environment = args[0] ?? "production";
  const results = await checkCallbacks(
    environments[environment],
    callbackCases(),
  );
  process.stdout.write(
    `WorkOS ${environment} callback admission (not end-to-end login)\n`,
  );
  for (const result of results) {
    process.stdout.write(
      `${result.ok ? "PASS" : "FAIL"} ${result.uri}: ${result.detail}\n`,
    );
  }
  if (results.some((result) => !result.ok)) {
    process.stderr.write(
      "Callback gate failed. Follow docs/workos-loopback-callbacks.md; preserve existing URIs and defaults.\n",
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
