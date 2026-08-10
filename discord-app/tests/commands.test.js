import assert from "node:assert/strict";
import test from "node:test";
import { MCPJAM_COMMANDS, resolveCommandRegistration } from "../commands.js";

/**
 * Registration used to require BOTH an application id and a guild id, which
 * meant a bot added to a second server registered nothing — `/mcpjam` simply
 * did not exist there. These pin the scope decision that fixes it: the guild
 * id is now a development override, and its absence means global.
 */

test("no guild id registers GLOBALLY — the production path, so every server gets the command", () => {
	const registration = resolveCommandRegistration({ applicationId: "app-1" });
	assert.equal(registration.scope, "global");
	// The global route addresses the application alone, with no guild segment.
	assert.equal(registration.route, "/applications/app-1/commands");
});

test("a guild id registers to THAT guild — the development override, instant propagation", () => {
	const registration = resolveCommandRegistration({
		applicationId: "app-1",
		guildId: "guild-9",
	});
	assert.equal(registration.scope, "guild");
	assert.equal(
		registration.route,
		"/applications/app-1/guilds/guild-9/commands",
	);
});

test("no application id skips registration — there is nothing to register against", () => {
	assert.deepEqual(resolveCommandRegistration({ applicationId: "" }), {
		scope: "skipped",
	});
	assert.deepEqual(resolveCommandRegistration({ guildId: "guild-9" }), {
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
