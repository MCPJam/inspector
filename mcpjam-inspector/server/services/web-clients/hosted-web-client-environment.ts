/**
 * The hosted web client environment: the backend keeps the project's web
 * accounts, their connectors and their saved browser profiles, and the run
 * acts as its person through the Inspector service token.
 *
 *  - Account: the suite's or run's choice, else the vendor's default
 *    (`isDefault`), else the vendor's only account.
 *  - Connector: `ensureWebConnector` with `oauth` auth; the vendor's app adds
 *    it as `https://<inspector host>/mcp/<connectorId>`.
 *  - Browser: the saved profile from `profile-for-run`, restored into the
 *    run's hosted browser by `openHostedBrowser`. The profile's key and
 *    download URL are handed over and never logged.
 *  - Outcome: a verified run marks the account verified; a sign-in step
 *    marks it as needing sign-in and reports the step so recovery can resume,
 *    naming the profile the run restored: an account signed in again since
 *    is left as it is.
 */
import { z } from "zod";
import {
  WEB_CLIENT_DISPLAY_NAMES,
  type WebClientVendor,
} from "@/shared/web-clients";
import {
  createMemorySendJournal,
  type SendJournal,
} from "../../utils/harness/real-ui/drive-turn.js";
import type { PageDriver } from "../../utils/harness/real-ui/page-driver.js";
import { RealUiError, needsSignIn } from "../../utils/harness/real-ui/page-module.js";
import { INSPECTOR_SERVICE_TOKEN_HEADER } from "../service-credential.js";
import type { WebClientService } from "./backend-connector-resolver.js";
import type { WebClientEnvironment, WebTurnOutcome } from "./web-client-environment.js";

export type WebActor = { actorExternalId: string } | { actorUserId: string };

/** What `profile-for-run` hands a run. Secret: never log any of it. */
export type ProfileForRun = {
  webAccountId: string;
  profileVersion: number;
  downloadUrl: string;
  dataKey: string;
  sizeBytes: number;
  sha256: string;
  savedAt: number;
};

const accountRow = z.object({
  webAccountId: z.string(),
  vendor: z.string(),
  isDefault: z.boolean().optional(),
  accountEmail: z.string().optional(),
  hasProfile: z.boolean().optional(),
});
const profileAnswer = z.object({
  webAccountId: z.string(),
  profileVersion: z.number(),
  downloadUrl: z.string().url(),
  dataKey: z.string().min(1),
  sizeBytes: z.number(),
  sha256: z.string(),
  savedAt: z.number(),
});
/** The backend's refusal: `{ error: { code, message? } }`. */
const refusalAnswer = z.object({ error: z.object({ code: z.string() }) });

