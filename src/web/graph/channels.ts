import type {Edge} from '@xyflow/react';
type Point={x:number;y:number};
type Box={left:number;right:number;top:number;bottom:number};
type Segment={a:Point;b:Point;edge:Edge};
const hit=(a:Point,b:Point,r:Box)=>a.x===b.x?a.x>r.left&&a.x<r.right&&Math.max(a.y,b.y)>r.top&&Math.min(a.y,b.y)<r.bottom:a.y>r.top&&a.y<r.bottom&&Math.max(a.x,b.x)>r.left&&Math.min(a.x,b.x)<r.right;
const simplify=(points:Point[])=>{
 const unique=points.filter((p,i)=>!i||p.x!==points[i-1].x||p.y!==points[i-1].y);
 return unique.filter((p,i)=>!i||i===unique.length-1||!((unique[i-1].x===p.x&&p.x===unique[i+1].x)||(unique[i-1].y===p.y&&p.y===unique[i+1].y)));
};
/** Prefer a few readable orthogonal segments; reserve outer channels for long returns. */
export function channelRoute(from:Point,start:Point,end:Point,to:Point,boxes:Box[],used:Segment[],edge:Edge):Point[]|undefined{
 const top=Math.min(...boxes.map(b=>b.top)),bottom=Math.max(...boxes.map(b=>b.bottom));
 const returning=start.x>end.x+380;
 const paths:Point[][]=[];
 if(start.x===end.x||start.y===end.y)paths.push([start,end]);
 paths.push([start,{x:start.x,y:end.y},end],[start,{x:end.x,y:start.y},end]);
 const near=(xs:number[],center:number)=>[...new Set(xs)].sort((a,b)=>Math.abs(a-center)-Math.abs(b-center)).slice(0,12);
 const xs=[(start.x+end.x)/2,...near(boxes.flatMap(b=>[b.left-24,b.right+24]),(start.x+end.x)/2)];
 for(const x of xs)paths.push([start,{x,y:start.y},{x,y:end.y},end]);
 const ys=[(start.y+end.y)/2,...[start.y,end.y].flatMap(y=>[y-32,y+32,y-64,y+64]),...Array.from({length:10},(_,i)=>[top-32-i*32,bottom+32+i*32]).flat()];
 for(const y of ys)paths.push([start,{x:start.x,y},{x:end.x,y},end]);
 let best:{points:Point[];cost:number}|undefined;
 for(const path of paths){
  const core=simplify(path),segments=core.slice(1).map((b,i)=>({a:core[i],b}));
  if(segments.some(s=>boxes.some(b=>hit(s.a,s.b,b))))continue;
  const points=simplify([from,...core,to]);let cost=Math.max(0,points.length-2)*85;
  if(returning&&!core.some(p=>p.y<top||p.y>bottom))cost+=3000;
  for(const {a,b} of segments){
   cost+=Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
   for(const u of used){
    if(edge.data?.netKey&&edge.data.netKey===u.edge.data?.netKey)continue;
    const horizontal=a.y===b.y,parallel=horizontal?u.a.y===u.b.y:u.a.x===u.b.x;
    if(parallel){
     const axis=horizontal?'x':'y',distance=horizontal?Math.abs(a.y-u.a.y):Math.abs(a.x-u.a.x);
     const length=Math.max(0,Math.min(Math.max(a[axis],b[axis]),Math.max(u.a[axis],u.b[axis]))-Math.max(Math.min(a[axis],b[axis]),Math.min(u.a[axis],u.b[axis])));
     cost+=length*(distance===0?12:distance<30?4:0);
    }else{
     const h=horizontal?{a,b}:u,v=horizontal?u:{a,b};
     if(v.a.x>Math.min(h.a.x,h.b.x)&&v.a.x<Math.max(h.a.x,h.b.x)&&h.a.y>Math.min(v.a.y,v.b.y)&&h.a.y<Math.max(v.a.y,v.b.y))cost+=110;
    }
   }
  }
  if(!best||cost<best.cost)best={points,cost};
 }
 return best?.points;
}
