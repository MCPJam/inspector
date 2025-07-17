"use client";

import { useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useMcp } from '@/app/context/McpContext';

/**
 * Hook to handle server selection from URL query params
 * Returns the currently selected server ID (if any)
 */
export function useServerSelection() {
  const { activeServerId, servers, setActiveServer } = useMcp();
  const searchParams = useSearchParams();
  const router = useRouter();
  
  // Get server ID from query params
  const serverParam = searchParams.get('server');
  
  useEffect(() => {
    // If server is specified in URL and exists, set as active
    if (serverParam && servers[serverParam]) {
      if (activeServerId !== serverParam) {
        setActiveServer(serverParam);
      }
    } else if (serverParam) {
      // If specified server doesn't exist, remove from URL
      const newSearchParams = new URLSearchParams(searchParams);
      newSearchParams.delete('server');
      router.replace(`${window.location.pathname}?${newSearchParams.toString()}`);
    }
  }, [serverParam, servers, activeServerId, setActiveServer, router, searchParams]);
  
  return activeServerId;
}