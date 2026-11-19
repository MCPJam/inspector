/**
 * The protocol revision a run negotiated, handed to every check row of the
 * run so its "Source" link opens the spec section of that revision. Context
 * rather than a prop, so the suite lists do not thread it through each row.
 */

import { createContext, useContext, type ReactNode } from "react";

const SourceVersionContext = createContext<string | null | undefined>(
  undefined,
);

/** The revision rows below link to. Absent ⇒ the current spec revision. */
export function useConformanceSourceVersion(): string | null | undefined {
  return useContext(SourceVersionContext);
}

export function ConformanceSourceVersion({
  version,
  children,
}: {
  version: string | null | undefined;
  children: ReactNode;
}) {
  return (
    <SourceVersionContext.Provider value={version}>
      {children}
    </SourceVersionContext.Provider>
  );
}

/** The bordered box around a run's suites, telling each row the revision. */
export function SuiteList({
  version,
  children,
}: {
  version: string | null | undefined;
  children: ReactNode;
}) {
  return (
    <ConformanceSourceVersion version={version}>
      <div className="mt-3 overflow-hidden rounded-lg border border-border bg-popover">
        {children}
      </div>
    </ConformanceSourceVersion>
  );
}

/**
 * The revision a live run speaks: the one its score recorded, else the one
 * the connection negotiated, else the pinned one. Undefined on "auto" before
 * anything negotiated.
 */
export function sourceVersionOf(
  snapshot: {
    pooledScore?: { protocolVersion?: string } | null;
    resolvedProtocolVersion?: string | null;
  },
  pin: string,
): string | undefined {
  return (
    snapshot.pooledScore?.protocolVersion ??
    snapshot.resolvedProtocolVersion ??
    (pin === "auto" ? undefined : pin)
  );
}
