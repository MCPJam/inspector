import { randomUUID } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

const CONFIG_DIR = join(homedir(), ".mcpjam");
const USER_ID_FILE = join(CONFIG_DIR, "user-id.json");

interface UserConfig {
  userId: string;
  createdAt: string;
}

/**
 * Gets or creates a unique user ID stored locally
 * @returns A persistent unique identifier for this user
 */
export function getUserId(): string {
  try {
    // Ensure config directory exists
    if (!existsSync(CONFIG_DIR)) {
      mkdirSync(CONFIG_DIR, { recursive: true });
    }

    // Check if user ID file exists
    if (existsSync(USER_ID_FILE)) {
      const configData = readFileSync(USER_ID_FILE, "utf8");
      const config: UserConfig = JSON.parse(configData);

      // Validate that we have a valid userId
      if (config.userId && typeof config.userId === "string") {
        return config.userId;
      }
    }

    // Generate new user ID
    const newUserId = randomUUID();
    const newConfig: UserConfig = {
      userId: newUserId,
      createdAt: new Date().toISOString(),
    };

    // Save to file
    writeFileSync(USER_ID_FILE, JSON.stringify(newConfig, null, 2));

    return newUserId;
  } catch (error) {
    // Fallback to session-based UUID if file operations fail
    console.warn("Failed to persist user ID, using session-based ID:", error);
    return randomUUID();
  }
}
