import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isAddress, isHex, type Address } from 'viem';
import { createMcpServer } from './mcp.ts';
import { replace } from './requests.ts';
import type { WalletService } from './service.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
};

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, (k, v) => (typeof v === 'bigint' ? v.toString() : replace(k, v))));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

/**
 * One HTTP server for everything:
 *   /mcp        MCP over streamable HTTP, for the agent
 *   /api/...    state and owner actions, for the console
 *   /           the console itself (static files), when built
 */
export function startHttpServer(service: WalletService) {
  const { config } = service;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });

      if (url.pathname === '/mcp') {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        const mcp = createMcpServer(service);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      if (url.pathname.startsWith('/api/')) return await api(req, res, url);

      return serveConsole(res, url.pathname);
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: (err as Error).message });
    }
  });

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (req.method !== 'GET' && config.apiToken && req.headers.authorization !== `Bearer ${config.apiToken}`) {
      return send(res, 401, { error: 'unauthorized' });
    }
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]

    if (req.method === 'GET' && parts[1] === 'state') {
      const [state, activity] = await Promise.all([service.client.getState(), service.client.getActivity(40)]);
      return send(res, 200, {
        state,
        activity,
        requests: service.requests.list().map(({ prepared: _prepared, ...r }) => r),
        agent: service.agent.address,
        demo: config.demo,
        canApproveWithoutWallet: service.canApproveWithoutWallet,
        explorerUrl: config.explorerUrl,
        addressBook: config.addressBook,
      });
    }

    if (req.method === 'POST' && parts[1] === 'requests' && parts[2]) {
      const id = parts[2];
      const body = ((await readBody(req)) ?? {}) as { signature?: string };
      if (parts[3] === 'prepare') return send(res, 200, await service.prepareApproval(id));
      if (parts[3] === 'approve') {
        if (body.signature && !isHex(body.signature)) return send(res, 400, { error: 'signature must be hex' });
        return send(res, 200, await service.approve(id, body.signature as `0x${string}` | undefined));
      }
      if (parts[3] === 'reject') return send(res, 200, service.reject(id));
    }

    if (req.method === 'POST' && parts[1] === 'owner' && parts[2]) {
      const action = parts[2] as 'freeze' | 'unfreeze' | 'revoke';
      if (!['freeze', 'unfreeze', 'revoke'].includes(action)) return send(res, 404, { error: 'unknown action' });
      const body = ((await readBody(req)) ?? {}) as { key?: string; mode?: 'calldata' };
      const key = body.key && isAddress(body.key) ? (body.key as Address) : undefined;
      if (body.mode === 'calldata' || !service.canApproveWithoutWallet) return send(res, 200, service.ownerCall(action, key));
      return send(res, 200, { txHash: await service.ownerActDemo(action, key) });
    }

    return send(res, 404, { error: 'not found' });
  }

  function serveConsole(res: ServerResponse, pathname: string) {
    const dir = config.consoleDir;
    if (!dir || !existsSync(dir)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Purser server is running. MCP endpoint: /mcp. Build the console (npm run build -w @purser/console) to serve it here.');
      return;
    }
    const safe = normalize(pathname).replace(/^(\.\.[/\\])+/, '');
    let file = join(dir, safe);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  }

  server.listen(config.port, config.host);
  return server;
}
