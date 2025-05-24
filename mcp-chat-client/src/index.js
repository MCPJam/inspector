import readline from 'readline';
import { MCPClient } from './mcpClient.js';
import dotenv from 'dotenv';

dotenv.config();

// Setup readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Create an instance of our MCP client
const client = new MCPClient();

// CLI command handlers
const commands = {
  help: () => {
    console.log('\nAvailable commands:');
    console.log('  connect:stdio <command> <args...> - Connect to an MCP server via stdio');
    console.log('  connect:sse <url> [token] - Connect to an MCP server via SSE');
    console.log('  disconnect - Disconnect from the current MCP server');
    console.log('  tools - List available tools from the connected server');
    console.log('  exit - Exit the application');
    console.log('  help - Show this help message');
    console.log('\nAny other input will be processed as a query to the LLM\n');
  },
  
  'connect:stdio': async (args) => {
    if (args.length < 2) {
      console.log('Usage: connect:stdio <command> <args...>');
      console.log('Example: connect:stdio node server.js');
      return;
    }
    
    const command = args[0];
    const commandArgs = args.slice(1);
    
    console.log(`Connecting to MCP server: ${command} ${commandArgs.join(' ')}`);
    const success = await client.connectViaStdio(command, commandArgs);
    
    if (success) {
      console.log('Successfully connected to MCP server');
    } else {
      console.log('Failed to connect to MCP server');
    }
  },
  
  'connect:sse': async (args) => {
    if (args.length < 1) {
      console.log('Usage: connect:sse <url> [token]');
      console.log('Example: connect:sse http://localhost:3000/events myAuthToken');
      return;
    }
    
    const url = args[0];
    const token = args[1] || null;
    
    const success = await client.connectViaSSE(url, token);
    
    if (success) {
      console.log('Successfully connected to MCP server via SSE');
    } else {
      console.log('Failed to connect to MCP server via SSE');
    }
  },
  
  disconnect: async () => {
    await client.disconnect();
    console.log('Disconnected from MCP server');
  },
  
  tools: () => {
    if (!client.session) {
      console.log('Not connected to any MCP server');
      return;
    }
    
    console.log('\nAvailable tools:');
    client.tools.forEach(tool => {
      console.log(`  ${tool.name} - ${tool.description}`);
    });
    console.log('');
  },
  
  exit: () => {
    console.log('Exiting...');
    if (client.session) {
      client.disconnect();
    }
    rl.close();
    process.exit(0);
  }
};

// Process user input
async function processInput(input) {
  const trimmedInput = input.trim();
  
  if (trimmedInput === '') {
    return;
  }
  
  // Parse command and arguments
  const parts = trimmedInput.split(' ');
  const command = parts[0];
  const args = parts.slice(1);
  
  // Handle built-in commands
  if (commands[command]) {
    await commands[command](args);
    return;
  }
  
  // If not a command, process as a query to the LLM
  if (!client.session) {
    console.log('Please connect to an MCP server first');
    console.log('Use "connect:stdio <command> <args...>" or "connect:sse <url> [token]"');
    console.log('Type "help" for more information');
    return;
  }
  
  try {
    console.log('\nProcessing query...');
    const response = await client.processQuery(trimmedInput);
    console.log('\nResponse:');
    console.log(response);
    console.log('');
  } catch (error) {
    console.error('Error processing query:', error);
  }
}

// Main chat loop
async function startChatLoop() {
  console.log('\n=== MCP Chat Client ===');
  console.log('Type "help" for available commands');
  
  // Check if API key is set
  if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY === 'your_api_key_here') {
    console.log('\n⚠️  Warning: ANTHROPIC_API_KEY is not set or has default value');
    console.log('Please set your API key in the .env file');
  }
  
  // Main input loop
  rl.setPrompt('> ');
  rl.prompt();
  
  rl.on('line', async (line) => {
    await processInput(line);
    rl.prompt();
  });
  
  rl.on('close', () => {
    if (client.session) {
      client.disconnect();
    }
    console.log('Goodbye!');
    process.exit(0);
  });
}

// Handle errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  if (client.session) {
    client.disconnect();
  }
  process.exit(1);
});

// Start the chat loop
startChatLoop(); 