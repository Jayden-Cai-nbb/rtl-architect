import type { Model } from './schema';
import {widthValue} from './parameters';
export type Change = { kind: 'create' | 'delete' | 'rename' | 'update' | 'connect' | 'disconnect'; target: string; path?:string; moduleId?:string; before?: unknown; after?: unknown };
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function fields(before:unknown,after:unknown,target:string,path:string,moduleId?:string):Change[]{
 if(stableStringify(before)===stableStringify(after))return [];
 const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
 if(object(before)&&object(after))return [...new Set([...Object.keys(before),...Object.keys(after)])].sort().flatMap(key=>fields(before[key],after[key],`${target}.${key}`,`${path}/${key.replaceAll('~','~0').replaceAll('/','~1')}`,moduleId));
 if(Array.isArray(before)&&Array.isArray(after)&&[...before,...after].every(v=>object(v)&&typeof v.id==='string')){
  const a=new Map(before.map(v=>[v.id,v])),b=new Map(after.map(v=>[v.id,v]));return [...new Set([...a.keys(),...b.keys()])].sort().flatMap(id=>fields(a.get(id),b.get(id),`${target}.${id}`,`${path}/${id}`,moduleId));
 }
 return [{kind:'update',target,path,...(moduleId?{moduleId}:{}),before,after}];
}
export function semanticDiff(before: Model, after: Model): Change[] {
  const result: Change[] = [];
  for (const key of ['schemaVersion', 'design', 'specification', 'provenance', 'localSignals', 'clocks', 'resets'] as const) {
    if (stableStringify(before[key]) !== stableStringify(after[key])) result.push({ kind: 'update', target: key, before: before[key], after: after[key] });
  }
  for (const id of [...new Set([...before.modules, ...after.modules].map(m => m.id))].sort()) {
    const a = before.modules.find(m => m.id === id), b = after.modules.find(m => m.id === id);
    if (!a) result.push({ kind: 'create', target: id, after: b });
    else if (!b) result.push({ kind: 'delete', target: id, before: a });
    else {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof typeof a>) {
        if (stableStringify(a[key]) === stableStringify(b[key])) continue;
        if (key === 'parameters') {
          for (const parameter of [...new Set([...Object.keys(a.parameters), ...Object.keys(b.parameters)])].sort()) if (a.parameters[parameter] !== b.parameters[parameter]) result.push({ kind: 'update', target: `${id}.parameters.${parameter}`, before: a.parameters[parameter], after: b.parameters[parameter] });
        } else if(['contract','interfaces','interfaceGroups','parameterBindings'].includes(key))result.push(...fields(a[key],b[key],`${id}.${key}`,`/${key}`,id));
        else result.push({ kind: key === 'name' ? 'rename' : 'update', target: `${id}.${key}`, before: a[key], after: b[key] });
      }
    }
  }
  for (const id of [...new Set([...before.connections, ...after.connections].map(l => l.id))].sort()) {
    const a = before.connections.find(l => l.id === id), b = after.connections.find(l => l.id === id);
    if (stableStringify(a) === stableStringify(b)) continue;
    if (a) result.push({ kind: 'disconnect', target: id, before: a });
    if (b) result.push({ kind: 'connect', target: id, after: b });
  }
  return result;
}

export type HardwareChange={category:'state'|'priority'|'width'|'truncation'|'connection';target:string;before:unknown;after:unknown;text:string};
/** Reading summary only. Raw semanticDiff and ordered ASTs remain authoritative. */
export function hardwareChangeSummary(before:Model,after:Model){
 const collect=(m:Model)=>{
  const values=new Map<string,{category:HardwareChange['category'];target:string;value:unknown}>();
  const add=(category:HardwareChange['category'],target:string,value:unknown)=>values.set(category+':'+target,{category,target,value});
  const width=(scope:string,value:Parameters<typeof widthValue>[2])=>{const owner=m.modules.find(n=>n.id===scope);try{return {declared:value,resolved:owner&&!owner.instances?widthValue(m,owner,value):null};}catch{return {declared:value,resolved:null};}};
  const casts=(v:unknown,path:string)=>{
   if(!v||typeof v!=='object')return;
   if(Array.isArray(v)){v.forEach((x,i)=>casts(x,path+'/'+(x&&typeof x==='object'&&'id' in x?String(x.id):i)));return;}
   const obj=v as Record<string,unknown>;
   if(obj.kind==='cast'){add('width',path,{width:obj.width,signed:obj.signed,mode:obj.mode});if(obj.mode==='truncate')add('truncation',path,obj);}
   for(const key of Object.keys(obj).sort())casts(obj[key],path+'/'+key);
  };
  for(const l of m.localSignals??[]){const path=l.scope+'/'+l.id;add('width',path,width(l.scope,l.width));if(l.driver.kind==='register'){add('state',path,{width:l.width,driver:l.driver});if(l.driver.update)add('priority',path,l.driver.update.branches.map(b=>b.id));}casts(l.driver,path+'/driver');}
  for(const owner of m.modules)for(const port of owner.interfaces)add('width',owner.id+'/interface/'+port.id,width(owner.id,port.width));
  for(const c of m.connections)add('connection',c.scope+'/'+c.id,c);
  return values;
 };
 const a=collect(before),b=collect(after),items:HardwareChange[]=[];
 const labels={state:'状态、更新、复位或保持声明',priority:'真实规则匹配顺序',width:'声明/可解析结果位宽或符号',truncation:'显式截断节点及输入顺序',connection:'连接与完整端点/位域'};
 for(const key of [...new Set([...a.keys(),...b.keys()])].sort()){
  const x=a.get(key),y=b.get(key);if(stableStringify(x?.value)===stableStringify(y?.value))continue;const item=y??x!;
  items.push({category:item.category,target:item.target,before:x?.value??null,after:y?.value??null,text:`${labels[item.category]}${!x?'新增':!y?'移除':'变化'}`});
 }
 return {items,note:'确定性声明摘要；原始 diff 完整保留。规则优先级来自数组顺序，位宽未知/数组逐实例解析保留 null。没有推断端到端延迟、吞吐、频率或资源实测。'};
}
