import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { erc20Abi, type Hex } from 'viem';
import { requesterVaultAbi } from '@agent-task/contracts';
import { loadConfig, checkChain, Signer, State, json } from '@agent-task/runtime';

const filename = process.env.DEMO_CONFIG ?? '.runtime/testnet/config.json'; const config = loadConfig(filename);
if (config.mode !== 'testnet' || config.chainId !== 10143 || !process.env.AGENT_PRIVATE_KEY) throw new Error('Load the dedicated Testnet Owner environment');
await checkChain(config);
const state = new State(path.join(path.dirname(filename), 'owner.db')); const signer = new Signer(config, state, process.env.AGENT_PRIVATE_KEY as Hex);
try {
  const owner = await signer.client.readContract({ address: config.vault, abi: requesterVaultAbi, functionName: 'owner' });
  if (owner.toLowerCase() !== signer.account.address.toLowerCase()) throw new Error('Signer is not this Vault Owner');
  const accounts = JSON.parse(await readFile('.runtime/testnet-accounts/addresses.public.json', 'utf8'));
  const amount = 5_000_000n;
  const approval = await signer.write(config.token, erc20Abi, 'approve', [config.vault, amount], 'bootstrap-approve-5-usdc');
  const deposit = await signer.write(config.vault, requesterVaultAbi, 'deposit', [amount], 'bootstrap-deposit-5-usdc');
  const now = (await signer.client.getBlock()).timestamp;
  const params = state.get<{ validAfter: string; validUntil: string }>('bootstrap-authorization') ?? { validAfter: now.toString(), validUntil: (now + 86400n).toString() };
  state.set('bootstrap-authorization', params);
  const authorization = await signer.write(config.vault, requesterVaultAbi, 'authorizeAgent', [accounts.addresses.requester, { validAfter: BigInt(params.validAfter), validUntil: BigInt(params.validUntil), maxPerTask: 200_000n, maxTotalCommitment: 2_000_000n }], 'bootstrap-authorization');
  const receipt = await signer.client.getTransactionReceipt({ hash: deposit });
  const raw = JSON.parse(await readFile(filename, 'utf8'));
  raw.fixture = { token: config.token, fromBlock: receipt.blockNumber.toString(), toBlock: receipt.blockNumber.toString() };
  await writeFile(filename, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  const report = { chainId: 10143, owner, requester: accounts.addresses.requester, vault: config.vault, depositedBaseUnits: amount, maxPerTask: '200000', maxTotalCommitment: '2000000', approval, deposit, authorization, fixture: raw.fixture, vaultBalance: await signer.client.readContract({ address: config.token, abi: erc20Abi, functionName: 'balanceOf', args: [config.vault] }) };
  await writeFile('docs/stages/M5/testnet-bootstrap.json', json(report) + '\n'); console.log(json(report));
} finally { await signer.close(); state.close(); }
