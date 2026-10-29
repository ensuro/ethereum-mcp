import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const HEALTH_PATH = '/healthz';

class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'BodyTooLargeError';
  }
}

interface HttpConfig {
  host: string;
  port: number;
  mcpPath: string;
}

function readConfig(): HttpConfig {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  const mcpPath = process.env.MCP_PATH || '/mcp';

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: expected 1-65535, got "${process.env.PORT}"`);
  }

  if (!mcpPath.startsWith('/')) {
    throw new Error(`Invalid MCP_PATH: expected a path starting with "/", got "${mcpPath}"`);
  }

  return { host, port, mcpPath };
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    const chunks: Buffer[] = [];

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;

      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(new BodyTooLargeError());
        req.resume();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;

      if (size === 0) {
        resolve(undefined);
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON request body'));
      }
    });

    req.on('error', fail);
  });
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;

  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendJsonRpcError(
  res: ServerResponse,
  statusCode: number,
  code: number,
  message: string
): void {
  sendJson(res, statusCode, {
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

function getPathname(req: IncomingMessage): string | null {
  try {
    return new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    return null;
  }
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: HttpConfig
): Promise<void> {
  const pathname = getPathname(req);

  if (pathname === null) {
    sendJson(res, 400, { error: 'Bad request' });
    return;
  }

  if (pathname === HEALTH_PATH) {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (pathname !== config.mcpPath) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    sendJsonRpcError(res, 405, -32000, 'Method not allowed.');
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      sendJsonRpcError(res, 413, -32600, 'Request body too large.');
      return;
    }

    sendJsonRpcError(res, 400, -32700, 'Parse error: invalid JSON body.');
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error('MCP request failed:', error);

    if (!res.headersSent) {
      sendJsonRpcError(res, 500, -32603, 'Internal server error');
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

export async function startHttpServer(): Promise<void> {
  const config = readConfig();

  const httpServer = createHttpServer((req, res) => {
    void handleRequest(req, res, config).catch((error) => {
      console.error('Unhandled HTTP request error:', error);

      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, 'Internal server error');
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off('listening', onListening);
      reject(error);
    };

    const onListening = () => {
      httpServer.off('error', onError);
      resolve();
    };

    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(config.port, config.host);
  });

  console.error(
    `Ethereum MCP HTTP server listening on http://${config.host}:${config.port}${config.mcpPath}`
  );

  const shutdown = (signal: string) => {
    console.error(`Received ${signal}, shutting down...`);

    const forceTimer = setTimeout(() => {
      console.error('Shutdown timed out; closing remaining connections');
      httpServer.closeAllConnections();
      process.exit(1);
    }, 10_000);
    forceTimer.unref();

    httpServer.close((error) => {
      clearTimeout(forceTimer);

      if (error) {
        console.error('Failed to close HTTP server:', error);
        process.exit(1);
      }

      process.exit(0);
    });

    httpServer.closeIdleConnections();
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
