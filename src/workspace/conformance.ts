import {z} from 'zod';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {idSchema,modelSchema,type Model,type Endpoint} from '../core/schema';
import {modelHash,hashValue} from '../core/export';
import {parameterValue,widthValue} from '../core/parameters';
import {netlistSchema} from './importYosys';
import {verificationRuns} from './verification';
import {inputFile,newArtifactDirectory,workspacePath} from './artifacts';
const name=z.string().min(1),rv=z.strictObject({data:name,valid:name,ready:name});
export const conformanceSchema=z.strictObject({schemaVersion:z.literal(1),runId:z.string().regex(/^run_\d+_[a-f0-9]{32}$/),netlist:name,top:name,mappings:z.array(z.strictObject({moduleId:idSchema,instancePath:z.array(name).max(64),rtlType:name,parameters:z.record(idSchema,name),ports:z.record(idSchema,z.union([name,rv])),clock:name.optional(),reset:name.optional()})).min(1).max(4096)});
type Manifest=z.infer<typeof conformanceSchema>;
type Item={target:string;status:'MATCH'|'MISMATCH'|'UNKNOWN';reason:string;expected?:unknown;actual?:unknown};
/** Boundary comparison only. Bit IDs are compared exclusively in their common RTL scope. */
export function compareStructure(model:Model,manifest:Manifest,raw:unknown){
 const net=netlistSchema.parse(raw),items:Item[]=[],mapped=new Map(manifest.mappings.map(m=>[m.moduleId,m]));
 const add=(target:string,expected:unknown,actual:unknown,reason:string)=>items.push({target,status:actual===undefined?'UNKNOWN':hashValue(expected)===hashValue(actual)?'MATCH':'MISMATCH',reason,expected,actual});
 const unknown=(target:string,reason:string)=>items.push({target,status:'UNKNOWN',reason});
 const instance=(path:string[])=>{let def=net.modules[manifest.top],cell:typeof def.cells[string]|undefined;for(const name of path){cell=def?.cells[name];if(!cell)return undefined;def=net.modules[cell.type];if(!def)return undefined;}return def?{def,cell}:undefined;};
 if(new Set(manifest.mappings.map(m=>JSON.stringify(m.instancePath))).size!==manifest.mappings.length)unknown('mapping','多个架构模块映射同一个 RTL 实例');
 if(mapped.size!==manifest.mappings.length)unknown('mapping','同一模块重复映射');
 for(const mapping of manifest.mappings){
  const m=model.modules.find(m=>m.id===mapping.moduleId),found=instance(mapping.instancePath),target=mapping.moduleId;
  if(!m){unknown(target,'模型模块不存在');continue;}if(m.instances){unknown(target,'实例数组暂不支持逐元素一致性检查');continue;}
  if(!found){items.push({target,status:'MISMATCH',reason:'映射的 RTL 实例不存在'});continue;}
  const {def,cell}=found;if(def.attributes.blackbox&&String(def.attributes.blackbox).includes('1'))unknown(target+'.blackbox','黑盒没有可核对的实现');const actualType=typeof def.attributes.hdlname==='string'?def.attributes.hdlname:cell?.type??manifest.top;
  add(target+'.rtlMapping',m.rtlModule,mapping.rtlType,'显式映射须与设计的 RTL 标识一致');
  add(target+'.type',mapping.rtlType,actualType,'显式映射的 RTL 类型');
  const parent=m.parent?mapped.get(m.parent):undefined;
  if(parent)add(target+'.parent',parent.instancePath,mapping.instancePath.slice(0,-1),'相邻架构层级的实例路径');
  for(const p of Object.keys(m.parameters)){
   const rtl=mapping.parameters[p],raw=rtl?({...def.parameter_default_values,...cell?.parameters})[rtl]:undefined;
   let actual:unknown=raw,expected:unknown;try{expected=parameterValue(model,m,p);}catch{unknown(target+'.parameters.'+p,'模型参数无法求值');continue;}
   if(typeof raw==='string'&&/^[01]+$/.test(raw)&&typeof expected==='number'){const value=BigInt('0b'+raw);actual=value<=BigInt(Number.MAX_SAFE_INTEGER)?Number(value):undefined;}
   // Signed/string parameters require explicit representation metadata; do not guess encoding.
   if(typeof expected!=='number'||typeof expected==='number'&&expected<0)actual=undefined;
   add(target+'.parameters.'+p,expected,actual,'无映射、非整数或符号编码不明确时保留未知');
  }
  for(const p of m.interfaces){
   const binding=mapping.ports[p.id];if(!binding){unknown(target+'.ports.'+p.id,'缺少显式端口映射');continue;}
   if((p.protocol==='rv')!==(typeof binding==='object')){unknown(target+'.ports.'+p.id,'协议与端口映射类型不同');continue;}
   const pins=typeof binding==='string'?{data:binding}:binding;
   for(const [part,pin] of Object.entries(pins)){
    const actual=def.ports[pin];let width:number;try{width=part==='data'?widthValue(model,m,p.width):1;}catch{unknown(target+'.ports.'+p.id,'位宽无法求值');continue;}
    const output=(p.role==='producer')!==(part==='ready');
    if(!actual){items.push({target:target+'.ports.'+p.id+'.'+part,status:'MISMATCH',reason:'RTL 端口不存在'});continue;}
    add(target+'.ports.'+p.id+'.'+part,{width,direction:output?'output':'input'},actual.direction==='inout'?undefined:{width:actual.bits.length,direction:actual.direction},'端口位宽和方向');
   }
  }
  for(const kind of ['clock','reset'] as const){if(!m[kind])continue;const pin=mapping[kind],port=pin?def.ports[pin]:undefined;add(target+'.'+kind,{width:1,direction:'input'},port?{width:port.bits.length,direction:port.direction}:undefined,'仅检查控制引脚结构；不证明有效沿、极性或复位行为');}
 }
 const endpointBits=(e:Endpoint,scopeId:string,part:'data'|'valid'|'ready')=>{
  if(e.local||e.index!==undefined||e.sliceMapping)return undefined;
  const m=mapped.get(e.moduleId),scope=mapped.get(scopeId);if(!m||!scope)return undefined;
  const binding=m.ports[e.interfaceId],pin=typeof binding==='string'?(part==='data'?binding:undefined):binding?.[part];if(!pin)return undefined;
  const s=instance(scope.instancePath);if(!s)return undefined;
  let bits: (number|string)[]|undefined;
  if(e.moduleId===scopeId)bits=s.def.ports[pin]?.bits;
  else if(m.instancePath.length===scope.instancePath.length+1&&JSON.stringify(m.instancePath.slice(0,-1))===JSON.stringify(scope.instancePath))bits=s.def.cells[m.instancePath.at(-1)!]?.connections[pin];
  if(e.slice&&part==='data')bits=bits?.slice(e.slice.lsb,e.slice.msb+1);
  if(bits?.some(b=>b==='x'||b==='z'))return undefined;return bits;
 };
 for(const link of model.connections){
  if(!mapped.has(link.from.moduleId)&&!mapped.has(link.to.moduleId))continue;
  const port=model.modules.find(m=>m.id===link.from.moduleId)?.interfaces.find(p=>p.id===link.from.interfaceId);
  for(const part of (port?.protocol==='rv'?['data','valid','ready']:['data']) as ('data'|'valid'|'ready')[]){
   const a=endpointBits(link.from,link.scope,part),b=endpointBits(link.to,link.scope,part);
   if(!a||!b)unknown('connection.'+link.id+'.'+part,'未映射、跨非相邻层级、数组或局部逻辑需进一步核对');else add('connection.'+link.id+'.'+part,a,b,'同一 RTL 作用域的逐位连接（保留位序）');
  }
 }
 for(const m of model.modules.filter(m=>mapped.has(m.id)&&m.parent&&mapped.has(m.parent))){
  const child=mapped.get(m.id)!,parent=mapped.get(m.parent!)!,s=instance(parent.instancePath);
  for(const kind of ['clock','reset'] as const){if(!m[kind]||m[kind]!==model.modules.find(n=>n.id===m.parent)?.[kind])continue;
   const cp=child[kind],pp=parent[kind];const direct=JSON.stringify(child.instancePath.slice(0,-1))===JSON.stringify(parent.instancePath);
   const a=pp?s?.def.ports[pp]?.bits:undefined,b=cp&&direct?s?.def.cells[child.instancePath.at(-1)!]?.connections[cp]:undefined;
   if(a&&b)add(m.id+'.'+kind+'.continuity',a,b,'相同声明域的父子控制线');else unknown(m.id+'.'+kind+'.continuity','缺少可比较的同域控制线映射');
  }
 }
 return {items,scope:{mappedModules:[...mapped.keys()],unmappedModules:model.modules.filter(m=>!mapped.has(m.id)).map(m=>m.id)},note:'仅比较显式映射的模块边界、参数、端口与直接连接。内部逻辑、数值行为、时序、CDC/RDC 和等价性均未证明。'};
}
export async function evaluateConformance(workspace:string,input:unknown){
 const manifest=conformanceSchema.parse(input),model=modelSchema.parse(JSON.parse((await inputFile(workspace,'architecture/model.json')).bytes.toString())),hash=modelHash(model),runs=await verificationRuns(workspace,hash),run=runs.find(r=>r.id===manifest.runId);
 const record=JSON.parse((await inputFile(workspace,`evidence/runs/${manifest.runId}/run.json`)).bytes.toString());
 const artifact=record.artifacts?.find((a:{file:string})=>a.file===manifest.netlist),net=await inputFile(await workspacePath(workspace,`evidence/runs/${manifest.runId}`),manifest.netlist);
 const trusted=run?.fresh&&run.status==='passed'&&run.stage==='elaboration'&&run.inputClosure==='declared_complete'&&run.toolVersionsKnown&&artifact?.sha256===net.sha256;
 const comparison=compareStructure(model,manifest,JSON.parse(net.bytes.toString())),status=!trusted?'UNKNOWN':comparison.items.some(i=>i.status==='MISMATCH')?'MISMATCH':comparison.items.some(i=>i.status==='UNKNOWN')?'UNKNOWN':'MATCH';
 return {schemaVersion:1,modelHash:hash,manifest,producerRun:manifest.runId,producerFresh:!!trusted,producerInputsCurrent:!!run?.fresh,status,...comparison,producerReason:trusted?'声明完整输入、工具版本及网表摘要与当前模型匹配':'生产记录不完整、过期、未通过或未声明完整输入；观察结果不能作为当前一致性结论'};
}
export async function runConformance(workspace:string,input:unknown){
 const result=await evaluateConformance(workspace,input);await mkdir(join(workspace,'evidence'),{recursive:true});await workspacePath(workspace,'evidence');await mkdir(join(workspace,'evidence/conformance'),{recursive:true});await workspacePath(workspace,'evidence/conformance');
 const id=`conform_${Date.now()}_${randomUUID().replaceAll('-','')}`,dir=await newArtifactDirectory(workspace,join(workspace,'evidence/conformance',id));await writeFile(join(dir,'report.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});return {...result,record:`evidence/conformance/${id}/report.json`};
}
