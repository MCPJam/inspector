export interface SavedRequest {
  id: string;
  serverKey: string;
  serverName?: string;
  toolName: string;
  title: string;
  description?: string;
  parameters: Record<string, any>;
  isFavorite?: boolean;
  createdAt: string; // ISO string
  updatedAt: string; // ISO string
}
