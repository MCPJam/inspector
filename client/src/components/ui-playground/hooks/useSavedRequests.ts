/**
 * useSavedRequests Hook
 *
 * Manages saved requests state and operations for the UI Playground.
 * Encapsulates localStorage interactions and provides a clean API
 * for loading, saving, duplicating, and managing saved requests.
 */

import { useState, useEffect, useCallback, useMemo } from "react";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { SavedRequest } from "@/lib/types/request-types";
import type { FormField } from "@/lib/tool-form";
import {
  listSavedRequests,
  saveRequest,
  deleteRequest,
  duplicateRequest,
  updateRequestMeta,
} from "@/lib/request-storage";
import {
  generateFormFieldsFromSchema,
  applyParametersToFields,
  buildParametersFromFields,
} from "@/lib/tool-form";
import { DURATIONS } from "../constants";

export interface UseSavedRequestsOptions {
  serverKey: string;
  tools: Record<string, Tool>;
  formFields: FormField[];
  selectedTool: string | null;
  setSelectedTool: (tool: string | null) => void;
  setFormFields: (fields: FormField[]) => void;
}

export interface SaveDialogState {
  isOpen: boolean;
  editingRequestId: string | null;
  defaults: { title: string; description?: string };
}

export interface UseSavedRequestsReturn {
  // Data
  savedRequests: SavedRequest[];
  highlightedRequestId: string | null;

  // Save dialog state
  saveDialogState: SaveDialogState;

  // Filtered requests (for search)
  getFilteredRequests: (searchQuery: string) => SavedRequest[];

  // Actions
  openSaveDialog: () => void;
  closeSaveDialog: () => void;
  handleSaveDialogSubmit: (data: {
    title: string;
    description?: string;
  }) => void;
  handleLoadRequest: (req: SavedRequest) => void;
  handleDeleteRequest: (id: string) => void;
  handleDuplicateRequest: (req: SavedRequest) => void;
  handleRenameRequest: (req: SavedRequest) => void;
}

export function useSavedRequests({
  serverKey,
  tools,
  formFields,
  selectedTool,
  setSelectedTool,
  setFormFields,
}: UseSavedRequestsOptions): UseSavedRequestsReturn {
  // Saved requests state
  const [savedRequests, setSavedRequests] = useState<SavedRequest[]>([]);
  const [highlightedRequestId, setHighlightedRequestId] = useState<
    string | null
  >(null);

  // Save dialog state
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);
  const [dialogDefaults, setDialogDefaults] = useState<{
    title: string;
    description?: string;
  }>({ title: "" });

  // Pending parameters to apply after tool selection (fixes race condition)
  const [pendingLoad, setPendingLoad] = useState<{
    toolName: string;
    parameters: Record<string, unknown>;
  } | null>(null);

  // Load saved requests when server changes
  useEffect(() => {
    if (serverKey && serverKey !== "none") {
      setSavedRequests(listSavedRequests(serverKey));
    } else {
      setSavedRequests([]);
    }
  }, [serverKey]);

  // Apply pending parameters when tool changes (fixes setTimeout race condition)
  useEffect(() => {
    if (
      pendingLoad &&
      selectedTool === pendingLoad.toolName &&
      tools[pendingLoad.toolName]
    ) {
      const fields = generateFormFieldsFromSchema(
        tools[pendingLoad.toolName].inputSchema,
      );
      const updatedFields = applyParametersToFields(
        fields,
        pendingLoad.parameters,
      );
      setFormFields(updatedFields);
      setPendingLoad(null);
    }
  }, [pendingLoad, selectedTool, tools, setFormFields]);

  // Highlight flash effect
  const flashHighlight = useCallback((id: string) => {
    setHighlightedRequestId(id);
    const timeout = setTimeout(
      () => setHighlightedRequestId(null),
      DURATIONS.HIGHLIGHT_FLASH,
    );
    return () => clearTimeout(timeout);
  }, []);

  // Filter saved requests by search query
  const getFilteredRequests = useCallback(
    (searchQuery: string): SavedRequest[] => {
      if (!searchQuery.trim()) return savedRequests;
      const query = searchQuery.trim().toLowerCase();
      return savedRequests.filter((req) => {
        const haystack =
          `${req.title} ${req.description ?? ""} ${req.toolName}`.toLowerCase();
        return haystack.includes(query);
      });
    },
    [savedRequests],
  );

  // Open save dialog for current tool
  const openSaveDialog = useCallback(() => {
    if (!selectedTool) return;
    setEditingRequestId(null);
    setDialogDefaults({ title: selectedTool, description: "" });
    setIsDialogOpen(true);
  }, [selectedTool]);

  // Close save dialog
  const closeSaveDialog = useCallback(() => {
    setIsDialogOpen(false);
    setEditingRequestId(null);
  }, []);

  // Handle save dialog submission
  const handleSaveDialogSubmit = useCallback(
    ({ title, description }: { title: string; description?: string }) => {
      if (editingRequestId) {
        // Renaming existing request
        updateRequestMeta(serverKey, editingRequestId, { title, description });
        setSavedRequests(listSavedRequests(serverKey));
        setEditingRequestId(null);
        setIsDialogOpen(false);
        flashHighlight(editingRequestId);
        return;
      }

      // Saving new request
      if (!selectedTool) return;
      const params = buildParametersFromFields(formFields);
      const newRequest = saveRequest(serverKey, {
        title,
        description,
        toolName: selectedTool,
        parameters: params,
      });
      setSavedRequests(listSavedRequests(serverKey));
      setIsDialogOpen(false);
      if (newRequest?.id) {
        flashHighlight(newRequest.id);
      }
    },
    [editingRequestId, serverKey, formFields, selectedTool, flashHighlight],
  );

  // Load a saved request
  const handleLoadRequest = useCallback(
    (req: SavedRequest) => {
      // Set pending load to apply parameters after tool selection
      setPendingLoad({
        toolName: req.toolName,
        parameters: req.parameters,
      });
      setSelectedTool(req.toolName);
    },
    [setSelectedTool],
  );

  // Delete a saved request
  const handleDeleteRequest = useCallback(
    (id: string) => {
      deleteRequest(serverKey, id);
      setSavedRequests(listSavedRequests(serverKey));
    },
    [serverKey],
  );

  // Duplicate a saved request
  const handleDuplicateRequest = useCallback(
    (req: SavedRequest) => {
      const duplicated = duplicateRequest(serverKey, req.id);
      setSavedRequests(listSavedRequests(serverKey));
      if (duplicated?.id) {
        flashHighlight(duplicated.id);
      }
    },
    [serverKey, flashHighlight],
  );

  // Open rename dialog for a request
  const handleRenameRequest = useCallback((req: SavedRequest) => {
    setEditingRequestId(req.id);
    setDialogDefaults({ title: req.title, description: req.description });
    setIsDialogOpen(true);
  }, []);

  // Memoize dialog state object
  const saveDialogState = useMemo(
    (): SaveDialogState => ({
      isOpen: isDialogOpen,
      editingRequestId,
      defaults: dialogDefaults,
    }),
    [isDialogOpen, editingRequestId, dialogDefaults],
  );

  return {
    savedRequests,
    highlightedRequestId,
    saveDialogState,
    getFilteredRequests,
    openSaveDialog,
    closeSaveDialog,
    handleSaveDialogSubmit,
    handleLoadRequest,
    handleDeleteRequest,
    handleDuplicateRequest,
    handleRenameRequest,
  };
}
