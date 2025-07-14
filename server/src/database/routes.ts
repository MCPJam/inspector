/**
 * Database API routes for MCPJam Inspector
 * Basic endpoints for app metadata operations
 */

import { Router } from "express";
import { DatabaseManager } from "./DatabaseManager.js";
import { AppMetadata } from "./types.js";

export function createDatabaseRoutes(databaseManager: DatabaseManager): Router {
  const router = Router();

  // Error handler wrapper
  const asyncHandler = (fn: Function) => (req: any, res: any, next: any) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

  // ============================================================================
  // APP METADATA OPERATIONS
  // ============================================================================

  // Get all metadata
  router.get(
    "/metadata",
    asyncHandler(async (req: any, res: any) => {
      const metadata = await databaseManager.getAllMetadata();
      res.json({
        success: true,
        data: metadata,
        count: metadata.length,
      });
    }),
  );

  // Get single metadata value
  router.get(
    "/metadata/:key",
    asyncHandler(async (req: any, res: any) => {
      const value = await databaseManager.getMetadata(req.params.key);
      if (value === null) {
        res.status(404).json({
          success: false,
          error: "Metadata key not found",
        });
        return;
      }

      res.json({
        success: true,
        data: { key: req.params.key, value },
      });
    }),
  );

  // Set metadata value
  router.post(
    "/metadata/:key",
    asyncHandler(async (req: any, res: any) => {
      const { value } = req.body;

      if (value === undefined) {
        res.status(400).json({
          success: false,
          error: "Missing required field: value",
        });
        return;
      }

      await databaseManager.setMetadata(req.params.key, value);
      res.json({
        success: true,
        message: "Metadata stored successfully",
      });
    }),
  );

  // Delete metadata key
  router.delete(
    "/metadata/:key",
    asyncHandler(async (req: any, res: any) => {
      await databaseManager.deleteMetadata(req.params.key);
      res.json({
        success: true,
        message: "Metadata deleted successfully",
      });
    }),
  );

  // ============================================================================
  // HEALTH CHECK
  // ============================================================================

  router.get(
    "/health",
    asyncHandler(async (req: any, res: any) => {
      res.json({
        success: true,
        message: "Database API is healthy",
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // Error handling middleware
  router.use((error: any, req: any, res: any, next: any) => {
    console.error("Database API Error:", error);

    const statusCode = error.status || 500;
    const message = error.message || "Internal server error";

    res.status(statusCode).json({
      success: false,
      error: message,
      code: error.code,
      ...(process.env.NODE_ENV === "development" && { stack: error.stack }),
    });
  });

  return router;
}
