-- MCPJam Inspector Database Schema
-- Basic libSQL/SQLite foundation for future features

-- Basic example table for database foundation
CREATE TABLE IF NOT EXISTS app_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Initialize with version info
INSERT OR IGNORE INTO app_metadata (key, value) VALUES ('db_version', '1.0.0');
INSERT OR IGNORE INTO app_metadata (key, value) VALUES ('created_at', datetime('now'));

-- Trigger for automatic timestamp updates
CREATE TRIGGER IF NOT EXISTS update_app_metadata_timestamp 
    AFTER UPDATE ON app_metadata
    BEGIN
        UPDATE app_metadata SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
    END;