import { createPasskeyWithPrfOutput, getPasskeyPrfOutput, createSecp256k1SigningSession, type PasskeyCredentialMetadata, type Secp256k1SigningSession } from '@category-labs/mera';
import { toViemAccount } from '@category-labs/mera/viem';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createWalletClient, createPublicClient, http, hexToBytes, keccak256, parseTransaction, recoverTransactionAddress, type Address, type Hex } from 'viem';
import { monadTestnet } from 'viem/chains';
import { deliverySalt, deliveryPrivateKey, deliveryPublicKey, deliveryContext, openJson, verifiedOpening, type DeliveryConfig } from '@agent-task/privacy';
import {UnbroadcastTransactionError} from './wallet-send.js';

const metadataKey = 'worknet-mera-account/1';
const accountSalt = sha256(new TextEncoder().encode('worknet-mera-account/1'));
const rpc = 'https://testnet-rpc.monad.xyz';
let session: Secp256k1SigningSession | undefined;
let expires = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
type Metadata = { address: Address; credential: PasskeyCredentialMetadata; rpId: string; version: 1 };

export function deriveAccountPrivateKey(prf: Uint8Array): Uint8Array<ArrayBuffer> {
  if (prf.length !== 32) throw new Error('PRF_INVALID');
  for (let index = 0; index < 256; index++) {
    const key = new Uint8Array(hkdf(sha256,prf,undefined,new TextEncoder().encode(`worknet-mera-secp256k1/1:${index}`),32));
    if (secp256k1.utils.isValidSecretKey(key)) return key;
    key.fill(0);
  }
  throw new Error('ACCOUNT_DERIVATION_FAILED');
}
export function meraMetadata(): Metadata | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(metadataKey) ?? 'null');
    if (value?.version === 1 && /^0x[0-9a-fA-F]{40}$/.test(value.address) && typeof value.credential?.credentialId === 'string' && value.rpId === location.hostname) return value;
  } catch { /* The account can still be recovered from its discoverable passkey. */ }
  return undefined;
}
export function lockMera() { session?.end(); session = undefined; expires = 0; if(timer)clearTimeout(timer); }
if (typeof window !== 'undefined') window.addEventListener('pagehide',lockMera);

function createPasskeyUser() {
  const name = `Worknet ${new Date().toLocaleString()} · ${crypto.randomUUID().slice(0,8)}`;
  // Providers may show either field when selecting a discoverable passkey.
  return { name, displayName: name };
}

export async function enterMera(mode: 'create' | 'signin', expected?: Address) {
  if (!globalThis.isSecureContext || typeof navigator.credentials?.get !== 'function') throw new Error('MERA_UNSUPPORTED');
  lockMera();
  const rpId = location.hostname;
  const result = mode === 'create'
    ? await createPasskeyWithPrfOutput({ rp: { id: rpId, name: 'Worknet' }, user: createPasskeyUser(), prfSalt: accountSalt })
    : await getPasskeyPrfOutput({ rpId, prfSalt: accountSalt, ...(expected && meraMetadata() ? { credential: meraMetadata()!.credential } : {}) });
  let key: Uint8Array | undefined;
  try {
    key = deriveAccountPrivateKey(result.prfOutput);
    const next = createSecp256k1SigningSession({ privateKey: key });
    const account = toViemAccount(next);
    if (expected && account.address.toLowerCase() !== expected.toLowerCase()) { next.end(); throw new Error('MERA_ACCOUNT_MISMATCH'); }
    session = next; expires = Date.now() + 5 * 60000; timer = setTimeout(lockMera,5 * 60000);
    const credential: PasskeyCredentialMetadata = { credentialId: result.credentialId };
    // Public metadata only. The passkey, PRF output, and derived keys are never persisted.
    const metadata: Metadata = { version: 1, rpId, address: account.address, credential };
    try { localStorage.setItem(metadataKey,JSON.stringify(metadata)); } catch { /* Discoverable sign-in remains available. */ }
    return account;
  } finally { result.prfOutput.fill(0); key?.fill(0); }
}

export async function meraWallet(expected?: Address) {
  const account = !session || Date.now() >= expires ? await enterMera('signin',expected) : toViemAccount(session);
  if (expected && account.address.toLowerCase() !== expected.toLowerCase()) throw new Error('MERA_ACCOUNT_MISMATCH');
  const base = createWalletClient({ account, chain: monadTestnet, transport: http(rpc,{retryCount:0}) });
  const reader = createPublicClient({ chain: monadTestnet, transport: http(rpc,{retryCount:0}) });
  const client = {
    ...base,
    signMessage: (args: any) => base.signMessage({ ...args, account }),
    signTypedData: (args: any) => base.signTypedData({ ...args, account }),
    async sendTransaction(args: any) {
      let raw:Hex,hash:Hex;
      try {
        if (args.chain && args.chain.id !== 10143) throw new Error('MERA_CHAIN_MISMATCH');
        const prepared = await base.prepareTransactionRequest({ ...args, account, chain: monadTestnet });
        raw = await base.signTransaction({ ...prepared, account, chain: monadTestnet });
        hash = keccak256(raw);
      // Persist the signed transaction before sending. It is a public, immutable authorization,
      // never an account key; an uncertain broadcast returns the same known hash to the journal.
        localStorage.setItem(`worknet-mera-tx:${account.address.toLowerCase()}:${hash}`,JSON.stringify({raw,hash,createdAt:Date.now()}));
      } catch(error) { throw new UnbroadcastTransactionError(error); }
      try { await reader.sendRawTransaction({serializedTransaction:raw}); } catch { /* The receipt, not an RPC error, determines completion. */ }
      return hash;
    },
  };
  return { client, address: account.address };
}

