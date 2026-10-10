import {wireSpacing} from './ports';
import type {Edge} from '@xyflow/react';
import type {RtlNode} from './types';
type Point={x:number;y:number};
type Box={left:number;right:number;top:number;bottom:number};
const intersects=(a:Point,b:Point,r:Box)=>a.x===b.x?a.x>r.left&&a.x<r.right&&Math.max(a.y,b.y)>r.top&&Math.min(a.y,b.y)<r.bottom:a.y>r.top&&a.y<r.bottom&&Math.max(a.x,b.x)>r.left&&Math.min(a.x,b.x)<r.right;
class Queue {
 items:{key:number;score:number}[]=[];
 push(item:{key:number;score:number}){let i=this.items.length;this.items.push(item);while(i){const p=(i-1)>>1;if(this.items[p].score<=item.score)break;this.items[i]=this.items[p];i=p;}this.items[i]=item;}
 pop(){const first=this.items[0],last=this.items.pop()!;if(this.items.length){let i=0;while(i*2+1<this.items.length){let c=i*2+1;if(c+1<this.items.length&&this.items[c+1].score<this.items[c].score)c++;if(this.items[c].score>=last.score)break;this.items[i]=this.items[c];i=c;}this.items[i]=last;}return first;}
}
/** Route around blocks, preserving exact handles. No semantic data is inferred. */
export function routeEdges(nodes:RtlNode[],edges:Edge[]){
 const blocks=nodes.filter(n=>n.data.kind!=='frame'),boxes:Box[]=blocks.map(n=>({left:n.position.x-8,right:n.position.x+n.data.geometry.width+8,top:n.position.y-8,bottom:n.position.y+n.data.geometry.height+8}));
 const used:{a:Point;b:Point;edge:Edge}[]=[],labels:Box[]=[];
 const delta={EAST:{x:1,y:0},WEST:{x:-1,y:0},NORTH:{x:0,y:-1},SOUTH:{x:0,y:1}};
 const xsBase=boxes.flatMap(b=>[b.left-24,b.right+24]),ysBase=boxes.flatMap(b=>[b.top-24,b.bottom+24]);
 // Small scopes can afford extra parallel corridors; large scopes retain bounded grid size.
 if(blocks.length<=16){for(const box of boxes){xsBase.push(box.left-56,box.right+56);ysBase.push(box.top-56,box.bottom+56);}}
 const top=Math.min(...ysBase),bottom=Math.max(...ysBase);
 ysBase.push(top-32,top-64,top-96,bottom+32,bottom+64);
 const priority:Record<string,number>={data:0,response:1,writeback:2,request:3,control:4};
 const ordered=[...edges].sort((a,b)=>(priority[String(a.data?.category)]??5)-(priority[String(b.data?.category)]??5)||a.id.localeCompare(b.id));
 for(const edge of ordered){
  const s=nodes.find(n=>n.id===edge.source)!,t=nodes.find(n=>n.id===edge.target)!,sp=s.data.geometry.ports.find(p=>p.id===edge.sourceHandle)!,tp=t.data.geometry.ports.find(p=>p.id===edge.targetHandle)!;
  const from={x:s.position.x+sp.x,y:s.position.y+sp.y},to={x:t.position.x+tp.x,y:t.position.y+tp.y},sd=delta[sp.side],td=delta[tp.side],start={x:from.x+sd.x*32,y:from.y+sd.y*32},end={x:to.x+td.x*32,y:to.y+td.y*32};
  const laneXs=blocks.length<=16?used.filter(u=>u.a.x===u.b.x).flatMap(u=>[u.a.x-wireSpacing,u.a.x+wireSpacing]):[],laneYs=blocks.length<=16?used.filter(u=>u.a.y===u.b.y).flatMap(u=>[u.a.y-wireSpacing,u.a.y+wireSpacing]):[];
  const xs=[...new Set([...xsBase,...laneXs,start.x,end.x,(start.x+end.x)/2])].sort((a,b)=>a-b),ys=[...new Set([...ysBase,...laneYs,start.y,end.y,start.y-32,start.y+32,end.y-32,end.y+32])].sort((a,b)=>a-b);
  const nx=xs.length,point=(key:number):Point=>({x:xs[(key>>1)%nx],y:ys[Math.floor((key>>1)/nx)]}),key=(x:number,y:number,d:number)=>((y*nx+x)*2+d);
  const source=key(xs.indexOf(start.x),ys.indexOf(start.y),0),endIndex=key(xs.indexOf(end.x),ys.indexOf(end.y),0)>>1;
  const costs=new Map<number,number>([[source,0]]),parents=new Map<number,number>(),queue=new Queue(),closed=new Set<number>(),valid=new Map<string,boolean>();
  queue.push({key:source,score:0});let finish:number|undefined;
  while(queue.items.length){
   const current=queue.pop().key;if(closed.has(current))continue;closed.add(current);if(current>>1===endIndex){finish=current;break;}
   const cx=(current>>1)%nx,cy=Math.floor((current>>1)/nx),a=point(current);
   for(const [x,y,d] of [[cx-1,cy,0],[cx+1,cy,0],[cx,cy-1,1],[cx,cy+1,1]]){
    if(x<0||x>=nx||y<0||y>=ys.length)continue;
    const next=key(x,y,d),b=point(next),cacheKey=[current>>1,next>>1].sort((a,b)=>a-b).join(':');
    if(!valid.has(cacheKey))valid.set(cacheKey,!boxes.some(r=>intersects(a,b,r)));
    if(!valid.get(cacheKey))continue;
    const overlap=used.reduce((total,u)=>{
     if(edge.data?.netKey&&u.edge.data?.netKey===edge.data.netKey)return total;
     const parallel=d===0?u.a.y===u.b.y:u.a.x===u.b.x;
     if(!parallel)return total;const axis=d===0?'x':'y',distance=d===0?Math.abs(a.y-u.a.y):Math.abs(a.x-u.a.x);
     const length=Math.max(0,Math.min(Math.max(a[axis],b[axis]),Math.max(u.a[axis],u.b[axis]))-Math.max(Math.min(a[axis],b[axis]),Math.min(u.a[axis],u.b[axis])));
     return total+length*(distance===0?4:distance<wireSpacing?.6*(1-distance/wireSpacing)**2:0);
    },0);
    const crossings=used.filter(u=>d===0?u.a.x===u.b.x&&u.a.x>Math.min(a.x,b.x)&&u.a.x<Math.max(a.x,b.x)&&a.y>Math.min(u.a.y,u.b.y)&&a.y<Math.max(u.a.y,u.b.y):u.a.y===u.b.y&&u.a.y>Math.min(a.y,b.y)&&u.a.y<Math.max(a.y,b.y)&&a.x>Math.min(u.a.x,u.b.x)&&a.x<Math.max(u.a.x,u.b.x)).length;
    const cost=costs.get(current)!+Math.abs(a.x-b.x)+Math.abs(a.y-b.y)+(d!==(current%2)?40:0)+overlap*12+crossings*70;
    if(cost>=(costs.get(next)??Infinity))continue;
    costs.set(next,cost);parents.set(next,current);queue.push({key:next,score:cost+Math.abs(b.x-end.x)+Math.abs(b.y-end.y)});
   }
  }
  if(finish===undefined){edge.data={...edge.data,routingFallback:true};continue;}
  const points:Point[]=[to];let cursor:number|undefined=finish;while(cursor!==undefined){points.push(point(cursor));cursor=parents.get(cursor);}points.push(from);points.reverse();
  const simplified=points.filter((p,i)=>!i||i===points.length-1||!((points[i-1].x===p.x&&p.x===points[i+1].x)||(points[i-1].y===p.y&&p.y===points[i+1].y)));
  const segments=simplified.slice(1).map((b,i)=>({a:simplified[i],b}));
  used.push(...segments.map(s=>({...s,edge})));
  edge.data={...edge.data,route:{path:simplified.map((p,i)=>`${i?'L':'M'} ${p.x} ${p.y}`).join(' '),x:0,y:0},routePoints:simplified};
 }
 // Place all names against the final wires, rather than letting a later wire cross an earlier name.
 for(const edge of ordered){
  if(!edge.data?.routePoints)continue;
  const own=used.filter(s=>s.edge.id===edge.id),foreign=used.filter(s=>s.edge.id!==edge.id);
  const labelWidth=String(edge.label??'').split('').reduce((n,c)=>n+(c.charCodeAt(0)>255?16:8.5),0)+12;
  const candidates:{x:number;y:number;box:Box;score:number}[]=[];
  for(const seg of own){
   const horizontal=seg.a.y===seg.b.y,length=Math.abs(seg.a.x-seg.b.x)+Math.abs(seg.a.y-seg.b.y);
   if(length<(horizontal?labelWidth+12:32))continue;
   for(const fraction of [.5,.25,.75,.12,.88,...Array.from({length:Math.max(0,Math.floor(length/12)-1)},(_,i)=>(i+1)*12/length)]){
    const x=seg.a.x+(seg.b.x-seg.a.x)*fraction,y=seg.a.y+(seg.b.y-seg.a.y)*fraction;
    for(const offset of horizontal?[0]:[labelWidth/2+7,-labelWidth/2-7]){
     const px=x+offset,box={left:px-labelWidth/2,right:px+labelWidth/2,top:y-13,bottom:y+13};
     if(horizontal&&(box.left<Math.min(seg.a.x,seg.b.x)+4||box.right>Math.max(seg.a.x,seg.b.x)-4))continue;
     if([...boxes,...labels].some(r=>box.left<r.right&&box.right>r.left&&box.top<r.bottom&&box.bottom>r.top))continue;
     if(foreign.some(s=>intersects(s.a,s.b,box)&&!(edge.data?.netKey&&s.edge.data?.netKey===edge.data.netKey&&horizontal&&s.a.y===y&&s.b.y===y)))continue;
     candidates.push({x:px,y,box,score:(horizontal?0:500)+Math.abs(fraction-.5)*100-length/100});
    }
   }
  }
  candidates.sort((a,b)=>a.score-b.score);const best=candidates[0];
  if(best)labels.push(best.box);
  edge.data={...edge.data,route:{...(edge.data.route as object),x:best?.x??0,y:best?.y??0},labelHidden:!!edge.label&&!best,labelBox:best?.box};
 }
}
