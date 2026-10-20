import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'node',
  args: ['server.mjs'],
  env: {
    ...process.env,
    SISO_WORKSTATION_DEFAULT_ROOT: process.env.SISO_WORKSTATION_DEFAULT_ROOT || process.env.HOME,
    SISO_WORKSTATION_DEFAULT_CWD: process.env.SISO_WORKSTATION_DEFAULT_CWD || `${process.env.HOME}/SISO_Workspace`,
    SISO_WORKSTATION_TIMEOUT_MS: process.env.SISO_WORKSTATION_TIMEOUT_MS || '120000',
  },
});

const client = new Client(
  { name: 'siso-workstation-smoke', version: '0.3.0' },
  { capabilities: { tools: {} } },
);

async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text || '';
  try {
    const parsed = JSON.parse(text);
    console.log(`[${name}]`, JSON.stringify(parsed, null, 2));
    return parsed;
  } catch {
    console.log(`[${name}]`, text);
    return { raw: text };
  }
}

await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map((tool) => tool.name).sort().join(', '));

const repoRoot = `${process.env.HOME}/SISO_Workspace/SISO_Agency/apps/codex-remote`;

console.log('\\n=== 1) MCP list tools ===');
await callTool('computer_status', {});

console.log('\\n=== 2) shell_exec(pwd) ===');
await callTool('shell_exec', { command: 'pwd', cwd: repoRoot, timeout_ms: 120000 });

console.log('\\n=== 3) read_file (README.md excerpt) ===');
await callTool('read_file', { path: `${repoRoot}/README.md`, offset: 0, length: 5 });

console.log('\\n=== 4) write/remove disposable file ===');
const testPath = `${repoRoot}/.siso-workstation-smoke.txt`;
await callTool('write_file', { path: testPath, content: 'siso-workstation smoke test\\n', mode: 'rewrite' });
await callTool('shell_exec', { command: `rm "${testPath}"`, timeout_ms: 120000 });

console.log('\\n=== 5) git status ===');
await callTool('shell_exec', { command: 'git status --short', cwd: repoRoot, timeout_ms: 120000 });

console.log('\\n=== 6) gh auth status ===');
await callTool('shell_exec', { command: 'gh auth status', timeout_ms: 120000 });

console.log('\\n=== 7) gh repo list (preview) ===');
await callTool('shell_exec', { command: 'gh repo list --limit 3', timeout_ms: 120000 });

console.log('\\n=== 8) gh inspect current repo ===');
await callTool('shell_exec', { command: `gh repo view --json nameWithOwner,description,visibility --jq '{nameWithOwner,description,visibility}'`, cwd: repoRoot, timeout_ms: 120000 });

console.log('\\n=== 9) harmless node ===');
await callTool('shell_exec', { command: "node -e \"console.log('NODE_OK')\"", timeout_ms: 120000 });

console.log('\\n=== 10) harmless python ===');
await callTool('shell_exec', { command: "python3 -c \"print('PYTHON_OK')\"", timeout_ms: 120000 });

console.log('\\n=== 11) persistent process + output ===');
const longRun = await callTool('start_process', { command: 'bash -lc "sleep 1; echo PROCESS_STEP_1; sleep 1; echo PROCESS_STEP_2; sleep 1; echo PROCESS_DONE"', cwd: repoRoot });
if (longRun.ok) {
  let ready = await callTool('process_output', { session_id: longRun.session_id });
  if (ready.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    ready = await callTool('process_output', { session_id: longRun.session_id });
  }
  if (ready && ready.exitCode !== null && ready.exitCode !== undefined && ready.exitCode !== 0) {
    await callTool('process_output', { session_id: longRun.session_id });
  }
}

console.log('\\n=== 12) search_files + outside path read ===');
await callTool('search_files', { path: repoRoot, query: 'siso-workstation', use_fallback: false });
await callTool('read_file', { path: '/etc/hosts', offset: 0, length: 20 });

console.log('\\n=== completed smoke suite ===');

await client.close();
process.exit(0);
