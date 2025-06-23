import fs from 'fs';
import path from 'path';

export function logToFile(
  level: string,
  subsystem: string,
  message: string,
  metadata?: any,
  logFileName?: string
) {
  const timestamp = new Date().toISOString();
  const entry = `${timestamp} [${subsystem}] [${level}] ${message} { metadata: ${JSON.stringify(metadata)} }\n`;
  const logsDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir);
  }
  const logFile = path.join(logsDir, logFileName || 'inspector.log');
  console.log('[LOGGER] Writing to:', logFile);
  fs.appendFileSync(logFile, entry);
} 