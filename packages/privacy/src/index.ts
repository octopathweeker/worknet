import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, type Hex } from 'viem';
import { canonicalJson, hashJson } from '@agent-task/protocol/json';
import { z } from 'zod';

const key = z.string().regex(/^0x[0-9a-f]{64}$/);
export const deliveryConfigSchema = z.object({ scheme: z.literal('worknet-delivery/1'), salt: key, publicKey: key, rpId: z.string().min(1).max(253), reviewPublicKey: key }).strict();
export type DeliveryConfig = z.infer<typeof deliveryConfigSchema>;
export const envelopeSchema = z.object({ scheme: z.literal('x25519-hkdf-sha256-aes256gcm/1'), recipient: key, ephemeral: key, iv: z.string().regex(/^0x[0-9a-f]{24}$/), ciphertext: z.string().regex(/^0x[0-9a-f]+$/).max(520000) }).strict();
export type SealedEnvelope = z.infer<typeof envelopeSchema>;
export type Opening = { output: unknown; nonce: Hex };
export const privateOutputSchema = z.object({ kind: z.literal('worknet-private-output/1'), commitment: key, envelope: envelopeSchema }).strict();
const encoder = new TextEncoder();

export function deliverySalt(rpId: string, owner: string, goalId: string): Hex {
  return bytesToHex(sha256(encoder.encode(canonicalJson({ namespace: 'worknet-delivery/1', rpId, owner: owner.toLowerCase(), goalId }))));
}
export function deliveryPrivateKey(prf: Uint8Array): Uint8Array<ArrayBuffer> {
  if (prf.length !== 32) throw new Error('PRF_INVALID');
  return new Uint8Array(hkdf(sha256, prf, undefined, encoder.encode('worknet-delivery-x25519/1'), 32));
}
export function deliveryPublicKey(secret: Uint8Array) { return bytesToHex(x25519.getPublicKey(secret)); }
function contextBytes(context: string, recipient: Hex, ephemeral: Hex) { return encoder.encode(canonicalJson({ scheme: 'x25519-hkdf-sha256-aes256gcm/1', context, recipient, ephemeral })); }

