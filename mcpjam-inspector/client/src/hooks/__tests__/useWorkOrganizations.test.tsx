import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFunctionName } from "convex/server";
import type { Organization } from "@/hooks/useOrganizations";
import type {
  OrganizationAccessRequestRow,
  SignupCompanyAnswer,
} from "../useWorkOrganizations";

const convex = vi.hoisted(() => ({
  answer: undefined as SignupCompanyAnswer | Error | undefined,
  requests: undefined as OrganizationAccessRequestRow[] | undefined,
  stepRequests: [] as unknown[],
  listArgs: [] as unknown[],
  mutations: new Map<string, ReturnType<typeof vi.fn>>(),
}));

vi.mock("convex/react", async () => {
  const { getFunctionName: nameOf } = await import("convex/server");
  return {
    // Soft reads: a skipped one sends no request at all.
    useQueries: (queries: Record<string, { query: never; args: unknown }>) =>
      Object.fromEntries(
        Object.entries(queries).map(([key, { query, args }]) => {
          if (nameOf(query) !== "workOrganizations:getSignupCompanyStep") {
            return [key, undefined];
          }
          convex.stepRequests.push(args);
          return [key, convex.answer];
        }),
      ),
    useQuery: (ref: never, args: unknown) => {
      if (nameOf(ref) === "projectAccessRequests:listForOrganization") {
        convex.listArgs.push(args);
        return args === "skip" ? undefined : convex.requests;
      }
      return undefined;
    },
    useMutation: (ref: never) => {
      const name = nameOf(ref);
      if (!convex.mutations.has(name)) convex.mutations.set(name, vi.fn());
      return convex.mutations.get(name);
    },
  };
});

const organizations = vi.hoisted(() => ({ list: [] as Organization[] }));
vi.mock("@/hooks/useOrganizations", () => ({
  useOrganizationQueries: () => ({ sortedOrganizations: organizations.list }),
}));

import {
  completeCompanyStepRef,
  personalOrganizationNameOf,
  resolveSignupCompanyRef,
  shownStepOf,
  useOrganizationJoinRequests,
  useSignupCompanyStep,
} from "../useWorkOrganizations";

const JOIN: SignupCompanyAnswer = {
  step: "join",
  organizationId: "org_acme",
  name: "Acme",
  domain: "acme.com",
};

function mutation(ref: Parameters<typeof getFunctionName>[0]) {
  const name = getFunctionName(ref);
  if (!convex.mutations.has(name)) convex.mutations.set(name, vi.fn());
  return convex.mutations.get(name)!;
}

