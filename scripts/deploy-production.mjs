import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Production reuses M6's existing Workers, D1 and contract journals.
// Never use --env production: that would select different Cloudflare resources.
const directory = '.runtime/m6';
const configPath = `${directory}/wrangler.jsonc`;
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const chain = JSON.parse(readFileSync(`${directory}/config.json`, 'utf8'));
if (chain.release !== 'm6' || chain.chainId !== 10143 || config.vars?.WORKNET_ENVIRONMENT !== 'production') throw new Error('M6_PRODUCTION_CONFIGURATION_REQUIRED');
const origin = new URL(config.vars.WORKNET_PUBLIC_ORIGIN);
if (origin.protocol !== 'https:' || !config.routes?.some(route => route.custom_domain && route.pattern === origin.hostname)) throw new Error('PRODUCTION_CUSTOM_DOMAIN_REQUIRED');
if (!config.d1_databases?.some(db => db.binding === 'DB' && /^[a-f0-9-]{36}$/.test(db.database_id))) throw new Error('PRODUCTION_DATABASE_REQUIRED');
if (!config.durable_objects?.bindings.some(binding => binding.name === 'TOOL_PAYMENTS' && binding.class_name === 'ToolPayments')) throw new Error('TOOL_PAYMENTS_BINDING_REQUIRED');
for (let i = 1; i <= 3; i++) {
  const judge = JSON.parse(readFileSync(`${directory}/judge-${i}.wrangler.jsonc`, 'utf8'));
  if (!config.services?.some(service => service.binding === `JUDGE_${i}` && service.service === judge.name)) throw new Error('JUDGE_BINDING_MISMATCH');
}
const dryRun = process.argv.includes('--dry-run');
const toolConfigPath = `${directory}/protocol/wrangler.jsonc`;
const toolConfig = existsSync(toolConfigPath) ? JSON.parse(readFileSync(toolConfigPath, 'utf8')) : undefined;
if (toolConfig && (toolConfig.name !== `${config.name}-tools` || !toolConfig.d1_databases?.some(db => db.binding === 'DB' && /^[a-f0-9-]{36}$/.test(db.database_id)))) throw new Error('TOOL_SERVICE_CONFIGURATION_MISMATCH');
if (process.argv.slice(2).some(arg => arg !== '--dry-run')) throw new Error('Only --dry-run is supported.');
function run(args) {
  const result = spawnSync('pnpm', args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const wrangler = (...args) => run(['dlx', 'wrangler@4.136.0', ...args]);
wrangler('whoami');
// The Worker imports this package's dist exports; rebuild before bundling judges.
run(['--filter', '@agent-task/judging', 'build']);
run(['--filter', '@agent-task/explorer', 'build']);
if (!dryRun) wrangler('d1', 'execute', 'DB', '--remote', '--config', configPath, '--file', 'apps/object-store/platform-schema.sql', '--yes');
if (toolConfig) {
  if (!dryRun) wrangler('d1', 'execute', 'DB', '--remote', '--config', toolConfigPath, '--file', 'apps/object-store/platform-schema.sql', '--yes');
  wrangler('deploy', '--config', toolConfigPath, ...(dryRun ? ['--dry-run'] : []));
}
for (let i = 1; i <= 3; i++) wrangler('deploy', '--config', `${directory}/judge-${i}.wrangler.jsonc`, ...(dryRun ? ['--dry-run'] : []));
wrangler('deploy', '--config', configPath, ...(dryRun ? ['--dry-run'] : []));
console.log(`${dryRun ? 'Validated' : 'Deployed'} M6 production: ${origin.origin} (Monad Testnet 10143)`);
