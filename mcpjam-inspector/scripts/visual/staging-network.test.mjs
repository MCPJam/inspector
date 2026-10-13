import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ANALYTICS_CONSENT_KEY,
  describeConvexFrame,
  isSponsorshipAllowanceRead,
  permitsConvexFrame,
  refuseWithheldWrite,
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

test("funding preview passes only as the empty sponsored-allowance read", () => {
  const read = (body) => isSponsorshipAllowanceRead(JSON.stringify(body));
  assert.equal(read({ projectId: "project", runs: [] }), true);
  for (const body of [
    { projectId: "project", runs: [{ journeyRefId: "journey" }] },
    { projectId: "project" },
    { runs: [] },
    { projectId: "project", runs: [], extra: true },
    [],
    null,
  ])
    assert.equal(read(body), false);
  assert.equal(isSponsorshipAllowanceRead(null), false);
  assert.equal(isSponsorshipAllowanceRead("malformed"), false);
});

test("blocked Convex frames are named without their arguments", () => {
  assert.equal(
    describeConvexFrame(
      JSON.stringify({
        type: "Mutation",
        udfPath: "projects:createProject",
        args: [{ name: "private" }],
      }),
    ),
    "Mutation projects:createProject",
  );
  assert.equal(describeConvexFrame("malformed"), "unparseable frame");
});

test("the What's new stamp is answered as a failure and never permitted", () => {
  const frame = {
    type: "Mutation",
    requestId: 7,
    udfPath: "productUpdates:initializeIfNeeded",
    args: [{}],
  };
  assert.equal(permitsConvexFrame(JSON.stringify(frame)), false);
  assert.deepEqual(JSON.parse(refuseWithheldWrite(JSON.stringify(frame))), {
    type: "MutationResponse",
    requestId: 7,
    success: false,
    result: "Withheld by the staging visual check",
    logLines: [],
  });
  for (const message of [
    { ...frame, udfPath: "productUpdates:dismissUpdate" },
    { ...frame, args: [{ slug: "update" }] },
    { ...frame, componentPath: "other" },
    { ...frame, requestId: "7" },
    { ...frame, type: "Action" },
    { type: "ModifyQuerySet", modifications: [] },
    null,
  ])
    assert.equal(refuseWithheldWrite(JSON.stringify(message)), null);
  assert.equal(refuseWithheldWrite("malformed"), null);
});

test("the declined analytics consent names the app's PostHog project", () => {
  const source = readFileSync(
    new URL("../../client/src/lib/PosthogUtils.ts", import.meta.url),
    "utf8",
  );
  const token = /VITE_PUBLIC_POSTHOG_KEY =\s*"([^"]+)"/.exec(source)?.[1];
  assert.equal(ANALYTICS_CONSENT_KEY, `__ph_opt_in_out_${token}`);
});
