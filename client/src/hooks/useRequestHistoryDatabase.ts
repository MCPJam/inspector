/**
 * React hook for managing request history in the shared database
 */

import { useState, useEffect, useCallback } from 'react';
import { McpJamRequest } from '@/lib/types/requestTypes';

export interface RequestHistoryState {
  requests: McpJamRequest[];
  isLoading: boolean;
  error: string | null;
}

export function useRequestHistoryDatabase() {
  const [state, setState] = useState<RequestHistoryState>({
    requests: [],
    isLoading: true,
    error: null,
  });

  // Load requests from database
  const loadRequests = useCallback(async () => {
    try {
      setState(prev => ({ ...prev, isLoading: true, error: null }));
      
      // For now, we'll load from localStorage as a fallback
      // This will be replaced with actual database operations
      const stored = localStorage.getItem('mcpjam_saved_requests');
      let requests: McpJamRequest[] = [];
      
      if (stored) {
        const data = JSON.parse(stored);
        requests = data.requests || [];
        
        // Convert date strings back to Date objects
        requests = requests.map(request => ({
          ...request,
          createdAt: new Date(request.createdAt),
          updatedAt: new Date(request.updatedAt),
        }));
      }

      setState(prev => ({
        ...prev,
        requests,
        isLoading: false,
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setState(prev => ({ ...prev, error: errorMessage, isLoading: false }));
      console.error('❌ Failed to load request history:', error);
    }
  }, []);

  // Save requests to database
  const saveRequests = useCallback(async (requests: McpJamRequest[]) => {
    try {
      const collection = {
        requests,
        version: "1.0.0",
        exportedAt: new Date(),
      };
      localStorage.setItem('mcpjam_saved_requests', JSON.stringify(collection));
      setState(prev => ({ ...prev, requests }));
    } catch (error) {
      console.error('❌ Failed to save request history:', error);
    }
  }, []);

  // Add a new request
  const addRequest = useCallback(async (request: McpJamRequest) => {
    const newRequests = [...state.requests, request];
    await saveRequests(newRequests);
  }, [state.requests, saveRequests]);

  // Update an existing request
  const updateRequest = useCallback(async (requestId: string, updates: Partial<McpJamRequest>) => {
    const newRequests = state.requests.map(request =>
      request.id === requestId
        ? { ...request, ...updates, updatedAt: new Date() }
        : request
    );
    await saveRequests(newRequests);
  }, [state.requests, saveRequests]);

  // Remove a request
  const removeRequest = useCallback(async (requestId: string) => {
    const newRequests = state.requests.filter(request => request.id !== requestId);
    await saveRequests(newRequests);
  }, [state.requests, saveRequests]);

  // Get a specific request by ID
  const getRequest = useCallback((requestId: string): McpJamRequest | null => {
    return state.requests.find(request => request.id === requestId) || null;
  }, [state.requests]);

  // Check if a request exists
  const hasRequest = useCallback((requestId: string): boolean => {
    return state.requests.some(request => request.id === requestId);
  }, [state.requests]);

  // Clear all requests
  const clearAll = useCallback(async () => {
    localStorage.removeItem('mcpjam_saved_requests');
    setState(prev => ({ ...prev, requests: [] }));
  }, []);

  // Get requests by client ID
  const getRequestsByClient = useCallback((clientId: string): McpJamRequest[] => {
    return state.requests.filter(request => request.clientId === clientId);
  }, [state.requests]);

  // Get favorite requests
  const getFavoriteRequests = useCallback((): McpJamRequest[] => {
    return state.requests.filter(request => request.isFavorite);
  }, [state.requests]);

  // Get requests by tool name
  const getRequestsByTool = useCallback((toolName: string): McpJamRequest[] => {
    return state.requests.filter(request => request.toolName === toolName);
  }, [state.requests]);

  // Load requests on mount
  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  return {
    ...state,
    addRequest,
    updateRequest,
    removeRequest,
    getRequest,
    hasRequest,
    clearAll,
    getRequestsByClient,
    getFavoriteRequests,
    getRequestsByTool,
    reload: loadRequests,
  };
} 