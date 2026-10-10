import type {Model, Module, Interface, Endpoint} from './schema';
import {widthValue} from './parameters';
export const childrenOf = (model: Model, id: string) => model.modules.filter(m => m.parent === id);
export function resolveWidth(module: Module, intf: Interface, model?:Model, index?:number): number | undefined {
  try { return widthValue(model??({modules:[module]} as Model),module,intf.width,index??module.instances?.from); } catch { return undefined; }
}
export function resolveEndpoint(model: Model, scope: string, endpoint: Endpoint) {
  if(endpoint.sliceMapping)return undefined;
  const owner = model.modules.find(m => m.id === scope);
  const module = model.modules.find(m => m.id === endpoint.moduleId);
  const local=endpoint.local?model.localSignals?.find(n=>n.id===endpoint.interfaceId&&n.scope===scope):undefined;
  const intf:Interface|undefined=endpoint.local?(local?{id:local.id,role:'producer',protocol:'signal',width:local.width,required:false}:undefined):module?.interfaces.find(i => i.id === endpoint.interfaceId);
  if (!owner || owner.kind !== 'subsystem' || !module || !intf || (endpoint.local&&module.id!==scope) || (module.id !== scope && module.parent !== scope)) return undefined;
  if(endpoint.index!==undefined&&!module.instances)return undefined;
  if(typeof endpoint.index==='number'&&module.instances&&(endpoint.index<module.instances.from||endpoint.index>module.instances.to))return undefined;
  const direction = endpoint.local?'source':(module.id === scope ? intf.role === 'consumer' : intf.role === 'producer') ? 'source' : 'target';
  const fullWidth=resolveWidth(module,intf,model,typeof endpoint.index==='number'?endpoint.index:undefined);
  if(endpoint.slice&&(intf.protocol!=='signal'||fullWidth===undefined||endpoint.slice.msb<endpoint.slice.lsb||endpoint.slice.msb>=fullWidth))return undefined;
  return { module, intf, direction, fullWidth, width: endpoint.slice?endpoint.slice.msb-endpoint.slice.lsb+1:fullWidth };
}
export function scopeEndpoints(model: Model, scope: string) {
  return model.modules.filter(m => m.id === scope || m.parent === scope).flatMap(m => m.interfaces.map(i => ({ moduleId: m.id, interfaceId: i.id, ...(m.instances?{index:'all' as const}:{}) })));
}
export const endpointKey = (scope: string, e: Endpoint) => `${scope}/${e.moduleId}/${e.local?'local:':''}${e.interfaceId}${e.index!==undefined?`[${e.index}]`:''}`;