export function meraFailureMessage(error:unknown):string {
  const messages:Record<string,string>={MERA_ACCOUNT_MISMATCH:'这把通行密钥对应另一个账户，请使用当前登录账户的原密钥。',MERA_SIGNIN_REQUIRED:'请先用当前账户的通行密钥重新登录。',SESSION_ENDED:'签名会话已结束，请再次使用通行密钥确认。',MERA_TRANSACTION_INVALID:'账户操作记录不匹配，已停止恢复，请查看原交易。',PRF_UNAVAILABLE:'当前设备未提供 PRF。请使用支持的通行密钥提供商，或换设备重试。'};
  let value:any=error;const seen=new Set<unknown>();
  while(value&&typeof value==='object'&&!seen.has(value)){seen.add(value);for(const[key,message]of Object.entries(messages))if(value.code===key||String(value.message??'').includes(key))return message;value=value.cause;}
  return error instanceof Error?error.message:String(error);
}

export async function createPrivateDelivery(owner: Address, goalId: string, reviewPublicKey: Hex): Promise<DeliveryConfig> {
  const metadata = meraMetadata();
  if (!metadata || metadata.address.toLowerCase() !== owner.toLowerCase()) throw new Error('MERA_SIGNIN_REQUIRED');
  const salt = deliverySalt(metadata.rpId,owner,goalId);
  const { prfOutput } = await getPasskeyPrfOutput({ rpId: metadata.rpId, credential: metadata.credential, prfSalt: hexToBytes(salt) });
  const key = deliveryPrivateKey(prfOutput);
  try { return { scheme:'worknet-delivery/1',salt,publicKey:deliveryPublicKey(key),rpId:metadata.rpId,reviewPublicKey }; }
  finally { key.fill(0);prfOutput.fill(0); }
}
export async function unlockDelivery(delivery: DeliveryConfig, result: { output: any; specHash: string; taskId: string; attempt: string; worker: string }) {
  if (delivery.rpId !== location.hostname) throw new Error('MERA_DOMAIN_MISMATCH');
  const metadata = meraMetadata();
  const { prfOutput } = await getPasskeyPrfOutput({ rpId: delivery.rpId, ...(metadata ? { credential:metadata.credential } : {}), prfSalt:hexToBytes(delivery.salt as Hex) });
  const key = deliveryPrivateKey(prfOutput);
  try {
    if (deliveryPublicKey(key) !== delivery.publicKey) throw new Error('MERA_DELIVERY_KEY_MISMATCH');
    const opening = await openJson(result.output.envelope,key,deliveryContext(result));
    return verifiedOpening(result.output,opening);
  } finally { key.fill(0);prfOutput.fill(0); }
}

export function meraTransactions(owner:string): Array<{hash:Hex;createdAt:number}> {
  const records:Array<{hash:Hex;createdAt:number}>=[];
  try {for(let i=0;i<localStorage.length;i++){const key=localStorage.key(i);if(!key?.startsWith(`worknet-mera-tx:${owner.toLowerCase()}:`))continue;const entry=JSON.parse(localStorage.getItem(key)??'null');if(/^0x[0-9a-f]{64}$/.test(entry?.hash)&&Number.isFinite(entry.createdAt))records.push({hash:entry.hash,createdAt:entry.createdAt});}} catch { /* No signing key is needed to inspect public records. */ }
  return records.sort((a,b)=>b.createdAt-a.createdAt).slice(0,20);
}
export async function retryMeraTransaction(owner:Address,hash:Hex) {
  const record=JSON.parse(localStorage.getItem(`worknet-mera-tx:${owner.toLowerCase()}:${hash}`)??'null');
  if(!record?.raw||keccak256(record.raw)!==hash||parseTransaction(record.raw).chainId!==10143||(await recoverTransactionAddress({serializedTransaction:record.raw})).toLowerCase()!==owner.toLowerCase())throw new Error('MERA_TRANSACTION_INVALID');
  const client=createPublicClient({chain:monadTestnet,transport:http(rpc,{retryCount:0})});
  const receipt=await client.getTransactionReceipt({hash}).catch(()=>undefined);
  if(receipt)return receipt.status;
  try{await client.sendRawTransaction({serializedTransaction:record.raw});}catch{/* Never replace the signed intent or allocate another nonce. */}
  return 'pending';
}
