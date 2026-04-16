"use client";

/**
 * Tiny client helper: while a release.yml run is in-flight, calls
 * `router.refresh()` every N ms so the server component re-fetches jobs and
 * re-renders the stepper. `ReleaseProgress` only mounts this while an active
 * run exists — so the interval stops as soon as the run completes.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function ReleaseProgressRefresher({
  intervalMs = 10_000
}: {
  intervalMs?: number;
}) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
