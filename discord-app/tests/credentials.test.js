import assert from "node:assert/strict";
import test from "node:test";
import {
	apiServiceToken,
	appUrl,
	baseUrl,
	connectLinkOrigins,
	convexServiceToken,
	getConfig,
	requireApiServiceToken,
} from "../credentials.js";

const CREDENTIAL_VARS = [
	"DISCORD_SERVICE_TOKEN",
	"MCPJAM_DISCORD_SERVICE_TOKEN",
	"DISCORD_API_TOKEN",
	"MCPJAM_BASE_URL",
	"MCPJAM_APP_URL",
	"DISCORD_LINK_PUBLIC_ORIGIN",
];

/** Run `body` with exactly the given credential env, restoring afterwards. */
function withEnv(env, body) {
	const saved = new Map(CREDENTIAL_VARS.map((key) => [key, process.env[key]]));
	for (const key of CREDENTIAL_VARS) delete process.env[key];
	Object.assign(process.env, env);
	try {
		return body();
	} finally {
		for (const key of CREDENTIAL_VARS) delete process.env[key];
		for (const [key, value] of saved)
			if (value !== undefined) process.env[key] = value;
	}
}

const ctx = { tenantId: "G1", actorId: "U1", projectId: "P1" };

test("the two tokens read their own variables and never each other's", () => {
	withEnv(
		{
			DISCORD_SERVICE_TOKEN: "convex-token",
			MCPJAM_DISCORD_SERVICE_TOKEN: "dsc_api-token",
		},
		() => {
			assert.equal(convexServiceToken(), "convex-token");
			assert.equal(apiServiceToken(), "dsc_api-token");
		},
	);

	// The whole point of the split: neither falls back to the other, so a
	// deployment that sets only one gets a named error rather than a token
	// silently doing a job it cannot do.
	withEnv({ DISCORD_SERVICE_TOKEN: "convex-token" }, () => {
		assert.equal(apiServiceToken(), undefined);
	});
	withEnv({ MCPJAM_DISCORD_SERVICE_TOKEN: "dsc_api-token" }, () => {
		assert.equal(convexServiceToken(), undefined);
	});
});

test("the phantom DISCORD_API_TOKEN is not consulted", () => {
	withEnv({ DISCORD_API_TOKEN: "phantom" }, () => {
		assert.equal(convexServiceToken(), undefined);
		assert.equal(apiServiceToken(), undefined);
	});
});

test("a missing API token throws a CONFIG error naming the variable", () => {
	withEnv({ DISCORD_SERVICE_TOKEN: "convex-token" }, () => {
		assert.throws(
			() => requireApiServiceToken(),
			(error) => {
				assert.equal(error.code, "CONFIG");
				assert.match(error.message, /MCPJAM_DISCORD_SERVICE_TOKEN/);
				return true;
			},
		);
	});
});

test("getConfig resolves the API token, not the Convex one", () => {
	withEnv(
		{
			DISCORD_SERVICE_TOKEN: "convex-token",
			MCPJAM_DISCORD_SERVICE_TOKEN: "dsc_api-token",
		},
		() => {
			const config = getConfig(ctx);
			assert.equal(config.apiKey, "dsc_api-token");
			assert.equal(config.projectId, "P1");
			assert.deepEqual(config.headers, {
				"x-mcpjam-surface-tenant-id": "G1",
				"x-mcpjam-surface-actor-id": "U1",
			});
		},
	);
});

test("getConfig throws CONFIG rather than sending `Bearer undefined`", () => {
	withEnv({ DISCORD_SERVICE_TOKEN: "convex-token" }, () => {
		assert.throws(
			() => getConfig(ctx),
			(error) => {
				assert.equal(error.code, "CONFIG");
				assert.match(error.message, /MCPJAM_DISCORD_SERVICE_TOKEN/);
				return true;
			},
		);
	});
});

test("getConfig throws NO_PROJECT rather than building /projects/undefined/", () => {
	withEnv({ MCPJAM_DISCORD_SERVICE_TOKEN: "dsc_api-token" }, () => {
		assert.throws(
			() => getConfig({ tenantId: "G1", actorId: "U1" }),
			(error) => {
				assert.equal(error.code, "NO_PROJECT");
				return true;
			},
		);
	});
});

test("getConfig requires a tenant and an actor", () => {
	withEnv({ MCPJAM_DISCORD_SERVICE_TOKEN: "dsc_api-token" }, () => {
		for (const partial of [
			{ actorId: "U1", projectId: "P1" },
			{ tenantId: "G1", projectId: "P1" },
		])
			assert.throws(
				() => getConfig(partial),
				(error) => {
					assert.equal(error.code, "CONFIG");
					return true;
				},
			);
	});
});

test("overrides win over the environment", () => {
	withEnv({ MCPJAM_DISCORD_SERVICE_TOKEN: "dsc_api-token" }, () => {
		const config = getConfig(ctx, {
			apiKey: "dsc_override",
			projectId: "P2",
			baseUrl: "https://override.example.com/",
		});
		assert.equal(config.apiKey, "dsc_override");
		assert.equal(config.projectId, "P2");
		assert.equal(config.baseUrl, "https://override.example.com");
	});
});

test("trailing slashes are trimmed from both origins", () => {
	withEnv(
		{
			MCPJAM_DISCORD_SERVICE_TOKEN: "dsc_api-token",
			MCPJAM_BASE_URL: "https://api.example.com/",
			MCPJAM_APP_URL: "https://app.example.com///",
		},
		() => {
			assert.equal(baseUrl(), "https://api.example.com");
			assert.equal(appUrl(), "https://app.example.com");
			const config = getConfig(ctx);
			assert.equal(config.baseUrl, "https://api.example.com");
			assert.equal(config.appUrl, "https://app.example.com");
		},
	);
});

test("appUrl falls back to baseUrl", () => {
	withEnv({ MCPJAM_BASE_URL: "https://api.example.com" }, () => {
		assert.equal(appUrl(), "https://api.example.com");
	});
});

test("connect-link origins drop unset entries instead of widening", () => {
	withEnv(
		{
			MCPJAM_BASE_URL: "https://api.example.com",
			MCPJAM_APP_URL: "https://app.example.com",
			DISCORD_LINK_PUBLIC_ORIGIN: "https://link.example.com",
		},
		() => {
			assert.deepEqual(connectLinkOrigins(), [
				"https://app.example.com",
				"https://link.example.com",
				"https://api.example.com",
			]);
		},
	);

	withEnv({ MCPJAM_BASE_URL: "https://api.example.com" }, () => {
		assert.deepEqual(connectLinkOrigins(), ["https://api.example.com"]);
	});
});
