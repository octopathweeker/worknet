import { mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const platform = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'amd64' : null;
if (!platform || !arch || (platform === 'linux' && arch !== 'amd64')) throw new Error('Use official Foundry installer and FOUNDRY_BIN for this platform');
await mkdir('.tools/foundry', { recursive: true });
async function download(repository, tag, name, dest) {
  const release = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, { headers: { 'User-Agent': 'agent-task-network-toolchain' } });
  if (!release.ok) throw new Error(`Release lookup failed: ${release.status}`);
  const asset = (await release.json()).assets.find(a => a.name === name);
  if (!asset) throw new Error(`Official asset missing: ${name}`);
  const response = await fetch(asset.browser_download_url); if (!response.ok) throw new Error('Toolchain download failed');
  const bytes = Buffer.from(await response.arrayBuffer()); const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (asset.digest && asset.digest !== digest) throw new Error('Toolchain checksum mismatch');
  await writeFile(`${dest}.part`, bytes); await rename(`${dest}.part`, dest);
  return { source: asset.browser_download_url, digest, releaseDigestVerified: Boolean(asset.digest) };
}
const foundry = await download('foundry-rs/foundry', 'v1.8.3', `foundry_v1.8.3_${platform}_${arch}.tar.gz`, '.tools/foundry-v1.8.3.tar.gz');
const unpack = spawnSync('tar', ['-xzf', '.tools/foundry-v1.8.3.tar.gz', '-C', '.tools/foundry'], { stdio: 'inherit' });
if (unpack.status !== 0) throw new Error('Cannot extract Foundry');
const solc = await download('argotorg/solidity', 'v0.8.37', platform === 'darwin' ? 'solc-macos' : 'solc-static-linux', '.tools/solc-0.8.37');
await chmod('.tools/solc-0.8.37', 0o755);
await writeFile('.tools/provenance.json', JSON.stringify({ foundry, solc }, null, 2));
console.log('Installed project-local Foundry 1.8.3 + solc 0.8.37');