/** Ephemeral X25519 + HKDF-SHA256 + authenticated AES-GCM; no persistent content key. */
export async function sealJson(value: unknown, recipient: Hex, context: string, senderSecret?: Uint8Array): Promise<SealedEnvelope> {
  const secret = senderSecret ? new Uint8Array(senderSecret) : crypto.getRandomValues(new Uint8Array(32));
  const ephemeral = deliveryPublicKey(secret); let shared: Uint8Array | undefined; let material: Uint8Array | undefined;
  try {
    shared = x25519.getSharedSecret(secret, hexToBytes(recipient));
    const aad = contextBytes(context, recipient, ephemeral);
    material = hkdf(sha256, shared, sha256(aad), encoder.encode('worknet-sealed-box/1'), 32);
    const aes = await crypto.subtle.importKey('raw', new Uint8Array(material), 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(canonicalJson(value));
    if (plaintext.length > 250000) throw new Error('PRIVATE_DELIVERY_TOO_LARGE');
    try {
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aes, plaintext);
      return { scheme: 'x25519-hkdf-sha256-aes256gcm/1', recipient, ephemeral, iv: bytesToHex(iv), ciphertext: bytesToHex(new Uint8Array(encrypted)) };
    } finally { plaintext.fill(0); }
  } finally { secret.fill(0); shared?.fill(0); material?.fill(0); }
}
export async function openJson(input: unknown, secret: Uint8Array, context: string): Promise<unknown> {
  const envelope = envelopeSchema.parse(input);
  if (deliveryPublicKey(secret) !== envelope.recipient) throw new Error('PRIVATE_RECIPIENT_MISMATCH');
  let shared: Uint8Array | undefined, material: Uint8Array | undefined;
  try {
    shared = x25519.getSharedSecret(secret, hexToBytes(envelope.ephemeral as Hex));
    const aad = contextBytes(context, envelope.recipient as Hex, envelope.ephemeral as Hex);
    material = hkdf(sha256, shared, sha256(aad), encoder.encode('worknet-sealed-box/1'), 32);
    const aes = await crypto.subtle.importKey('raw', new Uint8Array(material), 'AES-GCM', false, ['decrypt']);
    const decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(hexToBytes(envelope.iv as Hex)), additionalData: aad }, aes, new Uint8Array(hexToBytes(envelope.ciphertext as Hex))));
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decrypted)); } finally { decrypted.fill(0); }
  } finally { shared?.fill(0); material?.fill(0); }
}
export function deliveryContext(result: { specHash: string; taskId: string; attempt: string; worker: string }) {
  return canonicalJson({ namespace: 'worknet-result/1', specHash: result.specHash, taskId: result.taskId, attempt: result.attempt, worker: result.worker.toLowerCase() });
}
export function isPrivateOutput(output: unknown): output is z.infer<typeof privateOutputSchema> { return privateOutputSchema.safeParse(output).success; }
export function verifiedOpening(output: unknown, opening: unknown): unknown {
  const committed = privateOutputSchema.parse(output);
  const parsed = z.object({ output: z.unknown(), nonce: key }).strict().parse(opening);
  if (hashJson(parsed) !== committed.commitment) throw new Error('PRIVATE_COMMITMENT_MISMATCH');
  return parsed.output;
}
export async function sealOutput(output: unknown, delivery: DeliveryConfig, context: string) {
  const opening: Opening = { output, nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(32))) };
  const senderSecret = envelopeProofSecret(opening.nonce);
  try {
    const [envelope, review] = await Promise.all([sealJson(opening, delivery.publicKey as Hex, context, senderSecret), sealJson(opening, delivery.reviewPublicKey as Hex, context)]);
    return { output: { kind: 'worknet-private-output/1' as const, commitment: hashJson(opening), envelope }, review };
  } finally { senderSecret.fill(0); }
}
function envelopeProofSecret(nonce: Hex) { return new Uint8Array(hkdf(sha256,hexToBytes(nonce),undefined,encoder.encode('worknet-delivery-envelope-proof/1'),32)); }
/** The authorized reviewer can reproduce this ciphertext's ephemeral key from the private
 * opening nonce. It proves recipient decryptability without learning the recipient private key. */
export async function verifyRecipientEnvelope(output: unknown, opening: Opening, context: string) {
  verifiedOpening(output,opening);
  const {envelope}=privateOutputSchema.parse(output);
  const secret=envelopeProofSecret(opening.nonce);let shared:Uint8Array|undefined,material:Uint8Array|undefined;
  try {
    if(deliveryPublicKey(secret)!==envelope.ephemeral)throw new Error('PRIVATE_ENVELOPE_PROOF_MISMATCH');
    shared=x25519.getSharedSecret(secret,hexToBytes(envelope.recipient as Hex));
    const aad=contextBytes(context,envelope.recipient as Hex,envelope.ephemeral as Hex);
    material=hkdf(sha256,shared,sha256(aad),encoder.encode('worknet-sealed-box/1'),32);
    const aes=await crypto.subtle.importKey('raw',new Uint8Array(material),'AES-GCM',false,['encrypt']);
    const plaintext=encoder.encode(canonicalJson(opening));
    try {
      const expected=await crypto.subtle.encrypt({name:'AES-GCM',iv:new Uint8Array(hexToBytes(envelope.iv as Hex)),additionalData:aad},aes,plaintext);
      if(bytesToHex(new Uint8Array(expected))!==envelope.ciphertext)throw new Error('PRIVATE_ENVELOPE_PROOF_MISMATCH');
    } finally {plaintext.fill(0);}
  } finally {secret.fill(0);shared?.fill(0);material?.fill(0);}
}
