import { Hono } from "hono";
import { z } from "zod";
import "../../types/hono"; // Type extensions
import { DynamicToolManager } from "../../services/dynamic-tool-manager.js";

const dynamicTools = new Hono();

// Schema for creating dynamic tools
const createDynamicToolSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: z.record(z.any()).optional().default({}),
  executionType: z.enum(['http', 'javascript']),
  implementation: z.object({
    url: z.string().url().optional(),
    method: z.enum(['GET', 'POST']).optional().default('POST'),
    headers: z.record(z.string()).optional().default({}),
    code: z.string().optional(),
  }),
});

// GET /list - List all dynamic tools
dynamicTools.get("/list", async (c) => {
  try {
    const mcp = c.mcpJamClientManager;
    const tools = mcp.getAllDynamicTools();
    return c.json({ tools });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// POST /create - Create a new dynamic tool
dynamicTools.post("/create", async (c) => {
  try {
    const body = await c.req.json();
    const validated = createDynamicToolSchema.parse(body);
    
    const mcp = c.mcpJamClientManager;
    
    // Check if tool with same ID already exists
    if (mcp.getDynamicTool(validated.id)) {
      return c.json({ error: `Tool with ID '${validated.id}' already exists` }, 400);
    }
    
    // Create the tool
    mcp.createDynamicTool(validated);
    
    return c.json({ 
      success: true, 
      message: `Dynamic tool '${validated.name}' created successfully`,
      toolId: validated.id 
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json({ error: "Validation error", details: err.errors }, 400);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// GET /:id - Get a specific dynamic tool
dynamicTools.get("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const mcp = c.mcpJamClientManager;
    const tool = mcp.getDynamicTool(id);
    
    if (!tool) {
      return c.json({ error: `Tool with ID '${id}' not found` }, 404);
    }
    
    return c.json({ tool });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// DELETE /:id - Delete a dynamic tool
dynamicTools.delete("/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const mcp = c.mcpJamClientManager;
    const deleted = mcp.deleteDynamicTool(id);
    
    if (!deleted) {
      return c.json({ error: `Tool with ID '${id}' not found` }, 404);
    }
    
    return c.json({ 
      success: true, 
      message: `Dynamic tool '${id}' deleted successfully` 
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

// POST /test/:id - Test a dynamic tool
dynamicTools.post("/test/:id", async (c) => {
  try {
    const id = c.req.param("id");
    const { input = {} } = await c.req.json();
    
    const mcp = c.mcpJamClientManager;
    const toolDef = mcp.getDynamicTool(id);
    
    if (!toolDef) {
      return c.json({ error: `Tool with ID '${id}' not found` }, 404);
    }
    
    // Test the tool execution directly using the dynamic tool manager
    const dynamicToolManager = new DynamicToolManager();
    
    try {
      let result;
      switch (toolDef.executionType) {
        case 'http':
          result = await dynamicToolManager.executeHttpTool(toolDef, input);
          break;
        default:
          throw new Error(`Unsupported execution type: ${toolDef.executionType}`);
      }
      
      return c.json({ 
        success: true, 
        toolId: id,
        input,
        result 
      });
    } catch (executionError) {
      return c.json({ 
        success: false,
        error: `Tool execution failed: ${executionError instanceof Error ? executionError.message : String(executionError)}`,
        toolId: id,
        input 
      }, 500);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: msg }, 500);
  }
});

export default dynamicTools;
