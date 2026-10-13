import {z} from 'zod';
import {writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {modelSchema,idSchema,type Model,type Module,type Endpoint} from '../core/schema';
import {hashValue,modelHash} from '../core/export';
import {validateModel} from '../core/engine';
import {inputFile,newArtifactDirectory} from './artifacts';
import {ToolError} from './environment';
const file=z.string().trim().min(1);
export const yosysManifestSchema=z.strictObject({schemaVersion:z.literal(1),top:file,netlist:file,files:z.array(file).min(1).max(10000),configuration:file});
const bits=z.array(z.union([z.number().int().nonnegative().safe(),z.enum(['0','1','x','z'])])).max(65536);
const attributes=z.record(z.string(),z.union([z.string(),z.number()])).default({});
const params=z.record(z.string(),z.union([z.string(),z.number()])).default({});
const port=z.object({direction:z.enum(['input','output','inout']),bits,offset:z.number().optional(),upto:z.number().optional(),signed:z.number().optional()});
const cell=z.object({type:file,parameters:params,attributes,connections:z.record(z.string(),bits),port_directions:z.record(z.string(),z.enum(['input','output','inout'])).optional()});
const definition=z.object({attributes,parameter_default_values:params,ports:z.record(z.string(),port),cells:z.record(z.string(),cell).default({}),memories:z.record(z.string(),z.unknown()).optional()});
export const netlistSchema=z.object({creator:z.string().optional(),modules:z.record(z.string(),definition)});
const safe=(name:string,prefix:string)=>idSchema.safeParse(name).success?name:`${prefix}_${hashValue(name).slice(0,20)}`;
const json=(x:unknown)=>JSON.stringify(x,null,2)+'\n';
export async function importYosys(workspace:string,input:unknown,destination:string){
 const manifest=yosysManifestSchema.parse(input);
 if(new Set(manifest.files).size!==manifest.files.length)throw new ToolError('INPUT_DUPLICATE','源码清单含重复文件');
 const inputs=await Promise.all([...new Set([manifest.netlist,...manifest.files])].map(f=>inputFile(workspace,f)));
 const net=netlistSchema.parse(JSON.parse(inputs.find(f=>f.file===manifest.netlist)!.bytes.toString('utf8')));
 if(!Object.hasOwn(net.modules,manifest.top))throw new ToolError('TOP_NOT_FOUND',`展开 JSON 中没有顶层 ${manifest.top}`);
 const sourceDigest=hashValue({manifest,files:inputs.map(({file,sha256})=>({file,sha256}))});
 const model:Model={schemaVersion:3,design:{id:safe(manifest.top,'design'),name:manifest.top,top:'top'},clocks:[],resets:[],modules:[],connections:[],localSignals:[],provenance:{origin:'as_built',fidelity:'partial',scope:'Yosys 展开层级、端口与可确认的直接连线；行为、时序和内部运算未还原',configuration:manifest.configuration,sourceDigest,coverage:{elaboratedInstances:null,representedInstances:1},evidence:inputs.map((f,i)=>({id:`source_${i}`,file:f.file,fileHash:f.sha256,sourceKind:f.file===manifest.netlist?'report':'code',targets:[]})),findings:[],unsupportedStructures:[],verification:[]}};
 const mapping:{moduleId:string;instancePath:string;rtlType:string;sourceFiles:string[];ports:{id:string;rtlName:string;offset:number;upto:boolean;signed:boolean}[]}[]=[];
 const gap=(moduleId:string,kind:string,description:string)=>model.provenance!.unsupportedStructures.push({id:`gap_${model.provenance!.unsupportedStructures.length}`,kind,moduleIds:[moduleId],description,evidenceIds:[model.provenance!.evidence.find(e=>e.file===manifest.netlist)!.id],category:'not_imported'});
 const evidenceByFile=new Map(model.provenance!.evidence.map(e=>[e.file,e]));
 const sources=(src:unknown)=>typeof src==='string'?manifest.files.filter(f=>src.split('|').some(part=>part.startsWith(f+':')||part.startsWith(resolve(workspace,f)+':'))):[];
 const parameter=(v:string|number)=>{if(typeof v==='number')return Number.isSafeInteger(v)?v:String(v);if(/^[01]+$/.test(v)){return `0b${v}`;}return v;};
 type Bit=number|string;type Pin={endpoint:Endpoint;bit:number};
 const build=(type:string,path:string,parent:string|null,parameters:Record<string,string|number>,sourceAttr:unknown,stack:string[]):Module=>{
  if(stack.includes(type))throw new ToolError('RECURSIVE_HIERARCHY','展开 JSON 含递归模块定义');
  if(model.modules.length>=4096)throw new ToolError('IMPORT_LIMIT','本适配器最多表示 4096 个层级实例；请限定顶层或分区导入');
  const def=net.modules[type],id=parent?`m_${hashValue(path).slice(0,20)}`:'top';
  const childCells=Object.entries(def.cells).filter(([,c])=>Object.hasOwn(net.modules,c.type));
  const n:Module={id,name:path,parent,kind:childCells.length||parent===null?'subsystem':'module',rtlModule:safe(type,'rtl'),clock:null,reset:null,timing:'unknown',parameters:Object.fromEntries(Object.entries({...def.parameter_default_values,...parameters}).map(([k,v])=>[safe(k,'param'),parameter(v)])),interfaces:[],contract:{responsibility:`从展开结果导入 ${path}（${type}）；具体职责待源码核对。`,latencyMinCycles:0,latencyCondition:'实际延迟未知；0 仅是保守下界，不表示零拍。',backpressure:'尚未核对接受条件与背压行为。',resetBehavior:'尚未核对时钟与复位。',invariants:[],verificationPlan:[],openQuestions:['核对职责、时序和行为后再生成设计提案。']}};
  model.modules.push(n);
  const files=[...new Set([...sources(def.attributes.src),...sources(sourceAttr)])];
  mapping.push({moduleId:id,instancePath:path,rtlType:type,sourceFiles:files,ports:[]});
  for(const f of files)evidenceByFile.get(f)!.targets!.push({kind:'module',moduleId:id});
  for(const [name,p] of Object.entries(def.ports)){
   if(p.direction==='inout'||!p.bits.length){gap(id,'port',`${name} 为双向或零宽端口，未假造单向接口。`);continue;}
   const portId=safe(name,'port');n.interfaces.push({id:portId,role:p.direction==='input'?'consumer':'producer',protocol:'signal',width:p.bits.length,required:true});
   mapping.at(-1)!.ports.push({id:portId,rtlName:name,offset:p.offset??0,upto:!!p.upto,signed:!!p.signed});
  }
  const children=new Map<string,Module>();
  for(const [name,c] of childCells)children.set(name,build(c.type,`${path}.${name}`,id,c.parameters,c.attributes.src,[...stack,type]));
  const internal=Object.entries(def.cells).filter(([,c])=>!Object.hasOwn(net.modules,c.type)&&c.type!=='$scopeinfo');
  if(internal.length)gap(id,'internal_logic',`${internal.length} 个内部运算/寄存单元未还原：${[...new Set(internal.map(([,c])=>c.type))].slice(0,12).join(', ')}。`);
  if(Object.keys(def.memories??{}).length)gap(id,'memory','内部存储的端口与周期行为尚未还原。');
  if(!files.length)gap(id,'source_mapping','展开对象没有匹配显式源码清单的 src 属性；源文件变更时影响范围将保守扩大。');
  // Leaf behavior is intentionally opaque. Only hierarchy scopes get physical port links.
  if(n.kind!=='subsystem')return n;
  const drivers=new Map<Bit,Pin[]>(),sinks:{wire:Bit;pin:Pin}[]=[];
  const add=(wire:Bit,pin:Pin,driver:boolean)=>{if(driver)drivers.set(wire,[...drivers.get(wire)??[],pin]);else sinks.push({wire,pin});};
  for(const [name,p] of Object.entries(def.ports))if(p.direction!=='inout')p.bits.forEach((wire,bit)=>add(wire,{endpoint:{moduleId:id,interfaceId:safe(name,'port')},bit},p.direction==='input'));
  for(const [name,c] of childCells){const child=children.get(name)!;for(const [name,wires] of Object.entries(c.connections)){
   const p=child.interfaces.find(p=>p.id===safe(name,'port'));if(!p)continue;
   if(wires.length!==p.width){gap(id,'port_width',`${child.name}.${name} 的连接宽度不匹配，未导入该端口连接。`);continue;}
   wires.forEach((wire,bit)=>add(wire,{endpoint:{moduleId:child.id,interfaceId:p.id},bit},p.role==='producer'));
  }}
  // Internal logic outputs can be drivers too: count them to avoid hiding contention.
  const hiddenDrivers=new Set<Bit>();
  for(const p of Object.values(def.ports))if(p.direction==='inout')for(const wire of p.bits)hiddenDrivers.add(wire);
  for(const [,c] of childCells)for(const [name,p] of Object.entries(net.modules[c.type].ports))if(p.direction==='inout')for(const wire of c.connections[name]??[])hiddenDrivers.add(wire);
  for(const [,c] of internal)for(const [name,wires] of Object.entries(c.connections))if(!c.port_directions||c.port_directions[name]==='output'||c.port_directions[name]==='inout')for(const w of wires)hiddenDrivers.add(w);
  const runs:{from:Pin;to:Pin;width:number}[]=[];let ambiguous=0,unknown=0;
  for(const {wire,pin} of sinks){
   let ds=drivers.get(wire)??[];
   if(wire==='0'||wire==='1'){
    const localId=`constant_${id}_${wire}`;if(!model.localSignals!.some(l=>l.id===localId))model.localSignals!.push({id:localId,scope:id,name:`常量 ${wire}`,width:1,description:'Yosys bit-vector 中明确的常量位',driver:{kind:'comb',value:{kind:'constant',width:1,value:wire}},evidenceIds:[model.provenance!.evidence.find(e=>e.file===manifest.netlist)!.id]});
    ds=[{endpoint:{moduleId:id,interfaceId:localId,local:true},bit:0}];
   }
   if(wire==='x'||wire==='z'){unknown++;continue;}
   if(ds.length!==1||hiddenDrivers.has(wire)){if(ds.length>1||ds.length&&hiddenDrivers.has(wire))ambiguous++;else unknown++;continue;}
   const from=ds[0];
   // Parent input -> parent output aliases require an explicit local driver in the IR.
   let source=from;
   if(from.endpoint.moduleId===id&&!from.endpoint.local&&pin.endpoint.moduleId===id){
    const alias=`alias_${id}_${from.endpoint.interfaceId}_${from.bit}`;
    if(!model.localSignals!.some(l=>l.id===alias))model.localSignals!.push({id:alias,scope:id,name:`${from.endpoint.interfaceId}[${from.bit}]`,width:1,description:'展开网表中的直接别名，不代表新增 RTL 实例',driver:{kind:'comb',value:{kind:'endpoint',endpoint:{...from.endpoint,slice:{lsb:from.bit,msb:from.bit}}}},evidenceIds:[]});
    source={endpoint:{moduleId:id,interfaceId:alias,local:true},bit:0};
   }
   const last=runs.at(-1);
   if(last&&JSON.stringify(last.from.endpoint)===JSON.stringify(source.endpoint)&&JSON.stringify(last.to.endpoint)===JSON.stringify(pin.endpoint)&&source.bit===last.from.bit+last.width&&pin.bit===last.to.bit+last.width)last.width++;
   else runs.push({from:source,to:pin,width:1});
  }
  if(ambiguous)gap(id,'multiple_driver',`${ambiguous} 个目标位存在多个或隐藏驱动，未选择任意驱动冒充确定连接。`);
  if(unknown)gap(id,'unresolved_connection',`${unknown} 个目标位由内部逻辑、未知值或未表示驱动产生，保持为模型缺口。`);
  for(const r of runs){const from={...r.from.endpoint,slice:{lsb:r.from.bit,msb:r.from.bit+r.width-1}},to={...r.to.endpoint,slice:{lsb:r.to.bit,msb:r.to.bit+r.width-1}};model.connections.push({id:`c_${hashValue({scope:id,from,to}).slice(0,24)}`,scope:id,from,to});}
  return n;
 };
 build(manifest.top,manifest.top,null,{},undefined,[]);
 model.provenance!.coverage.representedInstances=model.modules.length;
 model.provenance!.findings.push({id:'import_scope',classification:'unknown',moduleIds:['top'],text:'导入的是已存在的 Yosys JSON；尚未证明它由当前源码和配置生成。实例覆盖仅针对已导入层级，不包含未还原内部单元。',evidenceIds:[model.provenance!.evidence.find(e=>e.file===manifest.netlist)!.id]});
 const parsed=modelSchema.parse(model),issues=validateModel(parsed);if(issues.some(i=>i.blocks.includes('commit')))throw new ToolError('IMPORT_INVALID','导入模型存在结构错误，未输出可提交候选',issues);
 const report={schemaVersion:1 as const,format:'yosys-json' as const,modelHash:modelHash(parsed),sourceDigest,manifest,creator:net.creator??'unknown',inputs:inputs.map(({file,sha256})=>({file,sha256})),mapping,note:'仅对应本次展开输入；未表示结构及未知行为保留 partial。端口位域使用归一化低位索引，原 HDL offset/upto/signed 保存在映射中。'};
 const output=await newArtifactDirectory(workspace,destination);
 await Promise.all([writeFile(join(output,'model.json'),json(parsed)),writeFile(join(output,'import.json'),json(report))]);
 return {directory:output,modelFile:join(output,'model.json'),reportFile:join(output,'import.json'),modelHash:report.modelHash,modules:model.modules.length,connections:model.connections.length,gaps:model.provenance!.unsupportedStructures.length,issues,committed:false};
}
const reportSchema=z.object({schemaVersion:z.literal(1),format:z.literal('yosys-json'),modelHash:z.string(),manifest:yosysManifestSchema,inputs:z.array(z.object({file:z.string(),sha256:z.string()})),mapping:z.array(z.object({moduleId:z.string(),sourceFiles:z.array(z.string())}))});
export async function importImpact(workspace:string,input:unknown){
 const report=reportSchema.parse(input),changed: {file:string;state:string}[]=[];
 for(const expected of report.inputs){try{const actual=await inputFile(workspace,expected.file);if(actual.sha256!==expected.sha256)changed.push({file:expected.file,state:'changed'});}catch(e){changed.push({file:expected.file,state:(e as {code?:string}).code??'unavailable'});}}
 const unknownMapping=report.mapping.filter(m=>!m.sourceFiles.length),netlistChanged=changed.some(c=>c.file===report.manifest.netlist);
 const directlyAffected=report.mapping.filter(m=>m.sourceFiles.some(f=>changed.some(c=>c.file===f))).map(m=>m.moduleId);
 const unmappedChanges=changed.some(c=>c.file!==report.manifest.netlist&&!report.mapping.some(m=>m.sourceFiles.includes(c.file)));
 const affectedModuleIds=changed.length?[...new Set([...directlyAffected,...unknownMapping.map(m=>m.moduleId),...(netlistChanged||unmappedChanges?report.mapping.map(m=>m.moduleId):[])])]:[];
 return {baselineModelHash:report.modelHash,changedFiles:changed,affectedModuleIds,unaffectedModuleIds:report.mapping.filter(m=>!affectedModuleIds.includes(m.moduleId)).map(m=>m.moduleId),requiresReelaboration:!!changed.length,note:'这是源码映射给出的重新核对范围，不是语义差异证明。宏/include/配置或展开输入变化应重新展开，再比较新旧候选；未改变的实例不应重新手工录入。'};
}
