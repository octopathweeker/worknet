import {useSyncExternalStore} from 'react';
import {english} from './translations.js';
export type Language='zh'|'en';
const storageKey='worknet-language';
export function readLanguage():Language {try{return globalThis.localStorage?.getItem(storageKey)==='en'?'en':'zh';}catch{return 'zh';}}
let language:Language=readLanguage();
const listeners=new Set<()=>void>();
export const locale=()=>language==='en'?'en-US':'zh-CN';
function applyDocument(){if(typeof document==='undefined')return;document.documentElement.lang=language==='en'?'en':'zh-CN';document.title=language==='en'?'Worknet · Task platform':'Worknet · 任务平台';}
export function setLanguage(next:Language){if(next!=='zh'&&next!=='en')return;language=next;try{globalThis.localStorage?.setItem(storageKey,next);}catch{/* Language switching works even when storage is blocked. */}applyDocument();listeners.forEach(fn=>fn());}
export function useLanguage(){return useSyncExternalStore(fn=>{listeners.add(fn);return()=>listeners.delete(fn);},()=>language,()=> 'zh' as Language);}
if(typeof window!=='undefined'){applyDocument();window.addEventListener('storage',event=>{if(event.key!==storageKey&&event.key!==null)return;language=readLanguage();applyDocument();listeners.forEach(fn=>fn());});}
const patterns=Object.entries(english).filter(([key])=>/\{\d+\}/.test(key)).map(([key,value])=>({regex:new RegExp('^'+key.split(/\{\d+\}/).map(part=>part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('([\\s\\S]*?)')+'$'),value}));
/** Call only for interface copy, never for task text, quotes, addresses or signed data. */
export function t(value:string|null|undefined,values:readonly unknown[]=[]):string{
 if(value==null)return '';
 let text=value;
 if(language==='en'){
  if(Object.hasOwn(english,value))text=english[value]!;
  else{const coded=/^(.*) ([A-Z][A-Z_]+)$/.exec(value);if(coded&&Object.hasOwn(english,coded[1]!))return english[coded[1]!]+' '+coded[2];for(const pattern of patterns){const match=pattern.regex.exec(value);if(match){return pattern.value.replace(/\{(\d+)\}/g,(_,index)=>t(match[Number(index)+1]??''));}}}
 }
 return text.replace(/\{(\d+)\}/g,(original,index)=>Number(index)<values.length?String(values[Number(index)]??''):original);
}
