/**
 * A web client swarm's accounts. A session holds one account for all its
 * turns, the way an eval iteration does, so a swarm runs at most as many
 * sessions at once as it has usable accounts and the rest wait for one to
 * free up. A session that loses its account (signed out, removed) stops with
 * the account's reason and the account leaves the pool; the other sessions
 * go on. When no account is left, a waiting session stops with that reason.
 *
 * The usable accounts are frozen when the swarm first needs them: the
 * vendor's accounts in the project that hold a saved session and don't need
 * sign-in, the default first. A local Inspector's one account per vendor is
 * this machine's profile, which every swarm in the process shares, so a
 * session also holds the profile until it is done with the account.
 */
import { z } from "zod";
import {
  WEB_CLIENT_DISPLAY_NAMES,
  webClientVendorForRuntime,
  type WebClientVendor,
} from "@/shared/web-clients";
import { webClientService, type WebClientService } from "./backend-connector-resolver.js";
import type { WebActor } from "./hosted-web-client-environment.js";
import { actorForRun } from "./hosted-web-client-runtime.js";
import { webClientTurnsRunHosted } from "./web-client-environment.js";
import { WebAccountUnavailableError, type WebClientRunContext } from "./web-client-run.js";

export type WebAccountLease = {
  readonly webAccountId: string;
  /** The account can't serve this run any more, so it leaves the pool. */
  lose(reason: string): void;
  /** The session is done with the account; the next waiting one takes it. */
  release(): void;
};

type Waiter = { grant(lease: WebAccountLease): void; refuse(error: Error): void };

