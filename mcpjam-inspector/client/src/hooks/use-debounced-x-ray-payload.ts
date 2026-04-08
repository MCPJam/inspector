import { useCallback, useEffect, useRef, useState, useLayoutEffect } from "react";
import type { UIMessage } from "ai";
import {
  getXRayPayload,
  type XRayPayloadResponse,
} from "@/lib/apis/mcp-xray-api";

const DEBOUNCE_MS = 1000;

export function useDebouncedXRayPayload({
  systemPrompt,
  messages,
  selectedServers,
  enabled = true,
}: {
  systemPrompt: string | undefined;
  messages: UIMessage[];
  selectedServers: string[];
  enabled?: boolean;
}) {
  const [payload, setPayload] = useState<XRayPayloadResponse | null>(null);
  const [loading, setLoading] = useState(() => enabled && messages.length > 0);
  const [error, setError] = useState<string | null>(null);

  const fetchPayload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getXRayPayload({
        messages,
        systemPrompt,
        selectedServers,
      });
      setPayload(response);
      setError(null);
    } catch (err) {
      if (!payloadRef.current) {
        setError(err instanceof Error ? err.message : "Failed to fetch payload");
      }
    } finally {
      setLoading(false);
    }
  }, [messages, systemPrompt, selectedServers]);

  const hasMessages = messages.length > 0;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const payloadRef = useRef<XRayPayloadResponse | null>(null);
  useLayoutEffect(() => {
    payloadRef.current = payload;
  }, [payload]);

  useEffect(() => {
    if (!hasMessages) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = null;
      setLoading(false);
      setPayload(null);
      setError(null);
      return;
    }

    // When disabled (e.g. Chat tab hides trace diagnostics), keep the last
    // payload so Raw/Trace tabs show it immediately instead of clearing and
    // waiting for debounce + network again.
    if (!enabled) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = null;
      setLoading(false);
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void fetchPayload();
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [enabled, hasMessages, fetchPayload]);

  return {
    payload,
    loading,
    error,
    refetch: fetchPayload,
    hasMessages,
  };
}
