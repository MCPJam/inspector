import { ModelDefinition } from "@/shared/types.js";

export type SavedTest = {
  id: string;
  title: string;
  description?: string;
  prompt: string;
  expectedTools: string[];
  modelId?: ModelDefinition["id"];
  selectedServers?: string[]; // names of servers selected specifically for this test
  advancedConfig?: {
    instructions?: string;
    temperature?: number | null;
    maxSteps?: number | null;
    toolChoice?: "auto" | "none" | "required";
  };
  serverKey: string;
  createdAt: string;
  updatedAt: string;
};

const STORAGE_PREFIX = "mcp-inspector.saved-tests";

function getKey(serverKey: string): string {
  return `${STORAGE_PREFIX}:${serverKey}`;
}

export function listSavedTests(serverKey: string): SavedTest[] {
  try {
    const raw = localStorage.getItem(getKey(serverKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedTest[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveTest(
  serverKey: string,
  test: Omit<SavedTest, "id" | "createdAt" | "updatedAt" | "serverKey"> & {
    id?: string;
  },
): SavedTest {
  const now = new Date().toISOString();
  const existing = listSavedTests(serverKey);
  let final: SavedTest;
  if (test.id) {
    final = {
      id: test.id,
      title: test.title,
      description: test.description,
      prompt: test.prompt,
      expectedTools: test.expectedTools,
      modelId: test.modelId,
      selectedServers: test.selectedServers,
      advancedConfig: test.advancedConfig,
      serverKey,
      createdAt: existing.find((t) => t.id === test.id)?.createdAt || now,
      updatedAt: now,
    };
    const idx = existing.findIndex((t) => t.id === final.id);
    if (idx >= 0) existing[idx] = final;
    else existing.push(final);
  } else {
    final = {
      id: crypto.randomUUID(),
      title: test.title,
      description: test.description,
      prompt: test.prompt,
      expectedTools: test.expectedTools,
      modelId: test.modelId,
      selectedServers: test.selectedServers,
      advancedConfig: test.advancedConfig,
      serverKey,
      createdAt: now,
      updatedAt: now,
    };
    existing.unshift(final);
  }
  localStorage.setItem(getKey(serverKey), JSON.stringify(existing));
  return final;
}

export function deleteTest(serverKey: string, id: string): void {
  const existing = listSavedTests(serverKey).filter((t) => t.id !== id);
  localStorage.setItem(getKey(serverKey), JSON.stringify(existing));
}

export function getTest(serverKey: string, id: string): SavedTest | undefined {
  return listSavedTests(serverKey).find((t) => t.id === id);
}

export function duplicateTest(
  serverKey: string,
  id: string,
): SavedTest | undefined {
  const t = getTest(serverKey, id);
  if (!t) return undefined;
  return saveTest(serverKey, {
    title: `${t.title} (copy)`,
    description: t.description,
    prompt: t.prompt,
    expectedTools: t.expectedTools,
    modelId: t.modelId,
    selectedServers: t.selectedServers,
    advancedConfig: t.advancedConfig,
  });
}

export function updateTestMeta(
  serverKey: string,
  id: string,
  updates: Partial<Pick<SavedTest, "title" | "description">>,
): SavedTest | undefined {
  const existing = getTest(serverKey, id);
  if (!existing) return undefined;
  return saveTest(serverKey, {
    id,
    title: updates.title ?? existing.title,
    description: updates.description ?? existing.description,
    prompt: existing.prompt,
    expectedTools: existing.expectedTools,
    modelId: existing.modelId,
    selectedServers: existing.selectedServers,
    advancedConfig: existing.advancedConfig,
  });
}

// Re-export removed to avoid duplicate type export errors
