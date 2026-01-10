import { useState, useEffect } from "react";
import {
  getLatestProgress,
  type ProgressEvent,
} from "@/lib/apis/mcp-tasks-api";

/**
 * Hook to poll for task progress updates
 */
export function useTaskProgress(serverId: string | undefined) {
  const [progressData, setProgressData] = useState<ProgressEvent | null>(null);

  useEffect(() => {
    if (!serverId) {
      setProgressData(null);
      return;
    }

    let mounted = true;

    const fetchProgress = async () => {
      try {
        const progress = await getLatestProgress(serverId);
        if (mounted) {
          setProgressData(progress);
        }
      } catch (err) {
        console.debug("Failed to fetch progress:", err);
      }
    };

    fetchProgress();
    const interval = setInterval(fetchProgress, 500);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [serverId]);

  return {
    progress: progressData?.progress ?? 0,
    total: progressData?.total,
    message: progressData?.message,
    progressToken: progressData?.progressToken,
    timestamp: progressData?.timestamp,
  };
}
