import { ClientSession } from '@modelcontextprotocol/sdk/dist/clientSession.js';
import { createStdioTransport } from '@modelcontextprotocol/sdk/dist/transports/stdio/clientStdioTransport.js';
import { createSSETransport } from '@modelcontextprotocol/sdk/dist/transports/sse/clientSSETransport.js';
import { spawnSync, spawn } from 'child_process';
import { Anthropic } from '@anthropic-ai/sdk';
import dotenv from 'dotenv';

dotenv.config();

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export class MCPClient {
  constructor() {
    this.session = null;
    this.stdio = null;
    this.tools = [];
    this.transport = null;
    this.childProcess = null;
  }

  /**
   * Connect to an MCP server using stdio transport
   * @param {string} command - The command to run (e.g., 'node', 'python')
   * @param {string[]} args - The arguments to pass to the command
   * @param {Object} env - Environment variables to pass to the server
   */
  async connectViaStdio(command, args, env = {}) {
    try {
      console.log(`Connecting to MCP server: ${command} ${args.join(' ')}`);
      
      const { stdio, write, childProcess } = await createStdioTransport({
        command,
        args,
        env: { ...process.env, ...env },
      });
      
      this.childProcess = childProcess;
      this.stdio = stdio;
      this.transport = 'stdio';
      
      this.session = new ClientSession(stdio, write);
      await this.session.initialize();
      
      const toolsResponse = await this.session.listTools();
      this.tools = toolsResponse.tools;
      
      console.log(`Connected to server with tools: ${this.tools.map(t => t.name).join(', ')}`);
      return true;
    } catch (error) {
      console.error('Failed to connect to MCP server:', error);
      return false;
    }
  }

  /**
   * Connect to an MCP server using SSE transport
   * @param {string} serverUrl - The URL of the SSE endpoint
   * @param {string} authToken - Optional authentication token
   */
  async connectViaSSE(serverUrl, authToken = null) {
    try {
      console.log(`Connecting to MCP server via SSE: ${serverUrl}`);
      
      const headers = {};
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }
      
      const { read, write } = await createSSETransport({
        serverUrl,
        headers,
      });
      
      this.stdio = read;
      this.transport = 'sse';
      
      this.session = new ClientSession(read, write);
      await this.session.initialize();
      
      const toolsResponse = await this.session.listTools();
      this.tools = toolsResponse.tools;
      
      console.log(`Connected to server with tools: ${this.tools.map(t => t.name).join(', ')}`);
      return true;
    } catch (error) {
      console.error('Failed to connect to MCP server via SSE:', error);
      return false;
    }
  }

  /**
   * Process a user query using Claude and available tools
   * @param {string} query - The user's input query
   * @returns {string} - The final response
   */
  async processQuery(query) {
    try {
      const messages = [{
        role: 'user',
        content: query
      }];

      // Convert MCP tools to Claude's format
      const availableTools = this.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema
      }));

      // Make initial call to Claude
      let response = await anthropic.messages.create({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 1000,
        messages,
        tools: availableTools
      });

      // Process response and handle tool calls
      const finalText = [];
      const assistantMessageContent = [];

      for (const content of response.content) {
        if (content.type === 'text') {
          finalText.push(content.text);
          assistantMessageContent.push(content);
        } else if (content.type === 'tool_use') {
          const toolName = content.name;
          const toolArgs = content.input;

          // Execute tool call through MCP server
          console.log(`Calling tool: ${toolName} with args:`, toolArgs);
          const result = await this.session.callTool(toolName, toolArgs);
          finalText.push(`[Used tool: ${toolName}]`);

          // Add tool result to message history
          assistantMessageContent.push(content);
          messages.push({
            role: 'assistant',
            content: assistantMessageContent
          });
          messages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: content.id,
              content: result.content
            }]
          });

          // Get follow-up response from Claude
          response = await anthropic.messages.create({
            model: "claude-3-5-sonnet-20241022",
            max_tokens: 1000,
            messages,
            tools: availableTools
          });

          // Add the follow-up response
          if (response.content[0]?.type === 'text') {
            finalText.push(response.content[0].text);
          }
        }
      }

      return finalText.join('\n');
    } catch (error) {
      console.error('Error processing query:', error);
      return `Error: ${error.message}`;
    }
  }

  /**
   * Disconnect from the MCP server and clean up resources
   */
  async disconnect() {
    try {
      if (this.childProcess && this.transport === 'stdio') {
        this.childProcess.kill();
      }
      
      console.log('Disconnected from MCP server');
    } catch (error) {
      console.error('Error during disconnect:', error);
    }
  }
} 