import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

// Serves whatever tool list it is handed as argv[2], so one fixture covers clean and broken servers.
const tools = JSON.parse(process.argv[2] ?? '[]');
const server = new Server({ name: 'fixture', version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
await server.connect(new StdioServerTransport());
