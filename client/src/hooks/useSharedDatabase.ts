/**
 * React hook for managing the shared database connection and migration
 */

import { useEffect, useState, useCallback } from 'react';
import { libsqlBrowserDatabase as browserDatabase } from '../lib/database/browser-database-libsql';
import { migrator } from '../lib/database/migration';

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
      
      // Initialize the database
      await browserDatabase.initialize();
      
      // Check if migration is needed
      const needsMigration = await migrator.isMigrationNeeded();
      
      if (needsMigration) {
        console.log('🔄 Migrating data from localStorage to database...');
        const result = await migrator.performFullMigration();
        
        if (result.success) {
          console.log('✅ Migration completed successfully!');
          console.log('Migrated items:', result.migratedCounts);
          
          // Clear localStorage after successful migration
          migrator.clearLocalStorage();
        } else {
          console.error('❌ Migration failed:', result.errors);
          // Don't throw here - let the app continue with database
        }
      }
      
      setState(prev => ({
        ...prev,
        initialized: true,
        migrationCompleted: !needsMigration || true,
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