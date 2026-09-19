import { readFile, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const filename = '.runtime/testnet-accounts/workspace.env';
try { await access(filename); console.log('Existing workspace access code preserved.'); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  await writeFile(filename, `WORKSPACE_ACCESS_CODE=${randomBytes(24).toString('base64url')}\n`, { mode: 0o600, flag: 'wx' });
  console.log('Workspace access code created in the private environment file.');
}
const code = (await readFile(filename, 'utf8')).trim().split('=')[1];
await writeFile('.runtime/testnet-accounts/WORKSPACE-ACCESS.md', `# Worknet 工作区访问码\n\n仅与你的团队分享，勿上传或提交 Git。\n\n在公开页面点击「连接工作区」，输入：\n\n\`${code}\`\n\n登录后可以生成计划、创建测试网任务、暂停或恢复 Worker 接单。这个访问码不包含钱包私钥。\n`, { mode: 0o600 });
