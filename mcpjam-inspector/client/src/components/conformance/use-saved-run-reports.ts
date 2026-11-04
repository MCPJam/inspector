/**
 * The suite reports of a saved conformance run, read once per page and shared
 * by the advice section and the suite rows.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchArtifact } from "@/lib/artifact-urls";
import {
  reportAdviceGroups,
  type SavedReportAdvisory,
} from "./ConformanceAdvice";

/** One check of a saved suite, as its report stores it. */
export type SavedReportCase = {
  id: string;
  title: string;
  status: string;
  skipReason?: string;
  error?: string;
  /** Left out of the score: a profile's pending check or an unscored OAuth step. */
  pending?: boolean;
};

/** A saved suite report, as far as the run page reads it. */
export type SavedReportJson = {
  groups?: Array<{ cases?: SavedReportCase[] }>;
  advisories?: unknown;
};

/** Read one suite's report from its link, once per suite. */
export type LoadReport = (suiteKind: string, url: string) => Promise<SavedReportJson>;

/**
 * Each saved suite's report, fetched once and shared by the advice section
 * and the suite's checks. Read on page load, not when a suite opens: the
 * advice count is one of the first things the page shows.
 */
export function useSavedRunReports(
  runId: string,
  reports: ReadonlyArray<{ suiteKind: string; reportUrl?: string | null }>,
) {
  // Keyed by run too: the page can move to another run without remounting.
  const cache = useRef(new Map<string, Promise<SavedReportJson>>());
  const loadReport = useCallback<LoadReport>(
    (suiteKind, url) => {
      const key = `${runId}:${suiteKind}`;
      let pending = cache.current.get(key);
      if (!pending) {
        pending = fetchArtifact(url).then((response) => {
          // An expired link answers with an error body; never show that as the
          // report. `fetchArtifact` renews the link and retries once.
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<SavedReportJson>;
        });
        cache.current.set(key, pending);
      }
      return pending;
    },
    [runId],
  );

  const [advisories, setAdvisories] = useState<
    Record<string, SavedReportAdvisory[]>
  >({});
  // The signed links renew over time, so the effect keys on which suites
  // have a report and reads the current links from here.
  const urls = useRef(new Map<string, string>());
  urls.current = new Map(
    reports.flatMap((report) =>
      report.reportUrl ? [[report.suiteKind, report.reportUrl] as const] : [],
    ),
  );
  const withReport = [...urls.current.keys()].join(",");
  useEffect(() => {
    let cancelled = false;
    for (const [suiteKind, url] of urls.current) {
      loadReport(suiteKind, url)
        .then((json) => {
          if (cancelled || !Array.isArray(json.advisories)) return;
          const list = json.advisories as SavedReportAdvisory[];
          setAdvisories((current) => ({
            ...current,
            [`${runId}:${suiteKind}`]: list,
          }));
        })
        .catch(() => {
          // No advice for this suite; its row says the report is missing.
        });
    }
    return () => {
      cancelled = true;
    };
  }, [runId, withReport, loadReport]);

  const advice = reportAdviceGroups(
    reports.map((report) => ({
      suiteKind: report.suiteKind,
      advisories: advisories[`${runId}:${report.suiteKind}`],
    })),
  );
  return { advice, loadReport };
}
