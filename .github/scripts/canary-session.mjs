const env = process.env;

/** A first-party AuthKit session, minted for the canary user. */
export async function mintSession({ email, apiKey, clientId }) {
  const base = (env.WORKOS_API_BASE || "https://api.workos.com").replace(
    /\/+$/,
    ""
  );
  const password = env.ASK_MCPJAM_CANARY_PASSWORD?.trim();
  let grant;
  if (password) {
    grant = { grant_type: "password", email, password };
  } else {
    // Magic Auth: creating a code through the API returns it, so no inbox is
    // involved. The code is single-use and short-lived.
    const created = await workos(`${base}/user_management/magic_auth`, apiKey, {
      email,
    });
    if (typeof created.code !== "string") {
      throw new Error("WorkOS created no Magic Auth code for the canary user.");
    }
    grant = {
      grant_type: "urn:workos:oauth:grant-type:magic-auth:code",
      code: created.code,
      email,
    };
  }
  const session = await workos(`${base}/user_management/authenticate`, apiKey, {
    client_id: clientId,
    client_secret: apiKey,
    ...grant,
  });
  if (typeof session.access_token !== "string") {
    throw new Error("WorkOS returned no access token for the canary user.");
  }
  return session.access_token;
}

async function workos(url, apiKey, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `WorkOS ${new URL(url).pathname} answered ${res.status}: ${redact(
        text.slice(0, 300)
      )}`
    );
  }
  return JSON.parse(text);
}

/** Never print a bearer, an access link's token, or a WorkOS key. */
export function redact(text) {
  return String(text)
    .replace(/#token=[A-Za-z0-9._~-]+/g, "#token=<redacted>")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
    .replace(/\beyJ[A-Za-z0-9._-]{20,}/g, "<jwt>")
    .replace(/\bsk_[A-Za-z0-9_]{8,}/g, "<sk>");
}

