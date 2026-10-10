import type {Model,Review} from './schema';
import {hashValue} from './export';

/** Explicit contract boundary: own subtree, adjacent contracts, ancestor environment and globals.
 * Legacy confirmations have no dependency proof and retain whole-model invalidation.
 */
export function reviewDependencies(model:Model,id:string){
 const own=new Set([id]);let added=true;
 while(added){added=false;for(const m of model.modules)if(m.parent&&own.has(m.parent)&&!own.has(m.id)){own.add(m.id);added=true;}}
 const links=model.connections.filter(l=>own.has(l.scope)||own.has(l.from.moduleId)||own.has(l.to.moduleId));
 const peers=new Set(links.flatMap(l=>[l.from.moduleId,l.to.moduleId]).filter(p=>!own.has(p)));
 const ancestors=new Set<string>();let parent=model.modules.find(m=>m.id===id)?.parent;
 while(parent&&!ancestors.has(parent)){ancestors.add(parent);parent=model.modules.find(m=>m.id===parent)?.parent;}
 const parts:Record<string,string>={};
 for(const m of model.modules)if(own.has(m.id))parts[`module:${m.id}`]=hashValue({...m,interfaces:[...m.interfaces].sort((a,b)=>a.id.localeCompare(b.id))});
 else if(peers.has(m.id)||ancestors.has(m.id)){
  const {name,parent, ...contract}=m;void name;void parent;
  parts[`${ancestors.has(m.id)?'environment':'neighbor'}:${m.id}`]=hashValue({...contract,interfaces:[...m.interfaces].sort((a,b)=>a.id.localeCompare(b.id))});
 }
 for(const l of links)parts[`connection:${l.id}`]=hashValue(l);
 const localScopes=new Set([...own,...links.map(l=>l.scope)]);
 for(const l of model.localSignals??[])if(localScopes.has(l.scope))parts[`local:${l.id}`]=hashValue(l);
 parts['global:clock_reset']=hashValue({clocks:model.clocks,resets:model.resets});
 // Unknown evidence scope remains conservative; never silently ignore changed provenance.
 parts['global:provenance']=hashValue(model.provenance??null);
 const relevant=(ids:string[])=>!ids.length||ids.some(m=>own.has(m)||ancestors.has(m)||peers.has(m));
 parts['global:specification']=hashValue(model.specification?{summary:model.specification.summary,openQuestions:model.specification.openQuestions,requirements:model.specification.requirements.filter(r=>relevant(r.moduleIds)),decisions:model.specification.decisions.filter(d=>relevant(d.moduleIds))}:null);
 return {scopeHash:hashValue(parts),scopeParts:parts};
}
export function reviewImpact(record:Review|null,current:ReturnType<typeof reviewDependencies>,hash:string){
 if(!record)return {retained:false,reasons:['尚未确认']};
 if(record.modelHash===hash)return {retained:false,reasons:[]};
 if(!record.scopeHash||!record.scopeParts)return {retained:false,reasons:['旧确认未记录依赖范围，需要按当前版本复核']};
 if(record.scopeHash===current.scopeHash)return {retained:true,reasons:[]};
 const changed=[...new Set([...Object.keys(record.scopeParts),...Object.keys(current.scopeParts)])].filter(k=>record.scopeParts![k]!==current.scopeParts[k]);
 const labels:Record<string,string>={module:'模块职责、接口或行为',environment:'父层参数、接口或合同',neighbor:'相邻模块合同',connection:'连接',local:'内部驱动',global:'全局约束或证据'};
 return {retained:false,reasons:changed.map(k=>`${labels[k.split(':')[0]]??'依赖'}：${k.slice(k.indexOf(':')+1)}`)};
}
