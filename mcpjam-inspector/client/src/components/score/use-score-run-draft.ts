import { useCallback, useState } from "react";
import type { ScoreRunResumeRecord } from "./score-run-resume";
import { normalizeScoreEmail } from "./score-email";
import { normalizeScoreUrl } from "./score-url";

export interface ScoreRunIntent {
  serverUrl: string;
  deliveryEmail: string;
}

export type ScoreRunRestoreResult =
  | { kind: "discard" }
  | { kind: "collect-email" }
  | { kind: "run"; intent: ScoreRunIntent };

export function useScoreRunDraft() {
  const [urlInput, setUrlInput] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [serverUrl, setServerUrl] = useState<string | null>(null);

  const acceptServerUrl = useCallback((): string | null => {
    const normalizedUrl = normalizeScoreUrl(urlInput);
    if (!normalizedUrl) return null;

    setUrlInput(normalizedUrl);
    setServerUrl(normalizedUrl);
    return normalizedUrl;
  }, [urlInput]);

  const createRunIntent = useCallback((): ScoreRunIntent | null => {
    if (!serverUrl) return null;
    const deliveryEmail = normalizeScoreEmail(emailInput);
    if (!deliveryEmail) return null;

    setEmailInput(deliveryEmail);
    return { serverUrl, deliveryEmail };
  }, [emailInput, serverUrl]);

  const restoreRun = useCallback(
    (record: ScoreRunResumeRecord): ScoreRunRestoreResult => {
      const normalizedUrl = normalizeScoreUrl(record.serverUrl);
      if (!normalizedUrl) return { kind: "discard" };

      setUrlInput(normalizedUrl);
      setServerUrl(normalizedUrl);

      const deliveryEmail = normalizeScoreEmail(record.deliveryEmail ?? "");
      if (!deliveryEmail) {
        setEmailInput("");
        return { kind: "collect-email" };
      }

      setEmailInput(deliveryEmail);
      return {
        kind: "run",
        intent: { serverUrl: normalizedUrl, deliveryEmail },
      };
    },
    [],
  );

  return {
    urlInput,
    emailInput,
    setUrlInput,
    setEmailInput,
    acceptServerUrl,
    createRunIntent,
    restoreRun,
  };
}
