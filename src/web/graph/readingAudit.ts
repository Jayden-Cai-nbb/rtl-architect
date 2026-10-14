import type {ScopeDiagram} from './scopeDiagram';
/** Audit saved/manual positions as well as generated layouts; never repair a user's positions here. */
export function readingAudit(graph:ScopeDiagram){
 const reading=graph.reading,issues:{code:string;targets:string[];reason:string}[]=[];
 if(!reading)return {status:'not_requested',issues,counts:{parallel:0,shared:0,feedback:0}};
 const nodes=graph.nodes.filter(n=>!n.data.boundary),byId=new Map(nodes.map(n=>[n.id,n]));
 const box=(id:string)=>{const n=byId.get(id);return n?{left:n.position.x,right:n.position.x+n.data.geometry.width,top:n.position.y,bottom:n.position.y+n.data.geometry.height,center:n.position.x+n.data.geometry.width/2,centerY:n.position.y+n.data.geometry.height/2}:undefined;};
 const issue=(code:string,targets:string[],reason:string)=>issues.push({code,targets,reason});
 for(let i=1;i<reading.mainPath.length;i++){
  const a=box(reading.mainPath[i-1]),b=box(reading.mainPath[i]);
  if(!a||!b||a.right>b.left)issue('MAIN_PATH_ORDER',reading.mainPath.slice(i-1,i+1),'主线应从左到右，当前存在倒序、重叠或隐藏节点。');
 }
 const peripheral=new Set([...reading.control,...reading.adjacent.map(a=>a.node),...(reading.shared??[]).map(s=>s.node)]);
 const stages=(reading.stages??[]).map(s=>({...s,body:s.nodes.filter(id=>!peripheral.has(id)).map(box)})).filter(s=>s.body.length);
 for(let i=1;i<stages.length;i++)if(stages[i-1].body.some(b=>!b)||stages[i].body.some(b=>!b)||Math.max(...stages[i-1].body.map(b=>b!.right))>Math.min(...stages[i].body.map(b=>b!.left)))issue('STAGE_ORDER',[...stages[i-1].nodes,...stages[i].nodes],'阅读分区的主体顺序未满足；分区不表示寄存级。');
 for(const p of reading.parallel??[]){
  const members=p.nodes.map(box);
  if(members.some(b=>!b)||members.some(b=>Math.abs(b!.left-members[0]!.left)>1))issue('PARALLEL_COLUMN',p.nodes,`${p.label}的成员应在同一列。`);
  if(members.every(b=>!!b)&&members.slice(1).some((b,i)=>b!.top-members[i]!.bottom<96))issue('PARALLEL_SPACING',p.nodes,`${p.label}应按声明次序排列，并为分支保留至少 96 单位间隔。`);
 }
 for(const s of reading.shared??[]){
  const resource=box(s.node),clients=s.clients.map(box);
  const below=resource&&clients.every(b=>b)&&resource.top>=Math.max(...clients.map(b=>b!.bottom))+96&&resource.center>=Math.min(...clients.map(b=>b!.center))-128&&resource.center<=Math.max(...clients.map(b=>b!.center))+128;
  const beside=resource&&clients.every(b=>b)&&resource.left>=Math.max(...clients.map(b=>b!.right))+96&&resource.centerY>=Math.min(...clients.map(b=>b!.centerY))-128&&resource.centerY<=Math.max(...clients.map(b=>b!.centerY))+128;
  if(!below&&!beside)issue('SHARED_PLACEMENT',[s.node,...s.clients],'共享资源应保留单个节点，靠近使用方下方或右侧；当前位置需调整。');
 }
 const top=Math.min(...nodes.map(n=>n.position.y)),bottom=Math.max(...nodes.map(n=>n.position.y+n.data.geometry.height));
 for(const f of reading.feedback??[]){
  const edges=graph.edges.filter(e=>e.source===f.from&&e.target===f.to);
  if(!edges.length||edges.some(e=>{const points=e.data?.routePoints as {x:number;y:number}[]|undefined;return !points?.slice(1).some((p,i)=>p.y===points[i].y&&Math.abs(p.x-points[i].x)>=32&&(f.side==='top'?p.y<top:p.y>bottom));}))issue('FEEDBACK_CHANNEL',[f.from,f.to],`返回关系未全部经过${f.side==='top'?'上':'下'}方外侧通道；请扩大间隔或调整位置。`);
 }
 return {status:issues.length?'needs_attention':'satisfied',issues,counts:{parallel:reading.parallel?.length??0,shared:reading.shared?.length??0,feedback:reading.feedback?.length??0},note:'只核对展示约束，不证明并行时序、资源仲裁、反馈可达性或 RTL 正确性。'};
}
