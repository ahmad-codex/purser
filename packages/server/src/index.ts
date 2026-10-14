#!/usr/bin/env -S npx tsx
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.ts';
import { startHttpServer } from './http.ts';
import { createMcpServer } from './mcp.ts';
import { WalletService } from './service.ts';

const config = loadConfig();
const service = new WalletService(config);

if (process.argv.includes('--stdio')) {
  // stdout carries the MCP protocol, so nothing else may write to it.
  await createMcpServer(service).connect(new StdioServerTransport());
} else {
  startHttpServer(service);
  const base = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log(`Purser ${config.account}`);
  console.log(`  agent key  ${service.agent.address}`);
  console.log(`  console    ${base}/`);
  console.log(`  MCP        ${base}/mcp`);
  if (config.demo) console.log('  demo mode: the console can approve with the local owner key. Never use this with real funds.');
}
