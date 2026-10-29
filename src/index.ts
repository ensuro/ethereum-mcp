#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { startHttpServer } from './http.js';

async function main() {
  const transport = process.env.MCP_TRANSPORT || 'stdio';

  if (transport === 'http') {
    await startHttpServer();
    return;
  }

  if (transport !== 'stdio') {
    throw new Error(`Invalid MCP_TRANSPORT: expected "stdio" or "http", got "${transport}"`);
  }

  const server = createServer();
  const stdioTransport = new StdioServerTransport();
  await server.connect(stdioTransport);
  console.error('Ethereum MCP server v2.0 running');
  console.error(
    'Data sources: Etherscan, JSON-RPC, DefiLlama, CoinGecko, growthepie, Blobscan, Dune (optional)'
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
