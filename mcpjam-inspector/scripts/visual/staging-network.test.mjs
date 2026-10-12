import assert from "node:assert/strict";
import test from "node:test";
import {
  permitsConvexFrame,
  SYNTHETIC_ROLE,
} from "../../e2e/visual/staging-network.ts";

test("staging socket policy allows bootstrap and reads but rejects business writes", () => {
  const permits = (message) => permitsConvexFrame(JSON.stringify(message));
  assert.equal(
    permits({ type: "Mutation", udfPath: "users:ensureUser" }),
    true,
  );
  assert.equal(permits({ type: "ModifyQuerySet", modifications: [] }), true);
  assert.equal(
    permits({ type: "Authenticate", tokenType: "User", value: "synthetic" }),
    true,
  );
  for (const message of [
    { type: "Mutation", udfPath: "projects:createProject" },
    { type: "Action", udfPath: "chat:generate" },
    { type: "Mutation", udfPath: "users:ensureUser", componentPath: "other" },
    { type: "Authenticate", tokenType: "Admin" },
    { type: "Unknown" },
    null,
  ])
    assert.equal(permits(message), false);
  assert.equal(permitsConvexFrame("malformed"), false);
});

test("synthetic profile setup permits only the fixed role and no other writes", () => {
  const frame = {
    type: "Mutation",
    udfPath: "users:updateOccupation",
    args: [{ occupation: SYNTHETIC_ROLE }],
  };
  assert.equal(permitsConvexFrame(JSON.stringify(frame)), true);
  for (const args of [
    [],
    [{ occupation: "different" }],
    [{ occupation: SYNTHETIC_ROLE, userId: "other" }],
  ]) {
    assert.equal(permitsConvexFrame(JSON.stringify({ ...frame, args })), false);
  }
  assert.equal(
    permitsConvexFrame(JSON.stringify({ ...frame, componentPath: "other" })),
    false,
  );
});
