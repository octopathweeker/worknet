import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
if (!files.length) throw new Error('No tracked files; stage the intended source files first.');
const failures = [];
for (const file of files) {
  if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) { failures.push({ file, rule: 'non-regular-file' }); continue; }
  if (/(?:^|\/)(?:\.runtime|\.tools|\.wrangler|node_modules|dist|graphify-out)(?:\/|$)|^docs\/stages\/|\.private\.json$|\.(?:log|db|sqlite|pem|key|p12|pfx|mp4|png)$/i.test(file) || /(?:^|\/)\.env/.test(file) && file !== '.env.example' || file.endsWith('wrangler.local.jsonc')) failures.push({ file, rule: 'private-or-generated-file' });
  const text = readFileSync(file, 'utf8');
  if (new RegExp('/' + 'Users' + '/[^/\\s]+|/' + 'var/folders' + '/').test(text)) failures.push({ file, rule: 'local-user-path' });
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|(?:worknet_user|worknet_session|oauth_token)\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}/.test(text)) failures.push({ file, rule: 'credential-literal' });
}
const config = JSON.parse(readFileSync('apps/object-store/wrangler.jsonc', 'utf8'));
if (config.account_id || config.d1_databases.some(d => d.database_id !== 'REPLACE_WITH_D1_DATABASE_ID')) failures.push({ file: 'apps/object-store/wrangler.jsonc', rule: 'real-provider-configuration' });
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exitCode = 1; }
else console.log(`Release checks passed for ${files.length} tracked files. This is a supplementary check, not a complete secret scanner.`);
