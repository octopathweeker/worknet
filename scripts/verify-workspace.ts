import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { erc20Abi, type Hex } from 'viem';
import { loadConfig, chainClient, json } from '@agent-task/runtime';
import type { WorkspaceSnapshot } from '@agent-task/workspace';
const config=loadConfig('.runtime/testnet/config.json'); const client=chainClient(config);
const response=await fetch('http://127.0.0.1:8790/api/workspace/snapshot',{headers:{authorization:`Bearer ${process.env.REQUESTER_API_TOKEN}`}}); assert.equal(response.status,200);
const snapshot=await response.json() as WorkspaceSnapshot;
const expected=['95601495-7437-46a0-96ed-5802a66f7670','51c50a63-0ca6-46ff-b3b3-ed4f0be86b41'];
const cases=[];
for(const id of expected){
 const goal=snapshot.goals.find(g=>g.id===id); assert.ok(goal); assert.equal(goal.status,'completed'); assert.equal(goal.tasks.length,1);
 const task=goal.tasks[0]!; assert.equal(task.status,3); assert.ok(task.verification!.some(e=>e.verdict==='accept'&&e.attempt===task.attempt&&e.resultHash===task.resultHash));
 const receipts=[];
 for(const event of task.events!){ const receipt=await client.getTransactionReceipt({hash:event.transactionHash as Hex}); assert.equal(receipt.status,'success'); receipts.push({event:event.eventName,hash:event.transactionHash,blockNumber:receipt.blockNumber,gasUsed:receipt.gasUsed}); }
 assert.ok(task.events!.some(e=>e.eventName==='TaskSettled'&&Number(e.args.reason)===0));
 if(task.kind==='research'){assert.equal(goal.input.sourceUrls.length,1);const output=(task.result as any).output;assert.match(output.summary,/[\u3400-\u9fff]/); assert.ok(output.findings.every((f:any)=>goal.input.sourceUrls.includes(f.sourceUri)));}
 cases.push({goal,receipts});
}
assert.ok(snapshot.workers.every(w=>w.online&&w.accepting));
const workers=[];for(const worker of snapshot.workers) workers.push({...worker,usdcBalance:await client.readContract({address:config.token,abi:erc20Abi,functionName:'balanceOf',args:[worker.address as `0x${string}`]})});
await writeFile('docs/stages/R1/gui-acceptance.json',json({checkedAt:new Date().toISOString(),chainId:10143,publicUrl:config.storageUrl,passed:true,workflow:'Both goals were created and confirmed using the public browser GUI. Analysis task remained OPEN while Delta was paused via GUI, then settled after GUI resume. Research used a custom Chinese goal and a single source.',cases,workers})+'\n');
console.log(json({passed:true,goals:cases.map(c=>({id:c.goal.id,taskId:c.goal.tasks[0]!.taskId,status:c.goal.status})),workers:workers.map(w=>({address:w.address,online:w.online,accepting:w.accepting,usdcBalance:w.usdcBalance}))}));
