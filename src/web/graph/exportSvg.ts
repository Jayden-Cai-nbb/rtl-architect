import type {Model} from '../../core/schema';
import {scopeDiagram,diagramColors,type DiagramOptions} from './scopeDiagram';
import {portDetailZoom} from './ports';
import {relationshipRoute} from './route';
import {excerpt,kindLabel} from '../reading';
const xml=(value:unknown)=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
const wrapped=(value:string,limit:number)=>{const rows:string[]=[];let line='',size=0;for(const char of value){const step=char.charCodeAt(0)>255?1:0.55;if(size+step>limit){rows.push(line);line='';size=0;}line+=char;size+=step;}if(line)rows.push(line);return rows;};
const clampedRows=(value:string,limit:number,max:number)=>{const all=wrapped(value,limit),rows=all.slice(0,max);if(all.length>max)rows[max-1]=rows[max-1].slice(0,-1)+'…';return rows;};
/** Export the same scope geometry and links; never synthesize architectural facts. */
export function diagramSvg(model:Model,scope:string,options:DiagramOptions={},hash='',prepared?:ReturnType<typeof scopeDiagram>){
 const graph=prepared??scopeDiagram(model,scope,options),frame=graph.frame,owner=model.modules.find(m=>m.id===scope)!;
 const x=frame.position.x-24,y=frame.position.y-82,w=frame.width+48,h=frame.height+162;
 const text=(x:number,y:number,value:unknown,size=13,fill='#29465a')=>`<text x="${x}" y="${y}" font-size="${size}" fill="${fill}">${xml(value)}</text>`;
 const out=[`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${Math.ceil(w)}" height="${Math.ceil(h)}" role="img" class="${options.showPortNames?'show-port-names':''}" data-port-detail-zoom="${portDetailZoom}" data-model-hash="${xml(hash)}" data-view-mode="${xml(graph.mode)}" data-scope="${xml(scope)}" aria-label="${xml(owner.name)}结构图"><title>${xml(owner.name)} · RTL 结构图</title><desc>${xml(owner.contract.responsibility)}。${model.provenance?.fidelity==='partial'?'模型尚未完整。':''}</desc><defs><marker id="arrow-dependency" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="#64758b" stroke-width="1.5"/></marker>${Object.entries(diagramColors).map(([name,color])=>`<marker id="arrow-${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${color}"/></marker>`).join('')}</defs><style>.port-details{display:none}.show-port-names .port-details{display:inline}</style><g font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#fff"/>`,text(x+24,y+32,owner.name,21),text(x+24,y+55,`${model.provenance?.fidelity==='partial'?'尚未完整 · ':''}${graph.modeLabel} · ${graph.inspection.stored.length} 条已记录连接 · ${hash.slice(0,12)}`,12)];
 out.push(`<rect x="${frame.position.x}" y="${frame.position.y}" width="${frame.width}" height="${frame.height}" rx="0" fill="#fff" stroke="#dce3e8"/>`);
 for(const n of graph.nodes.filter(n=>n.data.kind==='region'))out.push(`<g data-reading-stage="${xml(n.id)}"><rect x="${n.position.x}" y="${n.position.y}" width="${n.data.geometry.width}" height="${n.data.geometry.height}" rx="8" fill="#f5f9fb" stroke="#dfe8ec"/>${text(n.position.x+16,n.position.y+25,n.data.label,15)}${text(n.position.x+16,n.position.y+43,n.data.summary,11)}</g>`);
 const labels:string[]=[];
 for(const edge of graph.edges){
  const source=graph.nodes.find(n=>n.id===edge.source)!,target=graph.nodes.find(n=>n.id===edge.target)!;
  const sp=source.data.geometry.ports.find(p=>p.id===edge.sourceHandle)!,tp=target.data.geometry.ports.find(p=>p.id===edge.targetHandle)!;
  const route=relationshipRoute(source.position.x+sp.x,source.position.y+sp.y,target.position.x+tp.x,target.position.y+tp.y,edge.data);
  for(const p of (edge.data?.crossings as {x:number;y:number}[]??[]))out.push(`<circle cx="${p.x}" cy="${p.y}" r="3.5" fill="#fff"/>`);
  out.push(`<path data-edge-id="${xml(edge.id)}" data-source="${xml(edge.source)}" data-target="${xml(edge.target)}" d="${route.path}" fill="none" stroke="${xml(edge.data?.color??'#64758b')}" stroke-width="${Number(edge.style?.strokeWidth??1.8)}"${edge.style?.strokeDasharray?' stroke-dasharray="4 4"':''} marker-end="url(#arrow-${xml(edge.data?.semanticKind==='dependency'?'dependency':edge.data?.category??'other')})"><title>${xml(String(edge.label)+'：'+source.data.label+' → '+target.data.label+'\n'+((edge.data?.connectionIds as string[])??[]).join('\n')+'\n'+String(edge.data?.title??''))}</title></path>`);
  const leader=edge.data?.labelLeader as {x1:number;y1:number;x2:number;y2:number}|undefined;if(leader&&!edge.data?.labelHidden&&!edge.data?.labelSharedWith)out.push(`<line x1="${leader.x1}" y1="${leader.y1}" x2="${leader.x2}" y2="${leader.y2}" stroke="${xml(edge.data?.color??'#64758b')}" stroke-width="1"/>`);
  if(edge.label&&!edge.data?.labelHidden&&!edge.data?.labelSharedWith)labels.push(`<text x="${route.x}" y="${route.y}" dominant-baseline="central" text-anchor="middle" data-wire-label="${xml(edge.id)}" font-size="16" fill="#29465a" stroke="#fff" stroke-width="5" paint-order="stroke">${xml(edge.label)}</text>`);
 }
 for(const p of (graph.edges.at(-1)?.data?.junctions as {x:number;y:number;color:string}[]??[]))out.push(`<circle cx="${p.x}" cy="${p.y}" r="2.6" fill="${p.color}"/>`);
 out.push(...labels);
 for(const n of graph.nodes.filter(n=>!['frame','region'].includes(n.data.kind))){
  const {x,y}=n.position,g=n.data.geometry;
  out.push(`<g data-node-id="${xml(n.id)}"><title>${xml(String(n.data.title??n.data.label)+'\n'+(model.modules.find(m=>m.id===n.data.moduleId)?.contract.responsibility??n.data.summary))}</title><rect x="${x}" y="${y}" width="${g.width}" height="${g.height}" rx="3" fill="${n.data.kind==='rack'?'#f7f9fb':n.data.kind==='state'?'#f3f8f2':n.data.kind==='memory'?'#fffaf0':n.data.kind==='controller'?'#f1f5fa':n.data.kind==='subsystem'?'#f0f8f7':'#fff'}" stroke="${n.data.localId?'#859977':'#9fb8ca'}"/>`);
  if(n.data.kind==='rack'){
   out.push(text(x+14,y+25,n.data.label,14));
   (n.data.groups as {label:string;count:number}[]).forEach((group,i)=>out.push(text(x+14,y+70+i*44,excerpt(group.label,9),14),text(x+133,y+70+i*44,group.count>1?group.count:'',11)));
  }else{
   out.push(text(x+16,y+(g.captionY??24),`${n.data.statePattern??kindLabel[n.data.kind]??n.data.kind}${Number(n.data.instanceCount)>1?' ×'+n.data.instanceCount:''}`,11,'#667a89'));
   clampedRows(n.data.label,(g.width-32)/18,2).forEach((line,i)=>out.push(text(x+16,y+(g.captionY??24)+25+i*23,line,18)));

  }
  const active=new Set(graph.edges.flatMap(e=>e.source===n.id?[e.sourceHandle]:e.target===n.id?[e.targetHandle]:[]));
  if(!n.data.boundary){out.push('<g class="port-details" font-family="ui-monospace, monospace" font-size="12">');for(const p of g.ports.filter(p=>active.has(p.id)&&p.label))out.push(`<text data-port-id="${xml(p.id)}" data-port-direction="${p.direction}" x="${x+p.labelX!}" y="${y+p.labelY!}" text-anchor="${p.textAnchor}" fill="${diagramColors[p.category??'other']}"><title>${xml((p.direction==='target'?'输入':'输出')+'：'+p.interfaceIds?.join(', '))}</title>${xml(p.label)}</text>`);out.push('</g>');}
  for(const p of g.ports.filter(p=>active.has(p.id)))out.push(`<circle cx="${x+p.x}" cy="${y+p.y}" r="2" fill="#718da2"/>`);
  out.push('</g>');
 }
 out.push(text(x+24,y+h-38,`时钟 / 配置折叠 ${graph.auxiliaryCount} 条 · 内部逻辑折叠 ${graph.foldedLocalCount} 条 · 依赖折叠 ${graph.foldedDependencyCount} 条${graph.edges.some(e=>e.data?.routingFallback)?' · 部分连线未找到绕行路径':''}`,12),text(x+24,y+h-18,'实心点表示同源分叉，可共用线名；留白交叉不相连。实心箭头为连接、空心箭头为依赖；RV 的 data/valid 正向、ready 反向。输入集合未分角色，更新规则为声明；位置不表示周期。',11),'</g></svg>');
 return out.join('\n');
}
