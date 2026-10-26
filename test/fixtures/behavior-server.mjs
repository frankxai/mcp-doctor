import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';

// argv[2] picks how the server answers tools/call: strict | lax | hang | crash.
// argv[3] is a log file; every tools/call is appended to it, so tests can prove what was never called.
const mode = process.argv[2] ?? 'strict';
const log = process.argv[3];
const tools = [
  { name: 'note_lookup', description: 'Look up a note by its query string.', annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'], additionalProperties: false } },
  { name: 'note_list', description: 'List notes; takes no arguments at all.', annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'note_search_open', description: 'Search notes with any optional filters.', annotations: { readOnlyHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
  { name: 'note_delete', description: 'Delete a note permanently from the store.', annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'note_touch', description: 'Unannotated tool that must never be probed.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];

function valid(tool, args) {
  const schema = tool.inputSchema;
  if ((schema.required ?? []).some((key) => !(key in args))) return false;
  if (schema.additionalProperties === false && Object.keys(args).some((key) => !(key in schema.properties))) return false;
  return true;
}

const server = new Server({ name: 'behavior', version: '0.0.1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  if (log) appendFileSync(log, name + '\n');
  if (mode === 'hang') return new Promise(() => {});
  if (mode === 'crash') process.exit(1);
  if (mode === 'lax') return { content: [{ type: 'text', text: 'ok' }] };
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
  if (!valid(tool, args)) return { isError: true, content: [{ type: 'text', text: 'Invalid arguments' }] };
  return { content: [{ type: 'text', text: 'ok' }] };
});
await server.connect(new StdioServerTransport());
