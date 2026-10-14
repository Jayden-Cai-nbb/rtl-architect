import type {Model,Endpoint,SignalValue} from './schema';
import {interfaceGroup,linkGroup} from './inspection';
import {resolveEndpoint} from './endpoints';
import {endpointLabel,signalReads} from './signals';
export type ViewMode='architecture'|'microarchitecture'|'signals';
export const viewNames:Record<ViewMode,string>={architecture:'架构通路',microarchitecture:'内部状态与运算',signals:'原始连接'};
export type SemanticFinding={code:string;target:string;reason:string};
/** Read-only projection. A protocol declaration is not execution or RTL verification evidence. */
export function hardwareView(model:Model,scope:string){
 const modules=new Map(model.modules.map(m=>[m.id,m])),issues:SemanticFinding[]=[];
 const relationships=model.connections.filter(l=>l.scope===scope).map(link=>{
  const a=interfaceGroup(model,link.from),b=interfaceGroup(model,link.to),group=linkGroup(model,link);
  const from=modules.get(link.from.moduleId)?.interfaces.find(p=>!link.from.local&&p.id===link.from.interfaceId),to=modules.get(link.to.moduleId)?.interfaces.find(p=>!link.to.local&&p.id===link.to.interfaceId);
  const conflict=a.category!=='other'&&b.category!=='other'&&a.category!==b.category;
  if(conflict)issues.push({code:'GROUP_CONFLICT',target:link.id,reason:`两端分类不一致：${a.label} (${a.category}) / ${b.label} (${b.category})；未选择其中一端冒充确定用途。`});
  const rv=from?.protocol==='rv'&&to?.protocol==='rv',width=resolveEndpoint(model,scope,link.from)?.width;
  if((from?.protocol==='rv')!==(to?.protocol==='rv'))issues.push({code:'PROTOCOL_CONFLICT',target:link.id,reason:'RV 协议两端不匹配；不能画成已确认的逻辑通道。'});
  if(!rv&&!conflict&&group.category==='other')issues.push({code:'UNCLASSIFIED_CONNECTION',target:link.id,reason:'未声明业务用途，保留原接口身份；不能据此推断数据、使能或协议关系。'});
  const evidenceIds=model.provenance?.evidence.filter(e=>e.targets?.some(t=>t.kind==='connection'&&t.itemId===link.id)).map(e=>e.id)??[];
  return {id:link.id,from:link.from,to:link.to,fromRole:from?.role,toRole:to?.role,kind:rv?'ready_valid' as const:'wire' as const,classification:conflict||(from?.protocol==='rv')!==(to?.protocol==='rv')?'conflict' as const:'declared' as const,group,width,evidenceIds,
   members:rv?[{part:'data',direction:'forward',width},{part:'valid',direction:'forward',width:1},{part:'ready',direction:'backward',width:1}]:[{part:link.from.interfaceId,direction:'forward',width}],
   meaning:rv?'模型声明的 RV 通道：data/valid 正向，ready 反向；成员引脚名与实际行为需通过 RTL 映射和核验确认。':'模型记录的直接连接；业务分类不代表协议成员关系。'};
 });
 for(const local of model.localSignals?.filter(s=>s.scope===scope)??[])if(local.driver.kind==='register'&&!local.driver.update)issues.push({code:'STATE_ROLE_UNKNOWN',target:`local:${scope}:${local.id}`,reason:'只记录了状态输入集合，未表达数据、使能、取消及逐位更新条件；不能当作精确数据线。'});
 if(model.provenance?.fidelity==='partial')issues.push({code:'PARTIAL_MODEL',target:scope,reason:'模型尚未完整；图中没有显示的结构不代表 RTL 中不存在。'});
 return {relationships,issues,note:'显示投影不修改 IR；位置不表示周期、真实线长或物理布局。'};
}
export type DependencyRole='select'|'operand'|'mixed'|'state_unknown'|'state_data'|'state_condition'|'state_reset'|'state_mixed';
export function dependencyRoles(local:NonNullable<Model['localSignals']>[number]):Map<string,DependencyRole>{
 const roles=new Map<string,DependencyRole>();
 const add=(e:Endpoint,role:DependencyRole)=>{const key=endpointLabel(e),old=roles.get(key);roles.set(key,old&&old!==role?(old.startsWith('state_')?'state_mixed':'mixed'):role)};
 const visit=(v:SignalValue,role:DependencyRole)=>{if(v.kind==='endpoint')add(v.endpoint,role);else if(v.kind==='cast')visit(v.value,role);else if(v.kind==='concat')v.parts.forEach(p=>visit(p,role));else if(v.kind==='operator')v.operands.forEach((p,i)=>visit(p,role==='select'||v.operator==='mux'&&i===0?'select':role));};
 if(local.driver.kind==='register'){
  const update=local.driver.update;
  if(!update)local.driver.inputs.forEach(e=>add(e,'state_unknown'));
  else {if(update.reset){add(update.reset.signal,'state_reset');signalReads(update.reset.value).forEach(e=>add(e,'state_data'));}for(const b of update.branches){signalReads(b.condition).forEach(e=>add(e,'state_condition'));signalReads(b.value).forEach(e=>add(e,'state_data'));}}
 }else visit(local.driver.value,'operand');return roles;
}
