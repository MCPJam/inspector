// @ts-nocheck
import { InstallationBackendError } from "./backend-client.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

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
	if (!origins.includes(url.origin))
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
}) {
	const url = await backend.mintLink(ctx, opts);
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
