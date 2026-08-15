/**
 * Product ownership of a client (host), and the one rule about which owners
 * are hidden from generic client surfaces.
 *
 * Deliberately NOT in `@/hooks/useClients` despite describing its data: this is
 * a pure predicate, and every surface that consults it also mocks that hooks
 * module in its tests. A pure function reachable only through a mocked module
 * is one a test has to re-declare to get right, which makes "which surfaces
 * honor the rule" a per-test-file decision instead of a shared one.
 */

/**
 * Mirrored from the backend `hosts.ownerScope` (mcpjam-backend
 * convex/schema.ts). `null` = untagged/legacy (visible to both products).
 *
 * NOT an auth signal — project role is the only auth. It drives product
 * filtering, badges, and whether a surface offers a publish surface at all.
 */
export type HostOwnerScope =
  | { type: "suite"; testSuiteId: string }
  | { type: "chatbox"; chatboxId: string }
  | { type: "journeys" }
  | { type: "user_testing" }
  | null;

/**
 * A client that exists only as the private backing of a User Testing scenario,
 * and must not appear in generic client lists or pickers.
 *
 * Not merely tidiness: it is retired when its scenario is, so anything that
 * attached to it — a swarm, an eval suite, a saved test case — would be left
 * pointing at a client that vanished, or would block the scenario's cleanup
 * and strand a ghost client in the project. Hiding it is what makes that
 * lifecycle safe to be automatic.
 *
 * `journeys` hosts are deliberately NOT included: they are standalone clients
 * the Clients surface is meant to show. They are hidden from the CHATBOX
 * surface instead, which is a different rule with a different owner — see
 * `hosts.ownerScope` in the backend schema.
 */
export function isPrivateScenarioBackingHost(
  ownerScope?: HostOwnerScope | undefined,
): boolean {
  return ownerScope?.type === "user_testing";
}

/** Drop private scenario-backing clients from a list bound for a user. */
export function withoutPrivateScenarioBackingHosts<
  T extends { ownerScope?: HostOwnerScope },
>(hosts: T[]): T[] {
  return hosts.filter((host) => !isPrivateScenarioBackingHost(host.ownerScope));
}
