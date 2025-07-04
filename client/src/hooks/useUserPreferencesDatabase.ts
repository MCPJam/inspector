/**
 * React hook for managing user preferences in the shared database
 */

import { useState, useEffect, useCallback } from 'react';

export type Theme = 'light' | 'dark' | 'system';

export interface UserPreferences {
  theme: Theme;
  uiLayout?: Record<string, unknown>;
  paneHeights?: Record<string, number>;
  autoOpenEnabled?: boolean;
  hasSeenStarModal?: boolean;
  [key: string]: unknown;
}

export interface UserPreferencesState {
  preferences: UserPreferences;
  isLoading: boolean;
  error: string | null;
}

export function useUserPreferencesDatabase() {
  const [state, setState] = useState<UserPreferencesState>({
    preferences: {
      theme: 'system',
      autoOpenEnabled: true,
      hasSeenStarModal: false,
    },
    isLoading: true,
    error: null,
  });

  // Load preferences from database
  const loadPreferences = useCallback(async () => {
    try {
      setState(prev => ({ ...prev, isLoading: true, error: null }));
      
      // Load from the actual database
      // Switch to HTTP-based database client for browser compatibility and shared database access
      const { httpBrowserDatabase: browserDatabase } = await import('../lib/database/browser-database-http');
      const preferences = await browserDatabase.getUserPreferences();

      setState(prev => ({
        ...prev,
        preferences,
        isLoading: false,
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setState(prev => ({ ...prev, error: errorMessage, isLoading: false }));
      console.error('❌ Failed to load user preferences:', error);
    }
  }, []);

  // Save preferences to database
  const savePreferences = useCallback(async (preferences: UserPreferences) => {
    try {
      // Switch to HTTP-based database client for browser compatibility and shared database access
      const { httpBrowserDatabase: browserDatabase } = await import('../lib/database/browser-database-http');
      await browserDatabase.updateUserPreferences(preferences);
      setState(prev => ({ ...prev, preferences }));
    } catch (error) {
      console.error('❌ Failed to save user preferences:', error);
    }
  }, []);

  // Update specific preference
  const updatePreference = useCallback(async <K extends keyof UserPreferences>(
    key: K,
    value: UserPreferences[K]
  ) => {
    const newPreferences = { ...state.preferences, [key]: value };
    await savePreferences(newPreferences);
  }, [state.preferences, savePreferences]);

  // Update theme
  const setTheme = useCallback(async (theme: Theme) => {
    await updatePreference('theme', theme);
  }, [updatePreference]);

  // Update auto-open setting
  const setAutoOpenEnabled = useCallback(async (enabled: boolean) => {
    await updatePreference('autoOpenEnabled', enabled);
  }, [updatePreference]);

  // Mark star modal as seen
  const setHasSeenStarModal = useCallback(async (seen: boolean) => {
    await updatePreference('hasSeenStarModal', seen);
  }, [updatePreference]);

  // Update pane height
  const setPaneHeight = useCallback(async (paneKey: string, height: number) => {
    const newPaneHeights = { ...state.preferences.paneHeights, [paneKey]: height };
    await updatePreference('paneHeights', newPaneHeights);
  }, [state.preferences.paneHeights, updatePreference]);

  // Update UI layout
  const setUILayout = useCallback(async (layout: Record<string, unknown>) => {
    await updatePreference('uiLayout', layout);
  }, [updatePreference]);

  // Load preferences on mount
  useEffect(() => {
    loadPreferences();
  }, [loadPreferences]);

  return {
    ...state,
    updatePreference,
    setTheme,
    setAutoOpenEnabled,
    setHasSeenStarModal,
    setPaneHeight,
    setUILayout,
    reload: loadPreferences,
  };
} 