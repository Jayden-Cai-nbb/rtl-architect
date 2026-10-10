import type {Endpoint, Link, Model} from './schema';
import {endpointKey,resolveEndpoint,scopeEndpoints} from './endpoints';
import {endpointInstances,expandLink,localSignalAnalysis} from './signals';
export type BitRange={lsb:number;msb:number};
export function bitCoverage(width:number,ranges:BitRange[]){
 let high=-1,covered=0,overlap=false;const missing:BitRange[]=[];
 for(const r of [...ranges].sort((a,b)=>a.lsb-b.lsb)){
  if(r.lsb<=high)overlap=true;
  if(r.lsb>high+1)missing.push({lsb:high+1,msb:r.lsb-1});
  covered+=Math.max(0,r.msb-Math.max(high,r.lsb-1));high=Math.max(high,r.msb);
 }
 if(high<width-1)missing.push({lsb:high+1,msb:width-1});
 return {covered,missing,overlap};
}
export function connectionFacts(model:Model){
 const links:Link[]=[],errors:{id:string;message:string;kind:'array'|'local'}[]=[];
 const ranges=new Map<string,BitRange[]>();
 const touch=(scope:string,e:Endpoint)=>{
  const r=resolveEndpoint(model,scope,e);if(!r?.fullWidth)return;
  const key=endpointKey(scope,e),entries=ranges.get(key)??[];
  entries.push(e.slice??{lsb:0,msb:r.fullWidth-1});ranges.set(key,entries);
 };
 for(const stored of model.connections){
  try{for(const link of expandLink(model,stored)){links.push(link);if(resolveEndpoint(model,link.scope,link.from)&&resolveEndpoint(model,link.scope,link.to)){touch(link.scope,link.from);touch(link.scope,link.to)}}}
  catch(e){errors.push({id:stored.id,message:String(e),kind:'array'})}
 }
 const locals=localSignalAnalysis(model,(scope,e)=>resolveEndpoint(model,scope,e));
 for(const local of model.localSignals??[]){try{for(const e of new Map(locals.local(local.id).reads.map(e=>[JSON.stringify(e),e])).values())touch(local.scope,e)}catch(e){errors.push({id:local.id,message:String(e),kind:'local'})}}
 const ports=model.modules.filter(m=>m.kind==='subsystem').flatMap(scope=>scopeEndpoints(model,scope.id).flatMap(base=>{
  let endpoints:Endpoint[];try{endpoints=endpointInstances(model,base)}catch{return []}
  return endpoints.flatMap(endpoint=>{const resolved=resolveEndpoint(model,scope.id,endpoint);if(!resolved?.fullWidth)return [];
   return [{scope:scope.id,endpoint,key:endpointKey(scope.id,endpoint),...resolved,...bitCoverage(resolved.fullWidth,ranges.get(endpointKey(scope.id,endpoint))??[])}];
  });
 }));
 return {links,ports,errors};
}
