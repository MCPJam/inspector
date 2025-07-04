/**
 * React hook for managing the shared database connection and migration
 */

import { useEffect, useState, useCallback } from 'react';

export interface DatabaseState {
  initialized: boolean;
  migrationCompleted: boolean;
  error: string | null;
  isLoading: boolean;
}

export function useSharedDatabase() {
  const [state, setState] = useState<DatabaseState>({
    initialized: false,
    migrationCompleted: false,
    error: null,
    isLoading: true,
  });

  const initializeDatabase = useCallback(async () => {
    try {
      setState(prev => ({ ...prev, isLoading: true, error: null }));
      
      // For now, we'll just simulate the database initialization
      // This will be replaced with actual database operations
      await new Promise(resolve => setTimeout(resolve, 100));
      
      setState(prev => ({
        ...prev,
        initialized: true,
        migrationCompleted: true,
        isLoading: false,
      }));
      
      console.log('✅ Database initialized successfully');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setState(prev => ({
        ...prev,
        error: errorMessage,
        isLoading: false,
      }));
      console.error('❌ Database initialization failed:', error);
    }
  }, []);

  // Initialize database on mount
  useEffect(() => {
    initializeDatabase();
  }, [initializeDatabase]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Cleanup database connection if needed
      console.log('🔄 Cleaning up database connection');
    };
  }, []);

  return {
    ...state,
    reinitialize: initializeDatabase,
  };
} 