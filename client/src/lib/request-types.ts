export interface SavedRequest {
  id: string;
  title: string;
  description?: string;
  serverKey: string;
  toolName: string;
  parameters: Record<string, any>;
  isFavorite?: boolean;
  createdAt: string; // ISO string
  updatedAt: string; // ISO string
}

export interface SavedRequestCollection {
  serverKey: string;
  requests: SavedRequest[];
}

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

export type SavedRequestUpdate = Partial<Omit<SavedRequest, "id" | "serverKey" | "toolName">> & {
  parameters?: Record<string, any>;
  title?: string;
  description?: string;
  isFavorite?: boolean;
};


