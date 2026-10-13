import type {Model} from '../../core/schema';
import {scopeDiagram,type DiagramOptions,type Positions} from './scopeDiagram';
import {diagramQuality} from './quality';
/** One bounded spacing trial for automatic small scopes; no changes to links or topology order. */
export function refineSpacing(model:Model,scope:string,positions:Positions,options:DiagramOptions={}){
 const measured=scopeDiagram(model,scope,{...options,positions,measureOnly:true});
 if(options.reading||measured.nodes.length>26||measured.edges.length>60||!measured.edges.length)return {positions,attempts:0,accepted:false,reason:'保留显式阅读约束，或超过小图反馈预算'};
 const before=diagramQuality(scopeDiagram(model,scope,{...options,positions}));
 const score=(q:typeof before)=>[q.overlaps.length+q.nodeHits.length+q.unrouted.length,q.hiddenLabels.length,q.crossings,q.unrelatedSharedLength,q.wireLength];
 if(before.status==='passed'&&!before.hiddenLabels.length&&before.crossings<=2&&before.unrelatedSharedLength<100)return {positions,attempts:1,accepted:false,before,reason:'当前小图未触发间距试探'};
 const trial=Object.fromEntries(Object.entries(positions).map(([id,p])=>[id,{x:Math.round(p.x*1.25),y:Math.round(p.y*1.2)}]));
 const after=diagramQuality(scopeDiagram(model,scope,{...options,positions:trial})),a=score(before),b=score(after),index=a.findIndex((v,i)=>v!==b[i]);
 const accepted=after.structuralFidelity.status==='passed'&&index>=0&&b[index]<a[index];
 return {positions:accepted?trial:positions,attempts:2,accepted,before,after,reason:accepted?'本次最终走线质量改善，采用一次间距调整':'试探未改善优先质量指标，保留原布局'};
}
