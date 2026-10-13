import type {Model} from '../../core/schema';
import type {DiagramOptions,ScopeDiagram,Positions} from './scopeDiagram';
type Result={graph:ScopeDiagram;positions?:Positions};
// A cache entry owns immutable geometry. Selection/hover never enter its key.
export class DiagramClient {
 private cache=new Map<string,Result>();
 private pending?:{worker:Worker;reject:(e:Error)=>void};
 private sequence=0;
 cancel(){if(this.pending){this.pending.worker.terminate();this.pending.reject(new Error('DIAGRAM_CANCELLED'));this.pending=undefined;}}
 async run(model:Model,scope:string,hash:string,options:DiagramOptions,arrange=false):Promise<Result>{
  this.cancel();
  const key=JSON.stringify([hash,scope,options,arrange]);
  const cached=this.cache.get(key);if(cached){this.cache.delete(key);this.cache.set(key,cached);return cached;}
  const id=++this.sequence;
  return new Promise((resolve,reject)=>{
   const worker=new Worker(new URL('./diagram.worker.ts',import.meta.url),{type:'module'});
   this.pending={worker,reject};
   const finish=()=>{worker.terminate();if(this.pending?.worker===worker)this.pending=undefined;};
   worker.onerror=e=>{finish();reject(new Error(e.message||'后台绘图失败'));};
   worker.onmessage=e=>{
    if(e.data.id!==id||this.pending?.worker!==worker)return;
    finish();if(e.data.error){reject(new Error(e.data.error));return;}
    const result:Result={graph:e.data.graph,positions:e.data.positions};this.cache.set(key,result);
    if(arrange)this.cache.set(JSON.stringify([hash,scope,{...options,positions:result.positions},false]),result);
    while(this.cache.size>8)this.cache.delete(this.cache.keys().next().value!);
    resolve(result);
   };
   worker.postMessage({id,model,scope,hash,options,arrange});
  });
 }
 dispose(){this.cancel();this.cache.clear();}
}