/** `POST /internal/v1/web-accounts/profile-for-run`. */
export function createProfileForRunClient(options: {
  convexHttpUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
}) {
  return async (args: {
    actor: WebActor;
    webAccountId: string;
    runId: string;
    venue: "hosted" | "local";
  }): Promise<ProfileForRun> => {
    const response = await (options.fetchImpl ?? fetch)(
      new URL("/internal/v1/web-accounts/profile-for-run", options.convexHttpUrl),
      {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          [INSPECTOR_SERVICE_TOKEN_HEADER]: options.serviceToken,
        },
        body: JSON.stringify({
          ...args.actor,
          webAccountId: args.webAccountId,
          runId: args.runId,
          venue: args.venue,
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      // Only the backend saying the account has no usable saved sign-in is
      // about the account. An outage or any other refusal is the run's, and
      // must not mark a signed-in account as signed out.
      if ((await refusalCode(response)) === "WEB_ACCOUNT_NEEDS_SIGN_IN") {
        throw needsSignIn(
          "signed_out",
          "sign_in_check",
          "The saved browser session for this account could not be loaded.",
        );
      }
      throw new RealUiError({
        kind: "driver",
        step: "sign_in_check",
        message: "MCPJam could not load the saved browser session for this account.",
      });
    }
    return profileAnswer.parse(await response.json());
  };
}

async function refusalCode(response: Response): Promise<string | undefined> {
  try {
    return refusalAnswer.safeParse(await response.json()).data?.error.code;
  } catch {
    // A body that isn't JSON is not one of the backend's refusals.
    return undefined;
  }
}

export type HostedWebClientDeps = {
  /** `webClientService()`: the one backend client this process holds. */
  service: WebClientService;
  actor: WebActor;
  /** `https://<inspector host>`: the vendor's app dials `/mcp/<id>` there. */
  publicBaseUrl: string;
  runId: string;
  iterationId?: string;
  /** The suite's or run's chosen account, when it chose one. */
  chosenWebAccountId?: string;
  profileForRun: ReturnType<typeof createProfileForRunClient>;
  /** Restores the profile into the run's hosted browser and drives it. */
  openHostedBrowser(args: {
    profile: ProfileForRun;
    sites: readonly string[];
  }): Promise<{ driver: PageDriver; close(): Promise<void> }>;
  journal?: SendJournal;
};

export function createHostedWebClientEnvironment(
  deps: HostedWebClientDeps,
): WebClientEnvironment {
  // The profile version each account's browser restored, for its outcome.
  const restoredVersions = new Map<string, number>();
  return {
    publicBaseUrl: deps.publicBaseUrl,
    journal: deps.journal ?? createMemorySendJournal(),

    async resolveAccount({ projectId, vendor }) {
      const rows = z
        .array(accountRow)
        .parse(await deps.service.read({ action: "listWebAccounts", projectId, ...deps.actor }))
        .filter((row) => row.vendor === vendor);
      // The account a suite or run chose, or none: falling back would restore
      // another account's profile and add connectors to it.
      const chosen = deps.chosenWebAccountId
        ? rows.find((row) => row.webAccountId === deps.chosenWebAccountId)
        : (rows.find((row) => row.isDefault) ?? (rows.length === 1 ? rows[0] : undefined));
      if (!chosen && deps.chosenWebAccountId) {
        throw needsSignIn(
          "signed_out",
          "sign_in_check",
          `The ${WEB_CLIENT_DISPLAY_NAMES[vendor]} account chosen for this run is not saved for this project. Choose another account, then run again.`,
        );
      }
      if (!chosen) throw noAccount(vendor);
      return {
        webAccountId: chosen.webAccountId,
        ...(chosen.accountEmail ? { accountEmail: chosen.accountEmail } : {}),
      };
    },

    async ensureConnector({ projectId, webAccountId, serverId }) {
      const answer = z.object({ connectorId: z.string().min(1) }).parse(
        await deps.service.apply({
          action: "ensureWebConnector",
          projectId,
          webAccountId,
          serverId,
          auth: "oauth",
          ...deps.actor,
        }),
      );
      return { connectorId: answer.connectorId };
    },

    async openBrowser({ webAccountId, sites }) {
      const profile = await deps.profileForRun({
        actor: deps.actor,
        webAccountId,
        runId: deps.runId,
        venue: "hosted",
      });
      restoredVersions.set(webAccountId, profile.profileVersion);
      return deps.openHostedBrowser({ profile, sites });
    },

    turnGate: {
      async open(window) {
        await deps.service.apply({ action: "openWebTurnWindow", ...window, ...deps.actor });
      },
      async close(turnId) {
        await deps.service.apply({ action: "closeWebTurnWindow", turnId, ...deps.actor });
      },
    },

    async onOutcome(outcome: WebTurnOutcome) {
      if (outcome.ok) {
        if (!outcome.account.email) return;
        await deps.service.apply({
          action: "markWebAccountVerified",
          webAccountId: outcome.webAccountId,
          accountEmail: outcome.account.email,
          ...(outcome.account.workspace ? { workspaceName: outcome.account.workspace } : {}),
          ...deps.actor,
        });
        return;
      }
      if (outcome.failure.kind !== "needs_sign_in") return;
      const restored = restoredVersions.get(outcome.webAccountId);
      const version = restored === undefined ? {} : { restoredProfileVersion: restored };
      await deps.service.apply({
        action: "markWebAccountNeedsSignIn",
        webAccountId: outcome.webAccountId,
        reason: outcome.failure.reason,
        ...version,
        ...deps.actor,
      });
      await deps.service.apply({
        action: "reportWebSignInRequired",
        webAccountId: outcome.webAccountId,
        runId: deps.runId,
        ...(deps.iterationId ? { iterationId: deps.iterationId } : {}),
        pendingStep: JSON.stringify(outcome.pendingStep ?? { stepId: outcome.failure.step }),
        reason: outcome.failure.reason,
        ...version,
        ...deps.actor,
      });
    },
  };
}

function noAccount(vendor: WebClientVendor) {
  const name = WEB_CLIENT_DISPLAY_NAMES[vendor];
  return needsSignIn(
    "signed_out",
    "sign_in_check",
    `No ${name} account is saved for this project. Ask an admin to sign one in from the client's Browser settings.`,
  );
}
