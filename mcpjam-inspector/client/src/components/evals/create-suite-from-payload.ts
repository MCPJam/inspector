import { toast } from "sonner";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";

/** The fields both create surfaces' payloads share. */
type CreateSuitePayload = {
  name: string;
  hostAttachments?: unknown[];
  serverAttachmentId?: string;
  environmentIds?: string[];
};

type CreateTestSuite = (args: any) => Promise<any>;
type SetSuiteEnvironments = (args: {
  suiteId: string;
  environmentIds: string[] | null;
}) => Promise<unknown>;

/**
 * Create a suite from the create page's payload.
 *
 * A payload with environments on a backend that takes them
 * (`createSuiteWithEnvironments`) is ONE call: the suite is born an
 * environment suite, with no legacy client attached first. On an older
 * backend it keeps the two-call path: a legacy suite, then its environments,
 * where a failed second call still leaves a suite the header can convert.
 */
export async function createSuiteFromPayload(args: {
  projectId: string;
  payload: CreateSuitePayload;
  createTestSuite: CreateTestSuite;
  setSuiteEnvironments: SetSuiteEnvironments;
  /** `createSuiteWithEnvironments` confirmed by the backend. */
  oneCall: boolean;
}): Promise<{ _id: string } & Record<string, unknown>> {
  const { payload, projectId } = args;
  const environmentIds = payload.environmentIds ?? [];
  if (args.oneCall && environmentIds.length > 0) {
    const created = await args.createTestSuite({
      projectId,
      name: payload.name,
      environmentIds,
    });
    if (!created?._id) throw new Error("Suite was created without an id");
    return created;
  }

  const created = await args.createTestSuite({
    projectId,
    name: payload.name,
    // environment.servers is left empty: hosts own server selection now,
    // and the runner derives the per-run server set from each attachment's
    // snapshot. Suites with zero attachments are valid skeletons; they just
    // can't run until a host is attached.
    environment: { servers: [] },
    ...(payload.hostAttachments && payload.hostAttachments.length > 0
      ? { hostAttachments: payload.hostAttachments }
      : {}),
    ...(payload.serverAttachmentId
      ? { serverAttachmentId: payload.serverAttachmentId }
      : {}),
  });
  if (!created?._id) throw new Error("Suite was created without an id");
  if (environmentIds.length > 0) {
    try {
      await args.setSuiteEnvironments({
        suiteId: created._id,
        environmentIds,
      });
    } catch (error) {
      toast.error(
        getBillingErrorMessage(
          error,
          "Suite created, but attaching its environments failed",
        ),
      );
    }
  }
  return created;
}
