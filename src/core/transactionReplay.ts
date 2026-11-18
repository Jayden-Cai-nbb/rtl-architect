import {resolveWidth} from './endpoints';
import {z} from 'zod';
import {idSchema,type Model,type TransactionPath} from './schema';
export const replayMappingSchema=z.strictObject({schemaVersion:z.literal(1),moduleId:idSchema,pathId:idSchema,origin:z.enum(['simulation','manual']),runId:idSchema,artifact:z.string().min(1),configuration:z.string().min(1),reset:z.string().min(1),points:z.array(z.strictObject({model:z.strictObject({moduleId:idSchema,data:idSchema,valid:idSchema,ready:idSchema}),data:z.string().min(1),valid:z.string().min(1),ready:z.string().min(1)})).min(2).max(9)});
const sample=z.record(z.string().min(1),z.string().max(80).nullable());
export const replaySamplesSchema=z.strictObject({format:z.literal('rtlarch-rv-samples-v1'),clock:z.strictObject({id:idSchema,edge:z.enum(['rising','falling'])}),sampling:z.literal('pre_edge_handshake_post_edge_settled'),rows:z.array(z.strictObject({edge:z.number().int().nonnegative().max(1000000),pre:sample,post:sample})).min(1).max(4096)});
export type ReplayMapping=z.infer<typeof replayMappingSchema>;
export type ReplaySamples=z.infer<typeof replaySamplesSchema>;
export function transactionPathIssues(model:Model,owner:string,path:TransactionPath){
 const errors:string[]=[],clock=model.clocks.find(c=>c.id===path.clock),reset=model.resets.find(r=>r.id===path.reset);
 if(!clock||!reset||!reset.synchronous||reset.clock!==path.clock)errors.push('仅支持明确单时钟、同步复位');
 const seen=new Set<string>();
 for(const stage of path.stages){
  for(const [ref,width] of [[stage.dataState,path.width],[stage.validState,1]] as const){
   const m=model.modules.find(m=>m.id===ref.moduleId),local=model.localSignals?.find(s=>s.scope===ref.moduleId&&s.id===ref.localSignalId);
   if(!m||m.instances||m.clock!==path.clock||m.reset!==path.reset||!local||local.width!==width||local.driver.kind!=='register'||!local.driver.update)errors.push(`状态未明确映射或不在同一域：${ref.moduleId}.${ref.localSignalId}`);
   const key=JSON.stringify(ref);if(seen.has(key))errors.push('状态被重复用作事务保存位置');seen.add(key);
  }
  const data=model.localSignals?.find(s=>s.scope===stage.dataState.moduleId&&s.id===stage.dataState.localSignalId);
  if(data?.driver.kind==='register'&&!data.driver.update?.branches.some(b=>b.id===stage.loadBranch))errors.push('装载分支不存在');
  const valid=model.localSignals?.find(s=>s.scope===stage.validState.moduleId&&s.id===stage.validState.localSignalId);
  if(valid?.driver.kind==='register'){const r=valid.driver.update?.reset;if(!r||r.activeLevel!==reset?.activeLevel||r.value.kind!=='constant'||BigInt(r.value.value)!==0n)errors.push('cancel_all 需要有效状态明确复位为 0');}
  if(stage.dataState.moduleId!==stage.validState.moduleId)errors.push('data/valid 必须属于同一个状态作用域');
  for(const id of stage.evidenceIds)if(!model.provenance?.evidence.some(e=>e.id===id))errors.push(`源码依据不存在：${id}`);
 }
 if(new Set(path.connectionIds).size!==path.connectionIds.length)errors.push('连接引用重复');
 for(const id of path.connectionIds)if(!model.connections.some(l=>l.id===id))errors.push(`连接不存在：${id}`);
 // Hierarchy cycles are separately rejected by engine; bound traversal here as well.
 for(const s of path.stages){let id:string|null=s.dataState.moduleId,found=false;for(let n=0;id&&n<=model.modules.length;n++){if(id===owner){found=true;break;}id=model.modules.find(m=>m.id===id)?.parent??null;}if(!found)errors.push('状态不在声明模块内');}
 return errors;
}
export type ReplayEvent={kind:'accept'|'visible'|'consume'|'cancel';phase:'pre'|'post';edge:number;transaction:string;payload:string;stage:number;state:TransactionPath['stages'][number]['dataState'];branch:string|null;matched:boolean;};
export type ReplayIssue={code:string;edge:number;phase:'pre'|'post';transaction:string|null;stage:number;state:TransactionPath['stages'][number]['dataState'];expected:string;actual:string;};
/** A bounded FIFO identity scoreboard over explicit observations, never an RTL simulator. */
export function replayTransactions(model:Model,path:TransactionPath,mapping:ReplayMapping,samples:ReplaySamples){
 if(samples.clock.id!==path.clock||samples.clock.edge!==model.clocks.find(c=>c.id===path.clock)?.edge)throw new Error('产物采样时钟/有效边沿与声明不符');
 if(mapping.points.length!==path.stages.length+1)throw new Error('映射点数必须是保存级数 + 1');
 for(const [i,point] of mapping.points.entries()){
  const m=model.modules.find(m=>m.id===point.model.moduleId);
  if(!m||m.instances||m.clock!==path.clock||point.model.moduleId!==(i===0?mapping.moduleId:path.stages[i-1].dataState.moduleId))throw new Error('观察点须显式对应路径入口与每级输出的同域模块');
  for(const role of ['data','valid','ready'] as const){const p=m.interfaces.find(p=>p.id===point.model[role]);if(!p||p.protocol!=='signal'||resolveWidth(m,p,model)!==(role==='data'?path.width:1)||p.role!==((i===0)===(role==='ready')?'producer':'consumer'))throw new Error(`观察点接口/方向/位宽未匹配：${m.id}.${point.model[role]}`);}
 }
 const keys=[mapping.reset,...mapping.points.flatMap(p=>[p.data,p.valid,p.ready])];
 if(new Set(keys).size!==keys.length)throw new Error('每个观察角色须使用独立映射列');
 const active=model.resets.find(r=>r.id===path.reset)!.activeLevel==='high'?1n:0n;
 type Token={id:string;payload:string};let slots:(Token|null)[]=path.stages.map(()=>null),sequence=0,unknown=false;
 const issues:ReplayIssue[]=[],events:ReplayEvent[]=[],rows:{edge:number;events:ReplayEvent[];locations:{transaction:string;payload:string;state:TransactionPath['stages'][number]['dataState']}[];blocked:number[];issues:ReplayIssue[]}[]=[];
 const event=(kind:ReplayEvent['kind'],edge:number,t:Token,stage:number)=>{const s=path.stages[stage];const e:ReplayEvent={kind,phase:kind==='visible'?'post':'pre',edge,transaction:t.id,payload:t.payload,stage,state:kind==='cancel'?s.validState:s.dataState,branch:kind==='cancel'?'reset':kind==='visible'||kind==='accept'?s.loadBranch:null,matched:true};events.push(e);return e;};
 const issue=(code:string,edge:number,phase:'pre'|'post',stage:number,t:Token|null,expected:string,actual:string)=>{issues.push({code,edge,phase,stage,transaction:t?.id??null,state:code==='VALID_PHASE'?path.stages[stage].validState:path.stages[stage].dataState,expected,actual});};
 for(const [index,row] of samples.rows.entries()){
  const eventStart=events.length,issueStart=issues.length;
  if(row.edge!==index)throw new Error('首沿必须 E0，记录必须连续；不允许省略采样沿');
  let readPhase:'pre'|'post'='pre';
  const read=(phase:'pre'|'post',key:string,width:number)=>{readPhase=phase;const v=row[phase][key];if(typeof v!=='string'||! /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(v))throw new Error(`UNKNOWN ${phase}.${key}`);const n=BigInt(v);if(n>=1n<<BigInt(width))throw new Error(`超宽 ${phase}.${key}`);return n;};
  try{
   const reset=read('pre',mapping.reset,1)===active;
   if(read('post',mapping.reset,1)!==read('pre',mapping.reset,1))throw new Error('同一沿前后复位变化超出同步回放范围');
   if(index===0&&!reset)throw new Error('E0 未观察到复位，初始事务身份 UNKNOWN');
   const pre=mapping.points.map(p=>({valid:read('pre',p.valid,1)===1n,ready:read('pre',p.ready,1)===1n,data:read('pre',p.data,path.width).toString()}));
   const post=mapping.points.map(p=>({valid:read('post',p.valid,1)===1n,ready:read('post',p.ready,1)===1n,data:read('post',p.data,path.width).toString()}));
   if(!reset)for(let i=0;i<slots.length;i++){
    const t=slots[i],p=pre[i+1];if(p.valid!==!!t)issue('VALID_PHASE',row.edge,'pre',i,t,String(!!t),String(p.valid));
    if(t&&p.valid&&p.data!==t.payload)issue('PAYLOAD_MISMATCH',row.edge,'pre',i,t,t.payload,p.data);
   }
   const blocked=pre.slice(1).flatMap((p,i)=>p.valid&&!p.ready?[i]:[]);
   let next=slots.slice();
   if(reset){slots.forEach((t,i)=>{if(t)event('cancel',row.edge,t,i);});next=slots.map(()=>null);}
   else{
    const moves=pre.map(p=>p.valid&&p.ready);
    let input:Token|null=null;if(moves[0]){input={id:`T${sequence++}`,payload:pre[0].data};event('accept',row.edge,input,0);}
    const last=slots.length-1;if(moves.at(-1)&&slots[last])event('consume',row.edge,slots[last]!,last);
    for(let i=0;i<slots.length;i++){
     if(moves[i+1])next[i]=null;
     if(moves[i]){const t=i===0?input:slots[i-1];if(next[i])issue('OCCUPIED_OVERWRITE',row.edge,'pre',i,next[i],'保持在途事务','新的输入握手');next[i]=t;if(t)event('visible',row.edge,t,i);else issue('UNIDENTIFIED_TRANSFER',row.edge,'pre',i,null,'已接受的事务','无身份的上游传输');}
    }
   }
   for(let i=0;i<next.length;i++){
    const t=next[i],p=post[i+1];if(p.valid!==!!t)issue('VALID_PHASE',row.edge,'post',i,t,String(!!t),String(p.valid));
    if(t&&p.valid&&p.data!==t.payload)issue(blocked.includes(i)&&slots[i]?.id===t.id?'BLOCKED_PAYLOAD_OVERWRITE':'PAYLOAD_MISMATCH',row.edge,'post',i,t,t.payload,p.data);
   }
   for(const e of events.slice(eventStart))if(e.kind==='visible')e.matched=post[e.stage+1].valid&&post[e.stage+1].data===e.payload;else if(e.kind==='cancel')e.matched=!post[e.stage+1].valid;
   slots=next;
   rows.push({edge:row.edge,events:events.slice(eventStart),locations:slots.flatMap((t,i)=>t?[{transaction:t.id,payload:t.payload,state:path.stages[i].dataState}]:[]),blocked,issues:issues.slice(issueStart)});
  }catch(e){unknown=true;issue('UNKNOWN',row.edge,readPhase,0,null,'完整二态沿前/沿后记录',String(e));rows.push({edge:row.edge,events:[],locations:[],blocked:[],issues:issues.slice(issueStart)});break;}
 }
 return {status:issues.some(i=>i.code!=='UNKNOWN')?'FAILED':unknown?'UNKNOWN':'OBSERVED',events,issues,rows,unprocessed:samples.rows.length-rows.length,inFlight:slots.filter(Boolean),note:'visible 为合同所期望的沿后可见事件；数据/有效实际不符保留该沿诊断。身份按输入接受顺序分配，不从 payload 猜身份；只核对本次二态、有序、无数据变换的单槽路径，不证明任意 RTL 或完整时序。'};
}