export function createWebAccountPool(webAccountIds: readonly string[], noneUsable: string) {
  const free = [...new Set(webAccountIds)];
  const leased = new Set<string>();
  const waiters: Waiter[] = [];
  let lastLoss: string | undefined;
  const exhausted = () => free.length === 0 && leased.size === 0;
  const refusal = () => new WebAccountUnavailableError(lastLoss ?? noneUsable);

  function lease(webAccountId: string): WebAccountLease {
    leased.add(webAccountId);
    let done = false;
    return {
      webAccountId,
      lose(reason) {
        if (done) return;
        done = true;
        leased.delete(webAccountId);
        lastLoss = reason;
        if (exhausted()) for (const waiter of waiters.splice(0)) waiter.refuse(refusal());
      },
      release() {
        if (done) return;
        done = true;
        leased.delete(webAccountId);
        const next = waiters.shift();
        if (next) next.grant(lease(webAccountId));
        else free.push(webAccountId);
      },
    };
  }

  return {
    async acquire(signal?: AbortSignal): Promise<WebAccountLease> {
      if (signal?.aborted) throw signal.reason;
      const ready = free.shift();
      if (ready !== undefined) return lease(ready);
      if (exhausted()) throw refusal();
      return new Promise<WebAccountLease>((resolve, reject) => {
        const abort = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(signal?.reason);
        };
        const waiter: Waiter = {
          grant(granted) {
            signal?.removeEventListener("abort", abort);
            resolve(granted);
          },
          refuse(error) {
            signal?.removeEventListener("abort", abort);
            reject(error);
          },
        };
        waiters.push(waiter);
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
  };
}

const accountRow = z.object({
  webAccountId: z.string().min(1),
  vendor: z.string(),
  status: z.string().optional(),
  hasProfile: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

export type SwarmWebSession = { lease: WebAccountLease; run: WebClientRunContext };

/** This machine's profiles, one session at a time across every swarm in the process. */
const localProfiles = new Map<WebClientVendor, ReturnType<typeof createWebAccountPool>>();

/**
 * `lease`, holding the vendor's local profile as well. The profile is only
 * ever released, never lost: a lost account leaves this swarm's pool, and the
 * next swarm reads the profile afresh.
 */
async function holdLocalProfile(
  vendor: WebClientVendor,
  lease: WebAccountLease,
  signal?: AbortSignal,
): Promise<WebAccountLease> {
  let profiles = localProfiles.get(vendor);
  if (!profiles) {
    profiles = createWebAccountPool([`local:${vendor}`], "");
    localProfiles.set(vendor, profiles);
  }
  let profile: WebAccountLease;
  try {
    profile = await profiles.acquire(signal);
  } catch (error) {
    lease.release();
    throw error;
  }
  return {
    webAccountId: lease.webAccountId,
    lose(reason) {
      profile.release();
      lease.lose(reason);
    },
    release() {
      profile.release();
      lease.release();
    },
  };
}

/** One swarm run's pools, one per vendor its targets use. */
export function createSwarmWebAccounts(args: {
  projectId: string;
  runId: string;
  getBearer(): Promise<string>;
  /** Where this server's turns run: `webClientTurnsRunHosted()`, as the mount decided, by default. */
  hosted?: boolean;
  /** This process's backend service by default. */
  service?: WebClientService;
  actorOf?: (bearer: string) => Promise<WebActor | undefined>;
}) {
  const pools = new Map<
    WebClientVendor,
    Promise<
      | {
          pool: ReturnType<typeof createWebAccountPool>;
          actor?: WebActor;
          local?: boolean;
        }
      | undefined
    >
  >();

  async function freeze(vendor: WebClientVendor) {
    const name = WEB_CLIENT_DISPLAY_NAMES[vendor];
    // A local Inspector's turns run on this machine's profile, its one account
    // per vendor, even when it also holds the service credential.
    if (!(args.hosted ?? webClientTurnsRunHosted())) {
      return {
        pool: createWebAccountPool([`local:${vendor}`], ""),
        local: true,
      };
    }
    const service = args.service ?? webClientService();
    // Without the backend a hosted server has no environment for these turns,
    // and each one stops saying so.
    if (!service) return undefined;
    const actor = await (args.actorOf ?? actorForRun)(await args.getBearer());
    if (!actor) {
      throw new WebAccountUnavailableError("This swarm has no MCPJam user to act as. Start it again while signed in.");
    }
    const rows = z
      .array(accountRow)
      .parse(await service.read({ action: "listWebAccounts", projectId: args.projectId, ...actor }))
      .filter((row) => row.vendor === vendor && row.hasProfile === true && row.status !== "needs_sign_in");
    const ordered = [...rows.filter((row) => row.isDefault), ...rows.filter((row) => !row.isDefault)];
    return {
      actor,
      pool: createWebAccountPool(
        ordered.map((row) => row.webAccountId),
        `No ${name} account in this project is signed in. Ask an admin to sign one in from the client's Browser settings, then run again.`,
      ),
    };
  }

  return {
    /**
     * An account for one session of a web client target; nothing for any
     * other runtime, or on a hosted server without the backend.
     */
    async acquire(runtimeId: string | undefined, signal?: AbortSignal): Promise<SwarmWebSession | undefined> {
      const vendor = webClientVendorForRuntime(runtimeId);
      if (!vendor) return undefined;
      let frozen = pools.get(vendor);
      if (!frozen) {
        frozen = freeze(vendor);
        pools.set(vendor, frozen);
      }
      let entry: Awaited<typeof frozen>;
      try {
        entry = await frozen;
      } catch (error) {
        // A failed read is not frozen: the next session reads again.
        if (pools.get(vendor) === frozen) pools.delete(vendor);
        throw error;
      }
      if (!entry) return undefined;
      const held = await entry.pool.acquire(signal);
      const lease = entry.local ? await holdLocalProfile(vendor, held, signal) : held;
      return {
        lease,
        run: {
          runId: args.runId,
          ...(entry.actor ? { actor: entry.actor } : {}),
          webAccountIds: [lease.webAccountId],
          onAccountLost: (reason) => lease.lose(reason),
        },
      };
    },
  };
}
