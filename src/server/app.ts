/**
 * Responsibility: Composes the single-service Node HTTP server combining `/api/*`,
 * `/healthz`, `/readyz`, and traversal-checked static asset serving from `dist/client`.
 * Trust boundary: Process composition root; wires environment config, session store,
 * release gate, audit ledger, and official/mock Gemini transport.
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { loadServerConfig, type ServerConfig } from './config.js';
import {
  DeterministicMockGeminiTransport,
  OfficialGoogleGenAITransport,
  type GeminiTransport,
} from './gemini.js';
import { AuditLedger } from './ledger.js';
import { SafeStructuredLogger } from './redaction.js';
import { ResponseReleaseGate } from './release.js';
import {
  applySecurityHeaders,
  handleApiOrProbeRequest,
  type ApiRouterContext,
} from './routes.js';
import { SessionStore } from './session.js';
import { InstanceGeminiBudgetLimiter } from './workflows.js';

const MIME_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
});

export interface AppInstance {
  readonly server: http.Server;
  readonly context: ApiRouterContext;
}

export function createAppInstance(options?: {
  config?: ServerConfig;
  transport?: GeminiTransport;
  clientDistDir?: string;
  nowFn?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
  emitLogsToStdout?: boolean;
}): AppInstance {
  const config = options?.config ?? loadServerConfig();
  const transport: GeminiTransport =
    options?.transport ??
    (config.demoMode === 'mock'
      ? new DeterministicMockGeminiTransport()
      : new OfficialGoogleGenAITransport(config.geminiApiKey));

  const sessionStore = new SessionStore({
    secret: config.sessionSecret,
    ttlMs: config.sessionTtlMs,
    maxSessions: config.maxSessionsInMemory,
    nowFn: options?.nowFn,
  });

  const ledger = new AuditLedger();
  const releaseGate = new ResponseReleaseGate();
  const logger = new SafeStructuredLogger({
    emitToStdout: options?.emitLogsToStdout ?? config.nodeEnv !== 'test',
  });
  const instanceBudget = new InstanceGeminiBudgetLimiter({
    windowMs: config.geminiWindowMs,
    maxCalls: config.maxGeminiCallsPerWindow,
    nowFn: options?.nowFn,
  });

  const context: ApiRouterContext = {
    config,
    sessionStore,
    ledger,
    releaseGate,
    transport,
    logger,
    instanceBudget,
    sleepFn: options?.sleepFn,
  };

  const resolvedClientDir = path.resolve(
    options?.clientDistDir ?? path.join(process.cwd(), 'dist', 'client'),
  );

  const server = http.createServer(async (req, res) => {
    const handled = await handleApiOrProbeRequest(req, res, context);
    if (handled) return;

    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      applySecurityHeaders(res, true);
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { code: 'method_not_allowed', message: 'GET required.' } }));
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    let relativePath: string;
    try {
      relativePath = decodeURIComponent(url.pathname);
    } catch {
      applySecurityHeaders(res, false);
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }

    if (relativePath.includes('\u0000')) {
      applySecurityHeaders(res, false);
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }

    const requestedFile = relativePath === '/' ? 'index.html' : relativePath.replace(/^\/+/, '');
    const candidatePath = path.resolve(resolvedClientDir, requestedFile);

    // Strict directory containment check preventing path traversal
    if (
      candidatePath !== resolvedClientDir &&
      !candidatePath.startsWith(`${resolvedClientDir}${path.sep}`)
    ) {
      applySecurityHeaders(res, false);
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    const serveFile = async (filePath: string): Promise<boolean> => {
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) return false;
        const content = await fs.readFile(filePath);
        const ext = path.extname(filePath).toLowerCase();
        applySecurityHeaders(res, false);
        res.setHeader('Content-Type', MIME_BY_EXT[ext] ?? 'application/octet-stream');
        if (ext === '.html') {
          res.setHeader('Cache-Control', 'no-cache');
        } else {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
        res.statusCode = 200;
        res.end(method === 'HEAD' ? undefined : content);
        return true;
      } catch {
        return false;
      }
    };

    if (await serveFile(candidatePath)) {
      return;
    }

    // SPA fallback to index.html for non-asset navigation paths
    if (!path.extname(requestedFile)) {
      const indexHtml = path.join(resolvedClientDir, 'index.html');
      if (await serveFile(indexHtml)) {
        return;
      }
    }

    applySecurityHeaders(res, false);
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not Found');
  });

  // Bound socket & header timeouts against slow-request exhaustion
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.keepAliveTimeout = 5_000;

  return { server, context };
}
