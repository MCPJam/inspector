import assert from "node:assert/strict";
import test from "node:test";
import { MCPJAM_COMMANDS, resolveCommandRegistration } from "../commands.js";

/**
 * Registration used to require BOTH an application id and a guild id, which
 * meant a bot added to a second server registered nothing — `/mcpjam` simply
 * did not exist there. These pin the scope decision that fixes it: the
 * development override is opt-in under a NEW name, and its absence means
 * global.
 */

test("no dev guild id registers GLOBALLY — the production path, so every server gets the command", () => {
	const registration = resolveCommandRegistration({ applicationId: "app-1" });
	assert.equal(registration.scope, "global");
	// The global route addresses the application alone, with no guild segment.
	assert.equal(registration.route, "/applications/app-1/commands");
});

test("a dev guild id registers to THAT guild — instant propagation while iterating", () => {
	const registration = resolveCommandRegistration({
		applicationId: "app-1",
		devGuildId: "guild-9",
	});
	assert.equal(registration.scope, "guild");
	assert.equal(
		registration.route,
		"/applications/app-1/guilds/guild-9/commands",
	);
});

/**
 * THE MIGRATION GUARD. Every deployment that had a working `/mcpjam` before
 * this change necessarily set `DISCORD_GUILD_ID`, because registration
 * required it — production included. If that value reached this function it
 * would keep those deployments guild-scoped, making the whole change a no-op
 * exactly where it matters. `config.js` maps the old name to
 * `legacyGuildId` (warn-only) and never passes it here; this asserts the
 * function itself has no path that would honour it.
 */
test("the OLD guild id key does not scope registration — an upgrade goes global by default", () => {
	const registration = resolveCommandRegistration({
		applicationId: "app-1",
		// The pre-migration spelling, plus the shape config.js now produces
		// for a deployment that still has the stale variable set.
		guildId: "legacy-guild",
		legacyGuildId: "legacy-guild",
	});
	assert.equal(
		registration.scope,
		"global",
		"a stale DISCORD_GUILD_ID must not pin an upgraded deployment to one server",
	);
	assert.equal(registration.route, "/applications/app-1/commands");
});

test("no application id skips registration — there is nothing to register against", () => {
	assert.deepEqual(resolveCommandRegistration({ applicationId: "" }), {
		scope: "skipped",
	});
	assert.deepEqual(resolveCommandRegistration({ devGuildId: "guild-9" }), {
		scope: "skipped",
	});
	assert.deepEqual(resolveCommandRegistration(), { scope: "skipped" });
});

test("the command payload is the wire shape Discord expects, not a builder", () => {
	assert.equal(MCPJAM_COMMANDS.length, 1);
	const [command] = MCPJAM_COMMANDS;
	assert.equal(command.name, "mcpjam");
	assert.equal(typeof command.description, "string");
	// `connect` is the subcommand the Integrations card tells people to run;
	// renaming it silently breaks that instruction.
	assert.ok(
		command.options?.some((option) => option.name === "connect"),
		"expected a `connect` subcommand",
	);
	// A PLAIN object, not a SlashCommandBuilder. A builder would serialize to
	// the same bytes on the wire, so this is not about correctness of the
	// request — it is about the payload being inspectable here rather than
	// hidden behind a toJSON() call.
	assert.equal(typeof command.toJSON, "undefined");
	assert.equal(Object.getPrototypeOf(command), Object.prototype);
});
