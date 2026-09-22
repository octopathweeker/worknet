import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,readdirSync} from 'node:fs';
import ts from 'typescript';
import {t,setLanguage,locale,readLanguage} from '../apps/explorer/src/i18n.js';
import {english} from '../apps/explorer/src/translations.js';

test('language switching translates UI messages and interpolation without requiring browser storage',()=>{
 try{
  setLanguage('en');assert.equal(t('我的任务'),'My tasks');assert.equal(locale(),'en-US');assert.equal(t('{0} 分钟前',[3]),'3 minutes ago');
  assert.equal(t('本轮提交截止：12:00。执行已停止或失败，可在下方转为钱包接管。'),'Submission deadline: 12:00. Execution stopped or failed. Take over with your wallet below within the valid lease.');
  assert.equal(t('任务已被领取或结束，请刷新。 TASK_UNAVAILABLE'),'The task was claimed or ended. Refresh. TASK_UNAVAILABLE');
  assert.equal(t('Unrecognized wallet response'),'Unrecognized wallet response');
  setLanguage('zh');assert.equal(t('我的任务'),'我的任务');assert.equal(t('{0} 分钟前',[3]),'3 分钟前');assert.equal(locale(),'zh-CN');
  assert.equal(readLanguage(),'zh');
  const previous=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  try{Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem(){throw new Error('blocked');},setItem(){throw new Error('blocked');}}});assert.equal(readLanguage(),'zh');assert.doesNotThrow(()=>setLanguage('en'));assert.equal(t('我的任务'),'My tasks');}
  finally{if(previous)Object.defineProperty(globalThis,'localStorage',previous);else Reflect.deleteProperty(globalThis,'localStorage');}
 }finally{setLanguage('zh');}
});
test('all Chinese JSX copy uses the central translator, with no translation calls in task input setters',()=>{
 const missing:string[]=[];
 for(const file of readdirSync('apps/explorer/src').filter(f=>f.endsWith('.tsx')&&f!=='LanguageSwitcher.tsx')){
  const src=readFileSync(`apps/explorer/src/${file}`,'utf8'),ast=ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  function visit(node:ts.Node){
   if(ts.isJsxText(node)&&/[\u3400-\u9fff]/.test(node.text))missing.push(`${file}: raw JSX text`);
   if(ts.isCallExpression(node)&&node.expression.getText(ast)==='tr'&&ts.isStringLiteral(node.arguments[0]!))assert(Object.hasOwn(english,(node.arguments[0] as ts.StringLiteral).text),`${file}: missing dictionary key`);
   if(ts.isCallExpression(node)&&['setGoal','setSources','setResultText'].includes(node.expression.getText(ast)))assert(!node.arguments.some(a=>a.getText(ast).includes('tr(')),`${file}: translating user input`);
   ts.forEachChild(node,visit);
  }
  visit(ast);
 }
 assert.deepEqual(missing,[]);
});
