import { ipcMain, dialog, BrowserWindow } from 'electron';
import fs from 'fs/promises';
import path from 'path';

export function registerFileListeners(mainWindow: BrowserWindow): void {
  // Open file dialog
  ipcMain.handle('dialog:open', async (event, options = {}) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'JSON Files', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      ...options,
    });
    
    return result.canceled ? undefined : result.filePaths;
  });
  
  // Save file dialog
  ipcMain.handle('dialog:save', async (event, data) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      filters: [
        { name: 'JSON Files', extensions: ['json'] },
        { name: 'All Files', extensions: ['*'] }
      ],
    });
    
    if (!result.canceled && result.filePath) {
      try {
        await fs.writeFile(result.filePath, JSON.stringify(data, null, 2));
        return result.filePath;
      } catch (error) {
        throw new Error(`Failed to save file: ${error}`);
      }
    }
    
    return undefined;
  });
  
  // Show message box
  ipcMain.handle('dialog:message', async (event, options) => {
    return await dialog.showMessageBox(mainWindow, options);
  });
}