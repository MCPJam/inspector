import assert from "node:assert/strict";
import test from "node:test";
import { snowflakeToMs } from "../history.js";

test("Discord snowflakes are ordered by their embedded millisecond timestamp", () => {
	const first = snowflakeToMs("1750000000000000000");
	const second = snowflakeToMs("1750000000000000001");
	assert.equal(first, second);
	assert.equal(snowflakeToMs("1750000000004194304") > first, true);
});
