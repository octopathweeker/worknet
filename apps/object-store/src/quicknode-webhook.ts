import type { Env } from './index.js';

async function textBody(request: Request) {
  if(!request.body)throw new Error('BODY');
  if(Number(request.headers.get('content-length')??0)>262144)throw new Error('SIZE');
  // Configure QuickNode with compression disabled. Explicit refusal is safer than ambiguous
  // auto-decompression, and prevents a compressed payload from bypassing the size bound.
  if(request.headers.has('content-encoding')&&request.headers.get('content-encoding')!=='identity')throw new Error('ENCODING');
  const reader=request.body.getReader();const decoder=new TextDecoder('utf-8',{fatal:true});let length=0,text='';
  try {for(;;){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>262144){await reader.cancel();throw new Error('SIZE');}text+=decoder.decode(part.value,{stream:true});}return text+decoder.decode();}finally{reader.releaseLock();}
}
export async function verifyQuicknode(request: Request, secret: string, now=Date.now()) {
  const nonce=request.headers.get('x-qn-nonce')??'',timestamp=request.headers.get('x-qn-timestamp')??'',signature=request.headers.get('x-qn-signature')??'';
  if(!/^[\w-]{1,128}$/.test(nonce)||!/^\d{10}(?:\d{3})?$/.test(timestamp)||! /^[0-9a-f]{64}$/i.test(signature))throw new Error('SIGNATURE');
  const at=Number(timestamp)*(timestamp.length===10?1000:1);if(Math.abs(now-at)>300000)throw new Error('STALE');
  const payload=await textBody(request);const encoder=new TextEncoder();
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const bytes=Uint8Array.from(signature.match(/../g)!,v=>parseInt(v,16));
  if(!await crypto.subtle.verify('HMAC',key,bytes,encoder.encode(nonce+timestamp+payload)))throw new Error('SIGNATURE');
  JSON.parse(payload); // Payload is a wake-up hint, never trusted chain state or a command.
  const digest=await crypto.subtle.digest('SHA-256',encoder.encode(nonce+timestamp+signature));
  return Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
}
export async function quicknodeWebhook(request: Request, env: Env) {
  const reply=(status:number)=>new Response(null,{status,headers:{'cache-control':'no-store'}});
  if(request.method!=='POST')return reply(405);
  if(!env.QUICKNODE_WEBHOOK_SECRET||!env.DB||!env.PLATFORM)return reply(503);
  let id:string;try{id=await verifyQuicknode(request,env.QUICKNODE_WEBHOOK_SECRET);}catch{return reply(401);}
  const seen=await env.DB.prepare('SELECT id FROM platform_webhook_receipts WHERE id=?').bind(id).first();if(seen)return reply(204);
  try {
    // A retry after process death can wake twice; coordinator coalesces wakeups and indexes
    // finalized RPC logs idempotently. Never mark delivered before durable wake succeeds.
    const response=await env.PLATFORM.get(env.PLATFORM.idFromName('coordinator-v1')).fetch('https://internal/wake',{method:'POST'});
    if(!response.ok)return reply(503);
    await env.DB.prepare('INSERT OR IGNORE INTO platform_webhook_receipts(id,created_at) VALUES (?,?)').bind(id,Date.now()).run();
    return reply(204);
  }catch{return reply(503);}
}
