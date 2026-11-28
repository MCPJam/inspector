import { useEffect, useState } from "react";
import { useConvex } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { changesOf, type MockChange } from "./mock-changes";

/**
 * The saved-server reads behind the details panel. Convex answers each with
 * the caller's own access, and answers `MOCK_SERVERS_FLAG_OFF` when the flag
 * is off, which shows as an error here. Nothing is cached across opens: the
 * policy is read again every time the panel opens.
 */
const getMock = makeFunctionReference<
  "query",
  { mockId: string },
  { definitionJson: string; version: number }
>("mockServers:getMock");

const getMockPolicy = makeFunctionReference<
  "query",
  { mockId: string },
  { forwarding: "allow" | "block" }
>("mockPolicy:getForMock");

export type MockDetails =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      changes: MockChange[];
      policy: "allow" | "block";
    };

/**
 * Reads a mock's saved changes and policy. `headVersion` comes from the live
 * server list, so a newly saved version reads again; `open` reads again each
 * time the panel opens.
 */
export function useMockDetails(
  mockId: string,
  headVersion: number,
  open: boolean
): MockDetails {
  const convex = useConvex();
  const [details, setDetails] = useState<MockDetails>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    // A new read starts from loading, so a panel reopened after the policy
    // changed does not show the old answer as current. The same object is kept
    // when it is already loading, so this adds no render.
    setDetails((now) =>
      now.status === "loading" ? now : { status: "loading" }
    );
    Promise.all([
      convex.query(getMock, { mockId }),
      convex.query(getMockPolicy, { mockId }),
    ]).then(
      ([mock, policy]) => {
        if (cancelled) return;
        try {
          setDetails({
            status: "ready",
            changes: changesOf(JSON.parse(mock.definitionJson)),
            policy: policy.forwarding,
          });
        } catch {
          setDetails({ status: "error" });
        }
      },
      () => {
        if (!cancelled) setDetails({ status: "error" });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [convex, mockId, headVersion, open]);

  return details;
}
