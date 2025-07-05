-- MCP Jam Inspector Shared Database Schema
-- This schema supports data sharing between CLI, SDK, and UI

-- Server configurations table
CREATE TABLE IF NOT EXISTS server_configs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    transport_type TEXT NOT NULL CHECK (transport_type IN ('stdio', 'sse', 'streamable-http')),
    
    -- Stdio transport fields
    command TEXT,
    args TEXT, -- JSON array of strings
    env TEXT,  -- JSON object of environment variables
    
    -- HTTP/SSE transport fields
    url TEXT,
    request_init TEXT,      -- JSON object for fetch requestInit
    event_source_init TEXT, -- JSON object for EventSource init
    reconnection_options TEXT, -- JSON object for reconnection options
    session_id TEXT,
    
    -- Common fields
    timeout INTEGER DEFAULT 30000,
    capabilities TEXT,          -- JSON object of client capabilities
    enable_server_logs BOOLEAN DEFAULT false,
    
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Request history table
CREATE TABLE IF NOT EXISTS request_history (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    tool_name TEXT NOT NULL,
    tool_definition TEXT NOT NULL,  -- JSON object of the tool definition
    parameters TEXT NOT NULL,       -- JSON object of request parameters
    client_id TEXT NOT NULL,        -- References server_configs.id
    is_favorite BOOLEAN DEFAULT false,
    tags TEXT,                      -- JSON array of tags
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (client_id) REFERENCES server_configs(id) ON DELETE CASCADE
);

-- User preferences table
CREATE TABLE IF NOT EXISTS user_preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1), -- Singleton table
    theme TEXT DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
    ui_layout TEXT,                         -- JSON object for UI layout preferences
    pane_heights TEXT,                      -- JSON object for pane height settings
    auto_open_enabled BOOLEAN DEFAULT true,
    has_seen_star_modal BOOLEAN DEFAULT false,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Provider configurations table (AI providers like OpenAI, Anthropic, etc.)
CREATE TABLE IF NOT EXISTS provider_configs (
    id TEXT PRIMARY KEY,
    provider_type TEXT NOT NULL CHECK (provider_type IN ('openai', 'anthropic', 'ollama')),
    api_key TEXT,
    base_url TEXT,
    model TEXT,
    configuration TEXT,  -- JSON object for additional provider-specific config
    is_active BOOLEAN DEFAULT true,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(provider_type, model)
);

-- Application settings table
CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    value_type TEXT NOT NULL CHECK (value_type IN ('string', 'number', 'boolean', 'json')),
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Sessions table (for tracking CLI/UI usage sessions)
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    session_type TEXT NOT NULL CHECK (session_type IN ('cli', 'ui', 'sdk')),
    selected_server_id TEXT,
    last_command TEXT,
    last_args TEXT,
    last_sse_url TEXT,
    last_transport_type TEXT,
    last_bearer_token TEXT,
    last_header_name TEXT,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    
    FOREIGN KEY (selected_server_id) REFERENCES server_configs(id) ON DELETE SET NULL
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_request_history_client_id ON request_history(client_id);
CREATE INDEX IF NOT EXISTS idx_request_history_tool_name ON request_history(tool_name);
CREATE INDEX IF NOT EXISTS idx_request_history_is_favorite ON request_history(is_favorite);
CREATE INDEX IF NOT EXISTS idx_request_history_created_at ON request_history(created_at);
CREATE INDEX IF NOT EXISTS idx_provider_configs_provider_type ON provider_configs(provider_type);
CREATE INDEX IF NOT EXISTS idx_sessions_session_type ON sessions(session_type);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);

-- Triggers for updating timestamps
CREATE TRIGGER IF NOT EXISTS update_server_configs_timestamp 
    AFTER UPDATE ON server_configs
    FOR EACH ROW
    BEGIN
        UPDATE server_configs SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS update_request_history_timestamp 
    AFTER UPDATE ON request_history
    FOR EACH ROW
    BEGIN
        UPDATE request_history SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS update_user_preferences_timestamp 
    AFTER UPDATE ON user_preferences
    FOR EACH ROW
    BEGIN
        UPDATE user_preferences SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS update_provider_configs_timestamp 
    AFTER UPDATE ON provider_configs
    FOR EACH ROW
    BEGIN
        UPDATE provider_configs SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS update_app_settings_timestamp 
    AFTER UPDATE ON app_settings
    FOR EACH ROW
    BEGIN
        UPDATE app_settings SET updated_at = CURRENT_TIMESTAMP WHERE key = NEW.key;
    END;

-- Insert default user preferences
INSERT OR IGNORE INTO user_preferences (id) VALUES (1);

-- Insert default app settings
INSERT OR IGNORE INTO app_settings (key, value, value_type, description) VALUES
    ('MCP_SERVER_REQUEST_TIMEOUT', '30000', 'number', 'Maximum time in milliseconds to wait for a response from the MCP server before timing out'),
    ('MCP_REQUEST_TIMEOUT_RESET_ON_PROGRESS', 'true', 'boolean', 'Whether to reset the timeout on progress notifications'),
    ('MCP_REQUEST_MAX_TOTAL_TIMEOUT', '300000', 'number', 'Maximum total time in milliseconds to wait for a response from the MCP server before timing out'),
    ('MCP_PROXY_FULL_ADDRESS', 'http://localhost:6277', 'string', 'The full address of the MCP Proxy Server'); 