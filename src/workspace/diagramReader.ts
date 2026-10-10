import type {Model} from '../core/schema';
import {scopeDiagram} from '../web/graph/scopeDiagram';
import {linkGroup} from '../core/inspection';
const html=(s:unknown)=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const endpoint=(e:Model['connections'][number]['from'])=>`${e.moduleId}${e.index!==undefined?`[${e.index}]`:''}.${e.interfaceId}${e.slice?`[${e.slice.msb}:${e.slice.lsb}]`:''}${e.sliceMapping?' '+JSON.stringify(e.sliceMapping):''}${e.local?' (内部逻辑)':''}`;
type Diagram={scope:string;name:string;file:string};
/** Offline enhancement of the SAME exported SVG, with no fetch, service, or second model. */
export function diagramReader(model:Model,diagrams:Diagram[],files:Record<string,string>,graphs:ReturnType<typeof scopeDiagram>[]){
 const metadata=graphs.map(g=>({
  nodes:g.nodes.filter(n=>n.data.kind!=='frame').map(n=>({id:n.id,name:n.data.label,ports:n.data.geometry.ports,detail:model.modules.find(m=>m.id===n.id)?.contract.responsibility??n.data.summary})),
  edges:g.edges.map(e=>({id:e.id,name:e.label,source:e.source,target:e.target,sourceHandle:e.sourceHandle,targetHandle:e.targetHandle,detail:e.data?.title,sharedWith:e.data?.labelSharedWith,links:g.inspection.stored.filter(l=>(e.data?.connectionIds as string[]??[]).includes(l.id)).map(l=>({id:l.id,name:linkGroup(model,l).label,from:endpoint(l.from),to:endpoint(l.to)}))})),
 }));
 const safe=JSON.stringify(metadata).replaceAll('<','\\u003c').replaceAll('>','\\u003e').replaceAll('&','\\u0026');
 return `<section class="diagram-reader" aria-label="架构框图"><div class="diagram-bar"><div class="scope-tabs" role="tablist" aria-label="层级">${diagrams.map((d,i)=>`<button type="button" role="tab" id="diagram-tab-${i}" aria-controls="diagram-panel-${i}" aria-selected="${i===0}" data-scope-tab="${i}">${html(d.name)}</button>`).join('')}</div><div class="diagram-actions"><button type="button" id="diagram-fit" aria-pressed="true">全图</button><button type="button" id="diagram-native" aria-pressed="false">原尺寸</button><button type="button" id="diagram-zoom-out" aria-label="缩小框图">−</button><output id="diagram-zoom" aria-label="当前缩放">全图</output><button type="button" id="diagram-zoom-in" aria-label="放大框图">＋</button><button type="button" id="diagram-focus" aria-pressed="false">专注看图</button><button type="button" id="diagram-clear">退出追踪</button></div></div>
 <p class="reader-hint">滚轮滚动，Ctrl+滚轮缩放；双击模块放大。放大后显示接口名，可点名称追踪。实心点是同源分叉，留白交叉不相连。</p>
 ${diagrams.map((d,i)=>`<div class="diagram-panel" role="tabpanel" id="diagram-panel-${i}" aria-labelledby="diagram-tab-${i}" ${i?'hidden':''}><div class="diagram-stage">${files[d.file]}</div><p class="diagram-caption"><a href="${d.file}">打开 / 保存 SVG</a> · <a href="#scope-${d.scope}">完整连接索引</a></p></div>`).join('')}
 <aside id="diagram-trace" aria-live="polite"><strong>从一笔事务开始</strong><p>选择输入相邻模块，观察它把数据交给谁；再核对存储往返、完成与取消。框图位置不代表周期。</p></aside>
 <script type="application/json" id="diagram-metadata">${safe}</script>
 <script>(()=>{
 const data=JSON.parse(document.getElementById('diagram-metadata').textContent);let current=0;
 const panels=[...document.querySelectorAll('.diagram-panel')],tabs=[...document.querySelectorAll('[data-scope-tab]')],trace=document.getElementById('diagram-trace');
 const reset=()=>{panels[current].querySelectorAll('[data-node-id],[data-edge-id],[data-wire-label]').forEach(el=>{el.style.opacity='';el.classList.remove('traced');});trace.replaceChildren();const p=document.createElement('p');p.textContent='点模块看分工，点连线查看来源、去向与真实接口。';trace.append(p);};
 tabs.forEach((tab,i)=>tab.addEventListener('click',()=>{reset();current=i;panels.forEach((p,j)=>p.hidden=j!==i);tabs.forEach((t,j)=>t.setAttribute('aria-selected',String(j===i)));reset();requestAnimationFrame(refreshZoom);}));
 const currentStage=()=>panels[current].querySelector('.diagram-stage');
 const scale=()=>{const m=currentStage().querySelector('svg').getScreenCTM();return m?Math.hypot(m.a,m.b):1;};
 const refreshZoom=()=>{const stage=currentStage();if(!stage.isConnected)return;const svg=stage.querySelector('svg'),z=scale();svg.classList.toggle('show-port-names',z>=Number(svg.dataset.portDetailZoom));document.getElementById('diagram-zoom').textContent=Math.round(z*100)+'%';document.getElementById('diagram-fit').setAttribute('aria-pressed',String(!stage.classList.contains('native')));document.getElementById('diagram-native').setAttribute('aria-pressed',String(stage.classList.contains('native')&&Math.abs(z-1)<.01));};
 const zoomTo=(next,anchor)=>{
  const stage=currentStage(),svg=stage.querySelector('svg'),box=stage.getBoundingClientRect(),old=svg.getScreenCTM();if(!old)return;
  const client=anchor||{x:box.x+box.width/2,y:box.y+box.height/2},point=new DOMPoint(client.x,client.y).matrixTransform(old.inverse()),z=Math.max(.25,Math.min(2.5,next)),v=svg.viewBox.baseVal;
  stage.classList.add('native');svg.style.width=v.width*z+'px';svg.style.height=v.height*z+'px';
  const mapped=point.matrixTransform(svg.getScreenCTM());stage.scrollLeft+=mapped.x-client.x;stage.scrollTop+=mapped.y-client.y;refreshZoom();
 };
 document.getElementById('diagram-fit').addEventListener('click',()=>{const stage=currentStage(),svg=stage.querySelector('svg');stage.classList.remove('native');svg.style.width='';svg.style.height='';stage.scrollLeft=stage.scrollTop=0;refreshZoom();});
 document.getElementById('diagram-native').addEventListener('click',()=>zoomTo(1));
 document.getElementById('diagram-zoom-in').addEventListener('click',()=>zoomTo(scale()*1.25));
 document.getElementById('diagram-zoom-out').addEventListener('click',()=>zoomTo(scale()/1.25));
 const observer=new ResizeObserver(()=>refreshZoom());panels.forEach(panel=>observer.observe(panel.querySelector('.diagram-stage')));requestAnimationFrame(refreshZoom);
 document.getElementById('diagram-clear').addEventListener('click',reset);
 const focus=document.getElementById('diagram-focus');focus.addEventListener('click',()=>{const active=document.querySelector('.diagram-reader').classList.toggle('focus');focus.setAttribute('aria-pressed',String(active));focus.textContent=active?'返回页面':'专注看图';});
 const paragraph=text=>{const p=document.createElement('p');p.textContent=text;trace.append(p);};
 panels.forEach((panel,i)=>{
  const activate=(el,portId)=>{
   if(!el)return;const node=el.getAttribute('data-node-id'),edgeId=el.getAttribute('data-edge-id')||el.getAttribute('data-wire-label'),d=data[i];
   const selected=node?d.nodes.find(n=>n.id===node):d.edges.find(e=>e.id===edgeId);if(!selected)return;
   const edges=node?d.edges.filter(e=>(e.source===node&&(!portId||e.sourceHandle===portId))||(e.target===node&&(!portId||e.targetHandle===portId))):d.edges.filter(e=>e.id===edgeId),ids=new Set(edges.map(e=>e.id)),nodes=new Set(edges.flatMap(e=>[e.source,e.target]));if(node)nodes.add(node);
   // Keep the shared fanout name readable when inspecting an individual branch.
   edges.forEach(e=>{if(e.sharedWith)ids.add(e.sharedWith);});
   panel.querySelectorAll('[data-edge-id],[data-wire-label]').forEach(e=>{const active=ids.has(e.getAttribute('data-edge-id')||e.getAttribute('data-wire-label'));e.style.opacity=active?'1':'.13';e.classList.toggle('traced',active);});
   panel.querySelectorAll('[data-node-id]').forEach(n=>n.style.opacity=nodes.has(n.getAttribute('data-node-id'))?'1':'.25');
   trace.replaceChildren();const title=document.createElement('strong');title.textContent=selected.name+(portId?' · '+(selected.ports.find(p=>p.id===portId)?.label||portId):'');trace.append(title);if(selected.detail)paragraph(selected.detail);
   for(const e of edges){paragraph((d.nodes.find(n=>n.id===e.source)?.name||e.source)+' → '+(d.nodes.find(n=>n.id===e.target)?.name||e.target)+' · '+e.name);const list=document.createElement('ul');for(const link of e.links){const item=document.createElement('li');item.textContent=link.from+' → '+link.to+'  ['+link.id+']';list.append(item);}trace.append(list);}
  };
  panel.querySelectorAll('[data-node-id],[data-edge-id]').forEach(el=>{el.setAttribute('tabindex','0');el.setAttribute('role','button');el.setAttribute('aria-label',el.querySelector('title')?.textContent||'查看关系');});
  panel.addEventListener('click',event=>activate(event.target.closest('[data-node-id],[data-edge-id],[data-wire-label]'),event.target.closest('[data-port-id]')?.getAttribute('data-port-id')));
  panel.querySelector('.diagram-stage').addEventListener('wheel',event=>{if(event.ctrlKey||event.metaKey){event.preventDefault();zoomTo(scale()*Math.exp(-Math.max(-100,Math.min(100,event.deltaY))*.004),{x:event.clientX,y:event.clientY});}},{passive:false});
  panel.addEventListener('dblclick',event=>{const node=event.target.closest('[data-node-id]');if(!node)return;const rect=node.getBoundingClientRect();zoomTo(1.1,{x:rect.x+rect.width/2,y:rect.y+rect.height/2});const stage=currentStage(),box=stage.getBoundingClientRect(),after=node.getBoundingClientRect();stage.scrollLeft+=after.x+after.width/2-box.x-box.width/2;stage.scrollTop+=after.y+after.height/2-box.y-box.height/2;});
  panel.addEventListener('keydown',event=>{if(event.key==='Escape')reset();if(event.key==='Enter'||event.key===' '){const el=event.target.closest('[data-node-id],[data-edge-id]');if(el){event.preventDefault();activate(el);}}});
 });
 })();</script></section>`;
}
