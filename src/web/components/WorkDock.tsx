import {useEffect,useRef,useState,type ReactNode} from 'react';
import {api} from '../api';

const limit=(height:number)=>Math.round(Math.max(180,Math.min(height,560,window.innerHeight*.42)));

export function WorkDock({active,children,report}:{active:boolean;children:ReactNode;report:(message:string)=>void}){
 const body=useRef<HTMLDivElement>(null),drag=useRef<{y:number;height:number;latest:number}>(undefined);
 const edited=useRef(false);
 const [height,setHeight]=useState<number|null>(null);
 useEffect(()=>{
  if(!active)return;
  let live=true;
  void api<{height:number|null}>('work-dock').then(saved=>{if(live&&!edited.current)setHeight(saved.height);}).catch(e=>{if(live)report(String(e));});
  return ()=>{live=false;};
 },[active,report]);
 const save=(next:number)=>{
  edited.current=true;
  setHeight(next);
  void api('work-dock',{height:next},'PUT').catch(e=>report(String(e)));
 };
 return <div className="work-dock-shell" hidden={!active}>
  <div role="separator" aria-label="调整讨论面板高度" aria-orientation="horizontal" aria-controls="work-dock"
   aria-valuemin={180} aria-valuemax={limit(560)} aria-valuenow={limit(height??window.innerHeight*.31)} tabIndex={0} className="work-dock-resize"
   onPointerDown={e=>{
    if(e.button!==0||!body.current)return;
    edited.current=true;
    const start=body.current.getBoundingClientRect().height;
    drag.current={y:e.clientY,height:start,latest:start};
    e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);
   }}
   onPointerMove={e=>{
    const start=drag.current;if(!start)return;
    start.latest=limit(start.height+start.y-e.clientY);setHeight(start.latest);
   }}
   onPointerUp={()=>{const start=drag.current;if(start){drag.current=undefined;save(limit(start.latest));}}}
   onPointerCancel={()=>{if(drag.current){setHeight(limit(drag.current.height));drag.current=undefined;}}}
   onKeyDown={e=>{
    const steps:Record<string,number>={ArrowUp:24,ArrowDown:-24,Home:-560,End:560};
    if(!(e.key in steps)||!body.current)return;
    e.preventDefault();
    save(limit(body.current.getBoundingClientRect().height+steps[e.key]));
   }}/>
  <div ref={body} className="dock-body work-dock" id="work-dock" style={height===null?undefined:{height}}>{children}</div>
 </div>;
}