function org(overrides: Partial<Organization>): Organization {
  return {
    _id: "org_other",
    name: "Other",
    createdBy: "user_jo",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderGate(initial: { eligible: boolean; roleGateShown: boolean }) {
  return renderHook((props) => useSignupCompanyStep(props), {
    initialProps: initial,
  });
}

describe("shownStepOf", () => {
  it("shows join and owner answers that carry an organization, name and domain", () => {
    expect(shownStepOf(JOIN)).toEqual(JOIN);
    expect(shownStepOf({ ...JOIN, step: "owner" })?.step).toBe("owner");
    expect(shownStepOf({ ...JOIN, joinWithoutApproval: true })).toEqual(JOIN);
  });

  it("shows nothing for none, a missing field, or a request already made", () => {
    // `none` is also the answer for a hidden Work organization and a public domain.
    expect(shownStepOf({ step: "none" })).toBeNull();
    expect(shownStepOf(undefined)).toBeNull();
    expect(shownStepOf({ ...JOIN, domain: undefined })).toBeNull();
    expect(shownStepOf({ ...JOIN, name: "" })).toBeNull();
    expect(shownStepOf({ ...JOIN, requestStatus: "declined" })).toBeNull();
    expect(shownStepOf({ ...JOIN, requestStatus: "pending" })).toBeNull();
  });
});

describe("personalOrganizationNameOf", () => {
  it("prefers the Personal kind, then the one they created that is not the Work one", () => {
    expect(
      personalOrganizationNameOf(
        [
          org({ _id: "org_acme", name: "Acme", isCreator: true }),
          org({ _id: "org_jo", name: "Jo's Org", kind: "personal" }),
        ],
        "org_acme",
      ),
    ).toBe("Jo's Org");
    expect(
      personalOrganizationNameOf(
        [
          org({ _id: "org_acme", name: "Acme", isCreator: true }),
          org({ _id: "org_alex", name: "Alex's Org", isCreator: true }),
        ],
        "org_acme",
      ),
    ).toBe("Alex's Org");
    expect(
      personalOrganizationNameOf(
        [org({ _id: "org_acme", name: "Acme", isCreator: true })],
        "org_acme",
      ),
    ).toBeNull();
  });
});

describe("useSignupCompanyStep", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    convex.answer = undefined;
    convex.stepRequests = [];
    convex.mutations.clear();
    organizations.list = [
      org({ _id: "org_jo", name: "Jo's Org", kind: "personal" }),
    ];
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  it("skips the step query for anyone outside the role question's population", () => {
    const { result } = renderGate({ eligible: false, roleGateShown: false });
    expect(result.current).toEqual({ kind: "hidden" });
    expect(convex.stepRequests).toEqual([]);
    expect(mutation(resolveSignupCompanyRef)).not.toHaveBeenCalled();
  });

  it("skips the step query while the role question is unanswered", () => {
    const { result } = renderGate({ eligible: true, roleGateShown: true });
    expect(result.current).toEqual({ kind: "hidden" });
    expect(convex.stepRequests).toEqual([]);
  });

  it("resolves once after the role answer and stays busy until the query answers", async () => {
    const resolve = deferred<SignupCompanyAnswer>();
    mutation(resolveSignupCompanyRef).mockReturnValue(resolve.promise);
    const { result, rerender } = renderGate({
      eligible: true,
      roleGateShown: true,
    });

    rerender({ eligible: true, roleGateShown: false });
    expect(result.current).toEqual({ kind: "resolving" });
    expect(mutation(resolveSignupCompanyRef)).toHaveBeenCalledTimes(1);
    expect(mutation(resolveSignupCompanyRef)).toHaveBeenCalledWith({});

    await act(async () => resolve.resolve(JOIN));
    // Settled, but the query has not answered yet.
    expect(result.current).toEqual({ kind: "resolving" });

    convex.answer = JOIN;
    rerender({ eligible: true, roleGateShown: false });
    expect(result.current).toMatchObject({
      kind: "show",
      step: JOIN,
      personalOrganizationName: "Jo's Org",
    });
    rerender({ eligible: true, roleGateShown: false });
    expect(mutation(resolveSignupCompanyRef)).toHaveBeenCalledTimes(1);
  });

  it("never resolves when the role question was not shown in this session", () => {
    convex.answer = { ...JOIN, step: "owner" };
    const { result } = renderGate({ eligible: true, roleGateShown: false });
    expect(mutation(resolveSignupCompanyRef)).not.toHaveBeenCalled();
    expect(result.current).toMatchObject({
      kind: "show",
      step: { step: "owner" },
    });
  });

  it("falls through to the app when resolving fails", async () => {
    mutation(resolveSignupCompanyRef).mockRejectedValue(new Error("down"));
    convex.answer = JOIN;
    const { result, rerender } = renderGate({
      eligible: true,
      roleGateShown: true,
    });
    await act(async () => rerender({ eligible: true, roleGateShown: false }));
    expect(result.current).toEqual({ kind: "hidden" });
    expect(consoleError).toHaveBeenCalledWith(
      "[signup] Failed to resolve the company step",
      expect.any(Error),
    );
  });

  it("stops waiting when the step query fails", async () => {
    mutation(resolveSignupCompanyRef).mockResolvedValue(JOIN);
    convex.answer = new Error("query failed");
    const { result, rerender } = renderGate({
      eligible: true,
      roleGateShown: true,
    });
    await act(async () => rerender({ eligible: true, roleGateShown: false }));
    expect(result.current).toEqual({ kind: "hidden" });
  });

  it("keeps a shown step until it is finished, whatever the server answers", async () => {
    convex.answer = JOIN;
    const { result, rerender } = renderGate({
      eligible: true,
      roleGateShown: false,
    });
    expect(result.current.kind).toBe("show");

    convex.answer = { step: "none" };
    rerender({ eligible: true, roleGateShown: false });
    expect(result.current).toMatchObject({ kind: "show", step: JOIN });

    act(() => {
      if (result.current.kind === "show") result.current.finish();
    });
    expect(result.current).toEqual({ kind: "hidden" });
  });

  it("asks with one completeCompanyStep call and continues with another", async () => {
    convex.answer = JOIN;
    const complete = mutation(completeCompanyStepRef);
    complete.mockResolvedValue({ ok: true });
    const { result } = renderGate({ eligible: true, roleGateShown: false });
    if (result.current.kind !== "show") throw new Error("step not shown");

    await result.current.actions.ask();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith({ choice: "ask" });
    expect([...convex.mutations.keys()]).not.toContain(
      "projectAccessRequests:requestOrganizationAccess",
    );

    await result.current.actions.continue();
    expect(complete).toHaveBeenLastCalledWith({ choice: "continue" });

    complete.mockRejectedValueOnce(new Error("down"));
    await expect(result.current.actions.ask()).rejects.toThrow("down");
  });
});

describe("useOrganizationJoinRequests", () => {
  beforeEach(() => {
    convex.listArgs = [];
    convex.requests = undefined;
    convex.mutations.clear();
  });

  it("skips the query for members and guests", () => {
    convex.requests = [];
    const { result } = renderHook(() =>
      useOrganizationJoinRequests({
        organizationId: "org_acme",
        enabled: false,
      }),
    );
    expect(convex.listArgs).toEqual(["skip"]);
    expect(result.current.requests).toEqual([]);
  });

  it("lists join requests only, and nothing while loading", () => {
    const { result, rerender } = renderHook(() =>
      useOrganizationJoinRequests({
        organizationId: "org_acme",
        enabled: true,
      }),
    );
    expect(result.current.requests).toEqual([]);
    expect(convex.listArgs).toContainEqual({ organizationId: "org_acme" });

    const join = {
      requestId: "req_jo",
      userId: "user_jo",
      name: "Jo Chen",
      email: "jo@acme.com",
      requestedAt: 1,
    };
    convex.requests = [join, { ...join, requestId: "req_p", projectId: "p_1" }];
    rerender();
    expect(result.current.requests).toEqual([join]);
  });

  it("decides through BA-8's mutation", async () => {
    const { result } = renderHook(() =>
      useOrganizationJoinRequests({
        organizationId: "org_acme",
        enabled: true,
      }),
    );
    const decide = convex.mutations.get(
      "projectAccessRequests:decideProjectAccessRequest",
    )!;
    decide.mockResolvedValue({ status: "declined", access: "pending" });
    await result.current.decide("req_jo", "decline");
    expect(decide).toHaveBeenCalledWith({
      requestId: "req_jo",
      decision: "decline",
    });
  });
});
