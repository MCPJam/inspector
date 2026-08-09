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
}) {
	let url;
	if (backend) {
		url = await backend.mintLink(ctx, opts);
	} else {
		if (!baseUrl || !token)
			throw new InstallationBackendError("Connect link config is required.", {
				code: "CONFIG",
			});
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
			},
		);
		const payload = await response.json().catch(() => null);
		if (!response.ok)
			throw new InstallationBackendError(
				payload?.error || "Unable to create a connect link.",
				{ status: response.status },
			);
		url = payload?.url;
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
