import { canonicalize } from 'json-canonicalize';
import { keccak256 } from 'viem';
import { LIMITS } from './constants.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function unicode(value: string): void {
  if (!value.isWellFormed()) throw new Error('INVALID_UNICODE');
}

/** Reject values which JSON.stringify would silently erase/coerce. */
export function assertJson(value: unknown, depth = 0, parents = new Set<object>()): asserts value is Json {
  if (depth > LIMITS.maxDepth) throw new Error('JSON_TOO_DEEP');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') { unicode(value); return; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error('INVALID_JSON_NUMBER');
    return;
  }
  if (typeof value !== 'object') throw new Error('NOT_JSON');
  if (parents.has(value)) throw new Error('CYCLIC_JSON');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('NOT_PLAIN_JSON');
  if (Object.getOwnPropertySymbols(value).length) throw new Error('NOT_JSON');
  parents.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('NOT_PLAIN_JSON');
      if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error('NOT_JSON_ARRAY');
      unicode(key);
      assertJson(descriptor.value, depth + 1, parents);
    }
    if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new Error('SPARSE_JSON_ARRAY');
  } finally { parents.delete(value); }
}

export function canonicalJson(value: unknown): string {
  assertJson(value);
  const result = canonicalize(value);
  if (new TextEncoder().encode(result).length > LIMITS.maxJsonBytes) throw new Error('JSON_TOO_LARGE');
  return result;
}

export function canonicalBytes(value: unknown): Uint8Array { return new TextEncoder().encode(canonicalJson(value)); }
export function hashJson(value: unknown) { return keccak256(canonicalBytes(value)); }

/** Parse untrusted wire JSON without losing duplicate-key evidence. No reviver/toJSON hooks. */
export function parseJsonStrict(text: string): Json {
  unicode(text);
  if (new TextEncoder().encode(text).length > LIMITS.maxJsonBytes) throw new Error('JSON_TOO_LARGE');
  let i = 0;
  const whitespace = () => { while (i < text.length && /[ \t\r\n]/.test(text[i]!)) i++; };
  const fail = (): never => { throw new Error(`INVALID_JSON at ${i}`); };
  function string(): string {
    const start = i++;
    while (i < text.length) {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i++] === '"') {
        const value: string = JSON.parse(text.slice(start, i));
        unicode(value);
        return value;
      }
    }
    return fail();
  }
  function value(depth: number): Json {
    if (depth > LIMITS.maxDepth) throw new Error('JSON_TOO_DEEP');
    whitespace();
    if (text[i] === '"') return string();
    if (text[i] === '{') {
      i++; whitespace();
      const object = Object.create(null) as { [key: string]: Json };
      const keys = new Set<string>();
      if (text[i] === '}') { i++; return object; }
      while (i < text.length) {
        if (text[i] !== '"') fail();
        const key = string();
        if (keys.has(key)) throw new Error(`DUPLICATE_JSON_KEY: ${key}`);
        keys.add(key); whitespace();
        if (text[i++] !== ':') fail();
        object[key] = value(depth + 1); whitespace();
        if (text[i] === '}') { i++; return object; }
        if (text[i++] !== ',') fail();
        whitespace();
      }
      return fail();
    }
    if (text[i] === '[') {
      i++; whitespace();
      const array: Json[] = [];
      if (text[i] === ']') { i++; return array; }
      while (i < text.length) {
        array.push(value(depth + 1)); whitespace();
        if (text[i] === ']') { i++; return array; }
        if (text[i++] !== ',') fail();
      }
      return fail();
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i))?.[0];
    if (!token) return fail();
    i += token.length;
    const parsed: unknown = JSON.parse(token);
    assertJson(parsed);
    return parsed;
  }
  const result = value(0); whitespace();
  if (i !== text.length) fail();
  return result;
}

export function parseJsonBytes(bytes: Uint8Array): Json {
  if (bytes.length > LIMITS.maxJsonBytes) throw new Error('JSON_TOO_LARGE');
  return parseJsonStrict(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
