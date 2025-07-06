import { MCPJamServerConfig } from "@/lib/types/serverTypes";

export interface ConnectionPersistenceResponse {
  success: boolean;
  message?: string;
  error?: string;
  details?: string;
  connections?: Record<string, MCPJamServerConfig> | null;
  source?: "file" | "none";
  filePath?: string;
}

const API_BASE_URL = window.location.hostname === 'localhost'
  ? 'http://localhost:6277' 
  : window.location.origin;

export class ConnectionPersistenceService {
  private static async makeRequest(
    url: string, 
    options: RequestInit = {}
  ): Promise<ConnectionPersistenceResponse> {
    try {
      const response = await fetch(`${API_BASE_URL}${url}`, {
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        ...options,
      });

      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }

      return data;
    } catch (error) {
      console.error('ConnectionPersistenceService error:', error);
      throw error;
    }
  }

  /**
   * Load connections from file
   */
  static async loadConnections(): Promise<ConnectionPersistenceResponse> {
    return this.makeRequest('/connections');
  }

  /**
   * Save connections to file
   */
  static async saveConnections(
    connections: Record<string, MCPJamServerConfig>
  ): Promise<ConnectionPersistenceResponse> {
    return this.makeRequest('/connections', {
      method: 'POST',
      body: JSON.stringify({ connections }),
    });
  }

  /**
   * Export connections as downloadable file
   */
  static async exportConnections(): Promise<void> {
    try {
      const response = await fetch(`${API_BASE_URL}/connections/export`);
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      // Get filename from Content-Disposition header or use default
      const contentDisposition = response.headers.get('content-disposition');
      const filenameMatch = contentDisposition?.match(/filename="(.+)"/);
      const filename = filenameMatch?.[1] || `mcp-connections-${new Date().toISOString().split('T')[0]}.json`;

      // Create blob and download
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('Export connections error:', error);
      throw error;
    }
  }

  /**
   * Import connections from data
   */
  static async importConnections(
    connections: Record<string, MCPJamServerConfig>,
    merge: boolean = false
  ): Promise<ConnectionPersistenceResponse> {
    return this.makeRequest('/connections/import', {
      method: 'POST',
      body: JSON.stringify({ connections, merge }),
    });
  }

  /**
   * Import connections from JSON file
   */
  static async importConnectionsFromFile(
    file: File,
    merge: boolean = false
  ): Promise<ConnectionPersistenceResponse> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      
      reader.onload = async (e) => {
        try {
          const content = e.target?.result as string;
          const connections = JSON.parse(content);
          
          if (!connections || typeof connections !== 'object') {
            throw new Error('Invalid JSON file format');
          }

          const result = await this.importConnections(connections, merge);
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };

      reader.onerror = () => {
        reject(new Error('Failed to read file'));
      };

      reader.readAsText(file);
    });
  }
}