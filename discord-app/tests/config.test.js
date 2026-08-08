import assert from "node:assert/strict";
import test from "node:test";
import { describeConfigGaps, loadConfig } from "../config.js";

/**
 * The two service tokens are NOT interchangeable, and the code used to pretend
 * they were. `app.js` resolved "the token" three different ways:
 *
 *   MCPJAM_DISCORD_SERVICE_TOKEN || DISCORD_SERVICE_TOKEN || DISCORD_API_TOKEN
 *   DISCORD_SERVICE_TOKEN || MCPJAM_DISCORD_SERVICE_TOKEN || DISCORD_API_TOKEN
 *   DISCORD_SERVICE_TOKEN            (alone)
 *
 * On a deployment with both set, those resolve to DIFFERENT tokens depending on
 * which line runs — and the failure surfaces as a 401 nowhere near the cause.
 */

const FULL_ENV = {
	DISCORD_BOT_TOKEN: "bot-token",
	POSTHOG_DISCORD_AGENT_ENABLED: "true",
	DISCORD_SERVICE_TOKEN: "convex-token",
	MCPJAM_DISCORD_SERVICE_TOKEN: "dsc_inspector-token",
	MCPJAM_BASE_URL: "https://inspector.example.com",
	MCPJAM_APP_URL: "https://app.example.com",
	MCPJAM_CONVEX_HTTP_URL: "https://convex.example.com/",
};

test("keeps the Convex and Inspector credentials separate", () => {
	const config = loadConfig(FULL_ENV);
	assert.equal(config.convexServiceToken, "convex-token");
	assert.equal(config.inspectorApiToken, "dsc_inspector-token");
});

test("does NOT fall back from one credential to the other", () => {
	// Handing Convex the Inspector's `dsc_` bearer is not a degraded mode, it is
	// an authentication failure — so a missing token stays missing.
	const onlyInspector = loadConfig({
		...FULL_ENV,
		DISCORD_SERVICE_TOKEN: undefined,
	});
	assert.equal(onlyInspector.convexServiceToken, undefined);
	assert.equal(onlyInspector.inspectorApiToken, "dsc_inspector-token");

	const onlyConvex = loadConfig({
		...FULL_ENV,
		MCPJAM_DISCORD_SERVICE_TOKEN: undefined,
	});
	assert.equal(onlyConvex.convexServiceToken, "convex-token");
	assert.equal(onlyConvex.inspectorApiToken, undefined);
});

test("ignores the undocumented DISCORD_API_TOKEN fallback", () => {
	const config = loadConfig({
		DISCORD_BOT_TOKEN: "bot",
		DISCORD_API_TOKEN: "legacy-mystery-token",
	});
	assert.equal(config.convexServiceToken, undefined);
	assert.equal(config.inspectorApiToken, undefined);
});

test("treats blank and whitespace-only values as unset", () => {
	// A Railway variable set to "" is the same as not setting it, and treating
	// it as a token produces an `Authorization: Bearer ` header that fails
	// obscurely rather than a clean "not configured".
	const config = loadConfig({
		DISCORD_BOT_TOKEN: "bot",
		DISCORD_SERVICE_TOKEN: "   ",
		MCPJAM_DISCORD_SERVICE_TOKEN: "",
	});
	assert.equal(config.convexServiceToken, undefined);
	assert.equal(config.inspectorApiToken, undefined);
});

test("the agent stays OFF unless explicitly enabled", () => {
	for (const value of [undefined, "", "false", "1", "yes", "TRUE"]) {
		assert.equal(
			loadConfig({ ...FULL_ENV, POSTHOG_DISCORD_AGENT_ENABLED: value })
				.botEnabled,
			false,
			`"${value}" must not enable the agent`,
		);
	}
	assert.equal(loadConfig(FULL_ENV).botEnabled, true);
});

test("link origins are deduped and ordered, with the base URL last", () => {
	const config = loadConfig(FULL_ENV);
	assert.deepEqual(config.linkOrigins, [
		"https://app.example.com",
		"https://inspector.example.com",
	]);

	// The same value in two variables is one origin, not two.
	const overlapping = loadConfig({
		...FULL_ENV,
		MCPJAM_APP_URL: "https://inspector.example.com",
	});
	assert.deepEqual(overlapping.linkOrigins, ["https://inspector.example.com"]);
});

test("defaults the base and app URLs to production", () => {
	const config = loadConfig({ DISCORD_BOT_TOKEN: "bot" });
	assert.equal(config.baseUrl, "https://app.mcpjam.com");
	assert.equal(config.appUrl, "https://app.mcpjam.com");
});

test("strips a trailing slash from the Convex URL", () => {
	// Presence builds `${convexHttpUrl}/agent/presence`; a trailing slash gives
	// a double slash, which some routers 404.
	assert.equal(
		loadConfig(FULL_ENV).convexHttpUrl,
		"https://convex.example.com",
	);
});

test("reports each missing piece by name, and says which credential it is", () => {
	const warnings = describeConfigGaps(loadConfig({ DISCORD_BOT_TOKEN: "bot" }));
	const joined = warnings.join("\n");
	assert.match(joined, /DISCORD_SERVICE_TOKEN is not set/);
	assert.match(joined, /MCPJAM_DISCORD_SERVICE_TOKEN is not set/);
	assert.match(joined, /MCPJAM_CONVEX_HTTP_URL is not set/);
	assert.match(joined, /POSTHOG_DISCORD_AGENT_ENABLED/);
	// The warnings must say the tokens are not interchangeable — that confusion
	// is the entire reason this module exists.
	assert.match(joined, /not interchangeable/);
});

test("a fully configured deployment warns about nothing", () => {
	assert.deepEqual(describeConfigGaps(loadConfig(FULL_ENV)), []);
});
