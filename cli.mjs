import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { AgentService } from './src/agent/agent_service.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

const mode = process.argv.includes('--demo') || process.argv.includes('--mock') ? 'mock' : 'live';
const workspaceRoot = path.resolve(valueAfter('--workspace') || process.env.VARINA_WORKSPACE_ROOT || process.env.AHA_WORKSPACE_ROOT || path.resolve(root, '..'));
const existingSessionId = valueAfter('--session');
const initialPrompt = valueAfter('--prompt');
const service = new AgentService({ root, workspaceRoot });
await service.init();

let session;
try {
  session = existingSessionId
    ? await service.get(existingSessionId)
    : await service.create({ workspace_root: workspaceRoot, mode, title: 'CLI 会话' });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
  process.exit();
}

const unsubscribe = service.subscribe(session.session_id, event => {
  if (event.event === 'tool_call') process.stderr.write(`\n[工具] ${event.name}\n`);
  else if ((event.phase?.startsWith('varina_') || event.phase?.startsWith('aha_')) && event.message) process.stderr.write(`[Varina] R${event.round ?? '-'} ${event.message}\n`);
});

async function send(message) {
  const answer = await service.turn(session.session_id, message);
  output.write(`\nVarina> ${answer.content}\n\n`);
}

process.on('SIGINT', () => {
  try { service.cancel(session.session_id); }
  catch { void service.stop(); }
});

try {
  if (initialPrompt) {
    await send(initialPrompt);
  } else if (!input.isTTY) {
    await send('设计一个让 2–4 名玩家在十分钟内持续做出有意义选择的轻量合作机制。');
  } else {
    console.log(`Varina 对话 Agent · ${mode} · ${session.session_id}`);
    console.log(`工作区：${workspaceRoot}`);
    console.log('输入 /exit 退出；复杂机制问题会在本会话首次自动触发 Varina。\n');
    const readline = createInterface({ input, output });
    while (true) {
      const message = (await readline.question('You> ')).trim();
      if (!message) continue;
      if (message === '/exit' || message === '/quit') break;
      await send(message);
    }
    readline.close();
  }
} finally {
  unsubscribe();
  await service.stop();
}
