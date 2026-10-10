export function relationshipRoute(sx:number,sy:number,tx:number,ty:number,data?:Record<string,unknown>){
 if(data?.route)return data.route as {path:string;x:number;y:number};
 const midY=(sy+ty)/2+Number(data?.laneOffset??0),bend=Math.max(20,Math.min(60,(tx-sx)/3));
 if(data?.feedback){const y=Number(data.routeY);return {path:`M ${sx} ${sy} C ${sx+55} ${sy}, ${sx+55} ${y}, ${sx+20} ${y} L ${tx-20} ${y} C ${tx-55} ${y}, ${tx-55} ${ty}, ${tx} ${ty}`,x:(sx+tx)/2,y};}
 return {path:`M ${sx} ${sy} C ${sx+bend/2} ${sy}, ${sx+bend/2} ${midY}, ${sx+bend} ${midY} L ${tx-bend} ${midY} C ${tx-bend/2} ${midY}, ${tx-bend/2} ${ty}, ${tx} ${ty}`,x:(sx+tx)/2,y:midY};
}
