import http from 'http';
import fs from 'fs';
import path from 'path';
import { ChildProcess } from 'child_process';

import { GROUPS_DIR, DATA_DIR, TIMEZONE } from './config.js';
import { runContainerAgent, ContainerOutput } from './container-runner.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

const DEFAULT_PORT = 3929;
const MAX_BODY_SIZE = 1 << 20; // 1MB

interface BridgeRequest {
  conversation_id: string;
  message: string;
  group_jid?: string;
  sender?: string;
  context_mode?: string;
  cwd?: string;
  system_prompt?: string;
}

export interface HttpBridgeDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
}

function ensureRingCentralGroup(
  deps: HttpBridgeDeps,
  conversationId: string,
): RegisteredGroup {
  const groups = deps.registeredGroups();
  const jid = `rc:${conversationId}`;

  if (groups[jid]) return groups[jid];

  const folder = 'ringcentral_bridge';
  const groupDir = path.resolve(GROUPS_DIR, folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const globalTemplate = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
  const groupMd = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMd) && fs.existsSync(globalTemplate)) {
    fs.copyFileSync(globalTemplate, groupMd);
  }

  const group: RegisteredGroup = {
    name: 'RingCentral Bridge',
    folder,
    trigger: '@Andy',
    added_at: new Date().toISOString(),
    requiresTrigger: false,
    isMain: false,
  };

  deps.registerGroup(jid, group);
  return group;
}

export function startHttpBridge(deps: HttpBridgeDeps): http.Server {
  const port = parseInt(process.env.HTTP_BRIDGE_PORT || '', 10) || DEFAULT_PORT;

  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method !== 'POST' || req.url !== '/message') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Request too large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (res.writableEnded) return;

      let body: BridgeRequest;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      if (!body.message) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '"message" is required' }));
        return;
      }

      const conversationId = body.conversation_id || 'default';

      logger.info(
        { conversationId, sender: body.sender, msgLen: body.message.length },
        'HTTP bridge request',
      );

      try {
        const group = ensureRingCentralGroup(deps, conversationId);
        const reply = await runBridgeAgent(group, body, conversationId);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ reply }));
      } catch (err) {
        logger.error({ err, conversationId }, 'HTTP bridge error');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    });
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'HTTP bridge listening');
  });

  return server;
}

async function runBridgeAgent(
  group: RegisteredGroup,
  body: BridgeRequest,
  conversationId: string,
): Promise<string> {
  const sender = body.sender || 'User';
  const now = new Date();
  const displayTime = now.toLocaleString('en-US', { timeZone: TIMEZONE });

  const prompt = `<context timezone="${TIMEZONE}" />\n<messages>\n<message sender="${sender}" time="${displayTime}">${body.message}</message>\n</messages>`;

  const replies: string[] = [];
  const groupFolder = group.folder;

  const output = await runContainerAgent(
    group,
    {
      prompt,
      groupFolder,
      chatJid: `rc:${conversationId}`,
      isMain: false,
      assistantName: 'Andy',
    },
    (_proc: ChildProcess, _containerName: string) => {
      // no-op: we don't need to register with GroupQueue for HTTP bridge
    },
    async (result: ContainerOutput) => {
      if (result.result) {
        const text =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const cleaned = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        if (cleaned) replies.push(cleaned);
      }
      // Write _close sentinel so the container exits after first result
      try {
        const ipcDir = resolveGroupIpcPath(groupFolder);
        const inputDir = path.join(ipcDir, 'input');
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(path.join(inputDir, '_close'), '');
      } catch (err) {
        logger.warn({ err, groupFolder }, 'Failed to write _close sentinel');
      }
    },
  );

  if (output.status === 'error') {
    throw new Error(output.error || 'Container agent failed');
  }

  if (replies.length === 0 && output.result) {
    const text =
      typeof output.result === 'string'
        ? output.result
        : JSON.stringify(output.result);
    const cleaned = text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
    if (cleaned) replies.push(cleaned);
  }

  return replies.join('\n\n') || '(no response)';
}
