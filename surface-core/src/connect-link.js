// @ts-nocheck — not yet adopted by slack-app. Typed as each module is
// migrated off its slack-app twin; the marker tracks that remaining work.
import { InstallationBackendError } from "./backend-client.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Normalize the configured origins before comparing.
 *
 * An allowlist is written by hand, in an env var, so it arrives as things like
 * `https://app.mcpjam.com/` or `https://app.mcpjam.com/api` — neither of which
 * string-equals the `url.origin` this compares against, so a correctly
 * configured deployment would reject its own link.
 *
 * A malformed entry is SKIPPED rather than passed through. That direction is
 * deliberate and matches the Slack surface: a bad entry narrows the allowlist,
 * never widens it. Passing it through raw would leave a typo'd origin in the
 * comparison set where it can only ever fail to match — harmless — but the
 * habit is what matters, because the same helper decides which origins a
 * credential-bearing link may point at.
 *
 * @param {string[]} origins
 */
function normalizeOrigins(origins) {
	const normalized = [];
	for (const candidate of origins) {
		try {
			normalized.push(new URL(candidate).origin);
		} catch {
			// Skip. See above: malformed narrows, never widens.
		}
	}
	return normalized;
}

/** @param {string} candidate @param {string[]} origins */
export function assertConnectUrl(candidate, origins) {
	let url;
	try {
		url = new URL(candidate);
	} catch {
		throw new InstallationBackendError(
			"The connect link was not an absolute URL.",
		);
	}
	if (!normalizeOrigins(origins).includes(url.origin))
		throw new InstallationBackendError(
			"The connect link points at an unconfigured origin.",
		);
	if (url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname))
		throw new InstallationBackendError(
			"The connect link was not served over HTTPS.",
		);
	return candidate;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The direct-fetch mint, used by a caller with no `backend` client of its
 * own (today: discord-app). `backend.mintLink` goes through
 * `createBackendClient`'s `post()` instead, which already carries its own
 * timeout and error-code mapping — this one needed its own copy.
 *
 * @param {{baseUrl:string, token:string, path:string, surfaceKind?:string, tenantId?:string, actorId?:string, fetchImpl:typeof fetch, timeoutMs:number}} args
 */
async function mintConnectUrlDirect({
	baseUrl,
	token,
	path,
	surfaceKind,
	tenantId,
	actorId,
	fetchImpl,
	timeoutMs,
}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(
			`${String(baseUrl).replace(/\/+$/, "")}${path}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					surfaceKind,
					surfaceTenantId: tenantId,
					surfaceUserId: actorId,
				}),
				signal: controller.signal,
			},
		);
		let payload = null;
		try {
			payload = await response.json();
		} catch (error) {
			// Only an empty/malformed body reads as "no body". Anything else — a
			// stream failure mid-read — is a real failure and must propagate, not
			// be laundered into a response that merely lacks a url.
			if (!(error instanceof SyntaxError)) throw error;
		}
		if (!response.ok)
			throw new InstallationBackendError(
				payload?.error || "Unable to create a connect link.",
				{ status: response.status },
			);
		return payload?.url;
	} catch (error) {
		if (error instanceof InstallationBackendError) throw error;
		const aborted = error instanceof Error && error.name === "AbortError";
		throw new InstallationBackendError(
			aborted
				? "Connect-link request timed out"
				: `Connect-link request failed: ${error}`,
			{ code: aborted ? "TIMEOUT" : "NETWORK" },
		);
	} finally {
		clearTimeout(timer);
	}
}

/** @param {{backend:any, ctx:any, origins?:string[], opts?:any}} args */
export async function mintConnectUrl({
	backend,
	ctx,
	origins = [],
	opts = {},
	baseUrl,
	token,
	path = "/api/surface-link/session",
	surfaceKind,
	tenantId,
	actorId,
	fetchImpl = fetch,
	timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
	let url;
	if (backend) {
		url = await backend.mintLink(ctx, opts);
	} else {
		if (!baseUrl || !token)
			throw new InstallationBackendError("Connect link config is required.", {
				code: "CONFIG",
			});
		url = await mintConnectUrlDirect({
			baseUrl,
			token,
			path,
			surfaceKind,
			tenantId,
			actorId,
			fetchImpl,
			timeoutMs,
		});
	}
	if (typeof url !== "string")
		throw new InstallationBackendError(
			"The backend did not return a connect link.",
		);
	return assertConnectUrl(
		url,
		origins.length
			? origins
			: [
					new URL(process.env.MCPJAM_BASE_URL || "https://app.mcpjam.com")
						.origin,
				],
	);
}
