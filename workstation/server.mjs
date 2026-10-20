import { exec, spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const serverPath = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(serverPath, '..', '..');
const defaultWorkspace = (() => {
  const explicit = process.env.SISO_WORKSTATION_DEFAULT_ROOT?.trim();
  if (explicit && existsSync(explicit)) {
    return path.resolve(explicit);
  }

  const workspaceCandidate = path.resolve(projectRoot, '..');
  if (existsSync(path.join(workspaceCandidate, 'SISO_Workspace'))) {
    return path.join(workspaceCandidate, 'SISO_Workspace');
  }

  if (workspaceCandidate.endsWith('SISO_Workspace')) {
    return workspaceCandidate;
  }

  if (process.env.HOME && existsSync(path.join(process.env.HOME, 'SISO_Workspace'))) {
    return path.join(process.env.HOME, 'SISO_Workspace');
  }

  return process.env.HOME || os.homedir();
})();

const DEFAULT_CWD = path.resolve(process.env.SISO_WORKSTATION_DEFAULT_CWD || defaultWorkspace);
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.SISO_WORKSTATION_TIMEOUT_MS || '120000', 10);
const DEFAULT_OUTPUT_LIMIT = 120000;

const server = new McpServer(
  {
    name: 'siso-workstation',
    version: '0.3.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

function clampTimeout(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(parsed, 100), 3600000);
}

function ensureCwd(cwd) {
  const resolved = path.resolve(cwd || DEFAULT_CWD);
  if (!existsSync(resolved) || !existsSync(path.join(resolved, '.'))) {
    throw new Error(`Working directory does not exist: ${resolved}`);
  }
  return resolved;
}

function trimText(value, maxChars = DEFAULT_OUTPUT_LIMIT) {
  const raw = String(value || '');
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n... [truncated]` : raw;
}

function normalizePath(inputPath, cwd) {
  const base = path.resolve(cwd || DEFAULT_CWD);
  return path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(base, inputPath);
}

function readTextFileAbsolute(filePath) {
  return fs.readFile(filePath, 'utf8');
}

function isLikelyBinary(buffer) {
  for (let i = 0; i < Math.min(buffer.length, 1024); i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

function newSession(sessionId, command, cwd, proc) {
  return {
    session_id: sessionId,
    command,
    cwd,
    pid: proc.pid,
    startedAt: nowIso(),
    status: 'running',
    exitCode: null,
    signal: null,
    killed: false,
    stdout: '',
    stderr: '',
    reads: 0,
  };
}

function collectOutput(session, chunk, isError = false) {
  const text = chunk.toString();
  if (isError) {
    session.stderr += text;
  } else {
    session.stdout += text;
  }
}

function registerOutputLineCount(session) {
  session.lastOutputAt = nowIso();
}

function runCommandSyncLike(command, cwd, timeoutMs, captureStderr = true) {
  const child = spawn(command, {
    cwd,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TERM: process.env.TERM || 'xterm-256color',
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, clampTimeout(timeoutMs));

  return new Promise((resolve) => {
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code === null ? 1 : code,
        signal,
        stdout,
        stderr: captureStderr ? stderr : '',
        timedOut,
      });
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        signal: null,
        stdout,
        stderr: `${stderr}\n${String(error)}`,
        timedOut,
      });
    });
  });
}

async function runSearchWithRipgrep(rootPath, query) {
  const { stdout, stderr } = await execAsync(`rg --line-number --no-heading --color=never -g '!.git' -F ${JSON.stringify(query)} ${JSON.stringify(rootPath)}`);
  if (stderr && stderr.trim().length > 0) {
    return `Search stderr:\n${stderr}\n\n${stdout}`;
  }
  return stdout || '(no matches)';
}

async function fallbackSearch(rootPath, query, depth = 8) {
  const normalized = path.resolve(rootPath);
  const maxDepth = Number.isFinite(depth) ? Math.max(1, Math.min(Math.floor(depth), 16)) : 8;
  const hits = [];
  const lower = query.toLowerCase();
  const queue = [{ dir: normalized, level: 0 }];

  while (queue.length) {
    const item = queue.shift();
    if (!item || item.level > maxDepth) {
      continue;
    }

    let entries = [];
    try {
      entries = await fs.readdir(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.venv') {
        continue;
      }

      const candidate = path.join(item.dir, entry.name);
      if (entry.isDirectory()) {
        if (item.level < maxDepth) {
          queue.push({ dir: candidate, level: item.level + 1 });
        }
      } else if (entry.isFile()) {
        try {
          const chunk = await fs.readFile(candidate, 'utf8');
          const lines = chunk.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].toLowerCase().includes(lower)) {
              hits.push(`${candidate}:${i + 1}:${lines[i]}`);
              if (hits.length >= 200) {
                break;
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }
    if (hits.length >= 200) {
      break;
    }
  }

  return hits.length ? hits.join('\n') : '(no matches)';
}

server.tool(
  'shell_exec',
  'Run one command and return combined stdout/stderr output.',
  {
    command: z.string().min(1).max(10000),
    cwd: z.string().optional(),
    timeout_ms: z.number().int().min(100).max(3600000).optional(),
  },
  async ({ command, cwd, timeout_ms }) => {
    const resolvedCwd = ensureCwd(cwd);
    const run = await runCommandSyncLike(command, resolvedCwd, clampTimeout(timeout_ms));

    const output = {
      ok: run.exitCode === 0 && !run.timedOut,
      command,
      cwd: resolvedCwd,
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      stdout: trimText(run.stdout),
      stderr: trimText(run.stderr),
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(output, null, 2),
        },
      ],
    };
  },
);

server.tool(
  'start_process',
  'Start a persistent background process using the shell and return a session id.',
  {
    command: z.string().min(1).max(10000),
    cwd: z.string().optional(),
  },
  async ({ command, cwd }) => {
    const resolvedCwd = ensureCwd(cwd);
    const sessionId = randomUUID();
    const proc = spawn(command, {
      cwd: resolvedCwd,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        TERM: process.env.TERM || 'xterm-256color',
      },
    });

    const session = newSession(sessionId, command, resolvedCwd, proc);
    sessions.set(sessionId, session);

    proc.stdout.on('data', (chunk) => {
      collectOutput(session, chunk, false);
      registerOutputLineCount(session);
    });
    proc.stderr.on('data', (chunk) => {
      collectOutput(session, chunk, true);
      registerOutputLineCount(session);
    });
    proc.on('close', (code, signal) => {
      session.exitCode = code === null ? null : code;
      session.signal = signal;
      session.status = signal || code !== 0 ? 'exited' : 'completed';
      if (!session.lastOutputAt) {
        session.lastOutputAt = nowIso();
      }
    });
    proc.on('error', () => {
      session.status = 'error';
      session.exitCode = 1;
      session.signal = 'spawn';
    });

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              session_id: sessionId,
              pid: proc.pid,
              command,
              cwd: resolvedCwd,
              status: 'running',
              startedAt: session.startedAt,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'process_input',
  'Send input to a running persistent session.',
  {
    session_id: z.string().min(8).max(128),
    input: z.string().max(20000),
    newline: z.boolean().optional(),
  },
  async ({ session_id, input, newline }) => {
    const session = sessions.get(session_id);
    if (!session) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                reason: `session not found: ${session_id}`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (session.status !== 'running') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                reason: `session not running: ${session_id}`,
                status: session.status,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const text = newline ? `${input}\n` : input;
    session.proc.stdin?.write(text);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, session_id, pid: session.pid }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  'process_output',
  'Read buffered stdout/stderr output from a running or ended session.',
  {
    session_id: z.string().min(8).max(128),
  },
  async ({ session_id }) => {
    const session = sessions.get(session_id);
    if (!session) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                reason: `session not found: ${session_id}`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    session.reads += 1;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              session_id,
              pid: session.pid,
              status: session.status,
              exitCode: session.exitCode,
              signal: session.signal,
              stdout: trimText(session.stdout),
              stderr: trimText(session.stderr),
              command: session.command,
              cwd: session.cwd,
              startedAt: session.startedAt,
              lastOutputAt: session.lastOutputAt,
              reads: session.reads,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'kill_process',
  'Terminate a running process session.',
  {
    session_id: z.string().min(8).max(128),
    signal: z.string().optional(),
  },
  async ({ session_id, signal }) => {
    const session = sessions.get(session_id);
    if (!session) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                reason: `session not found: ${session_id}`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (session.status !== 'running') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                reason: `session not running: ${session_id}`,
                status: session.status,
                exitCode: session.exitCode,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const selectedSignal = signal || 'SIGTERM';
    const didKill = session.proc.kill(selectedSignal);
    session.status = 'killed';
    session.killed = true;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: didKill,
              session_id,
              pid: session.pid,
              signal: selectedSignal,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'read_file',
  'Read a file by absolute or relative path (relative to configured workspace when needed).',
  {
    path: z.string().min(1).max(4096),
    offset: z.number().int().min(0).optional(),
    length: z.number().int().min(1).max(5000).optional(),
    cwd: z.string().optional(),
  },
  async ({ path: filePath, offset = 0, length = 2000, cwd }) => {
    const fullPath = normalizePath(filePath, cwd || DEFAULT_CWD);
    const buffer = await fs.readFile(fullPath);
    if (isLikelyBinary(buffer)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                reason: `binary content detected or unsupported encoding: ${fullPath}`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const text = buffer.toString('utf8');
    const lines = text.split(/\r?\n/);
    const segment = lines.slice(offset, offset + length).join('\n');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              path: fullPath,
              offset,
              length: segment.split('\n').length,
              totalLines: lines.length,
              content: trimText(segment, 400000),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'write_file',
  'Write or overwrite a file.',
  {
    path: z.string().min(1).max(4096),
    content: z.string(),
    mode: z.enum(['rewrite', 'append']).default('rewrite'),
    cwd: z.string().optional(),
  },
  async ({ path: filePath, content, mode, cwd }) => {
    const fullPath = normalizePath(filePath, cwd || DEFAULT_CWD);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    if (mode === 'append') {
      await fs.appendFile(fullPath, content, 'utf8');
    } else {
      await fs.writeFile(fullPath, content, 'utf8');
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              path: fullPath,
              mode,
              bytes: Buffer.byteLength(content, 'utf8'),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'edit_file',
  'Replace occurrences in a text file using literal old/new text and an expected replacement count.',
  {
    path: z.string().min(1).max(4096),
    old_text: z.string().min(1),
    new_text: z.string(),
    expected_replacements: z.number().int().min(1).default(1),
    cwd: z.string().optional(),
  },
  async ({ path: filePath, old_text, new_text, expected_replacements, cwd }) => {
    const fullPath = normalizePath(filePath, cwd || DEFAULT_CWD);
    const file = await readTextFileAbsolute(fullPath);

    let count = 0;
    let idx = 0;
    while (true) {
      const next = file.indexOf(old_text, idx);
      if (next < 0) {
        break;
      }
      count += 1;
      idx = next + old_text.length;
      if (count > expected_replacements) {
        break;
      }
    }

    if (count !== expected_replacements) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ok: false,
                path: fullPath,
                reason: `Expected ${expected_replacements} replacement(s), found ${count}`,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    const next = expected_replacements === 1 ? file.replace(old_text, new_text) : file.split(old_text).join(new_text);
    await fs.writeFile(fullPath, next, 'utf8');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              path: fullPath,
              replacements: expected_replacements,
              bytes: Buffer.byteLength(next, 'utf8'),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'list_directory',
  'Recursively list directory entries up to a given depth.',
  {
    path: z.string().min(1).max(4096),
    depth: z.number().int().min(1).max(12).default(2),
    cwd: z.string().optional(),
  },
  async ({ path: dirPath, depth, cwd }) => {
    const fullPath = normalizePath(dirPath, cwd || DEFAULT_CWD);

    const walk = async (target, level, maxLevel, out) => {
      const entries = await fs.readdir(target, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name === '.git') {
          continue;
        }
        const childPath = path.join(target, entry.name);
        const stat = await fs.stat(childPath);
        out.push({
          path: childPath,
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
          size: stat.size,
          mtime: stat.mtime.toISOString(),
          depth: level,
        });
        if (entry.isDirectory() && level < maxLevel) {
          await walk(childPath, level + 1, maxLevel, out);
        }
      }
    };

    const rows = [];
    await walk(fullPath, 0, depth, rows);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              path: fullPath,
              depth,
              count: rows.length,
              entries: rows,
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'search_files',
  'Search file contents with a literal query string.',
  {
    path: z.string().min(1).max(4096),
    query: z.string().min(1).max(1000),
    use_fallback: z.boolean().optional(),
    cwd: z.string().optional(),
  },
  async ({ path: searchPath, query, use_fallback, cwd }) => {
    const fullPath = normalizePath(searchPath, cwd || DEFAULT_CWD);
    let output;

    if (use_fallback) {
      output = await fallbackSearch(fullPath, query);
    } else {
      try {
        output = await runSearchWithRipgrep(fullPath, query);
      } catch (error) {
        output = await fallbackSearch(fullPath, query);
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              query,
              path: fullPath,
              output: trimText(output),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

server.tool(
  'computer_status',
  'Return local execution and health information for this workstation.',
  {},
  async () => {
    const cpus = os.cpus() || [];
    const memory = os.totalmem();

    const processKeys = Array.from(sessions.keys());
    const running = processKeys.filter((id) => sessions.get(id)?.status === 'running').length;
    const total = processKeys.length;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              ok: true,
              hostname: os.hostname(),
              platform: os.platform(),
              release: os.release(),
              user: os.userInfo().username,
              shell: process.env.SHELL || 'unknown',
              cwd: process.cwd(),
              defaultWorkspace: DEFAULT_CWD,
              uptimeSeconds: os.uptime(),
              memory: {
                totalBytes: memory,
                freeBytes: os.freemem(),
                usedBytes: Math.max(0, memory - os.freemem()),
              },
              cpuCount: cpus.length,
              loadAvg: os.loadavg(),
              sessions: {
                total,
                running,
              },
              allowedWriteScope: 'full_user',
            },
            null,
            2,
          ),
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`siso-workstation MCP startup failed: ${error?.stack || error}\n`);
  process.exit(1);
});
