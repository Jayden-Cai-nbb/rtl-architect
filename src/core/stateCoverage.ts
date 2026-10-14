import type {StateUpdate,Obligation} from './schema';

export type StateCoverageGoal={key:string;label:string;required:boolean;reachability:'unreachable'|'unknown';reason:string};
/** Deliberately small proof: only literal conditions, never inferred input constraints or RTL text. */
export function stateCoverage(update:StateUpdate,obligation:Extract<Obligation,{kind:'state_transition'}>){
 const goals:StateCoverageGoal[]=[];
 const add=(key:string,label:string,proof?:string)=>goals.push({key,label,required:!proof,reachability:proof?'unreachable':'unknown',reason:proof??'未证明不可达；需在本次场景命中'});
 const literal=(i:number)=>{const c=update.branches[i].condition;return c.kind==='constant'?BigInt(c.value)!==0n:undefined;};
 const preceding=(i:number)=>update.branches.slice(0,i).findIndex((_,j)=>literal(j)===true);
 add('observations','完成的状态比较');
 if(update.reset)add('reset','同步复位');
 update.branches.forEach((b,i)=>add('branch'+i,'分支 '+b.id,literal(i)===false?'条件是常量 0':preceding(i)>=0?'前面的常量 1 分支必定先匹配':undefined));
 add('hold','默认保持',preceding(update.branches.length)>=0?'常量 1 分支保证非复位时一定更新':undefined);
 for(const [i,p] of (obligation.priorityPairs??[]).entries()){
  const hi=update.branches.findIndex(b=>b.id===p.higher),lo=update.branches.findIndex(b=>b.id===p.lower);
  add('priority'+i,`${p.higher} 优先于 ${p.lower}（同时成立且写入值不同）`,literal(hi)===false||literal(lo)===false?'参与竞争的条件是常量 0':preceding(hi)>=0?'更早的常量 1 分支屏蔽此竞争':undefined);
 }
 return goals;
}

export type StateCoverageResult={status:'COMPLETE'|'INCOMPLETE'|'UNKNOWN';goals:(StateCoverageGoal&{hits:number|null;status:'HIT'|'UNTESTED'|'UNREACHABLE'|'UNKNOWN'})[];changedWrites:number|null;observedTransitions:number|null};
/** Guidance is derived from a missing goal; it does not solve constraints or edit a testbench. */
export function coverageNextSteps(coverage:StateCoverageResult){
 return coverage.goals.filter(g=>g.status==='UNTESTED'||g.status==='UNKNOWN').map(g=>({key:g.key,label:g.label,
  suggestion:g.status==='UNKNOWN'?'先核对本次仿真日志、监视器绑定与覆盖记录；记录不明不能当作缺少激励。':
   g.key==='observations'?'让仿真经过有效沿及相反沿的状态比较，再结束测试。':
   g.key==='reset'?'让同步复位在有效沿被采样，并运行到相反沿完成比较。':
   g.key==='hold'?'在复位无效、所有更新条件均不成立时观察状态保持；选取能区分误写与保持的数据。':
   g.key.startsWith('priority')?'在复位无效时让这两个条件同时成立、右值不同，并让更早分支不命中。':
   '在复位无效时让本分支条件成立、所有更早分支不成立，再观察更新结果。'}));
}
/** The marker includes the obligation fingerprint; a generic PASS cannot satisfy coverage. */
export function readStateCoverage(log:string,marker:string,goals:StateCoverageGoal[]):StateCoverageResult{
 const lines=log.split(/\r?\n/).filter(l=>l.startsWith(marker+' ')),counts=new Map<string,number>();
 let valid=lines.length===1;
 if(valid)for(const field of lines[0].slice(marker.length+1).split(' ')){
  const m=/^([a-zA-Z0-9]+)=([0-9]+)$/.exec(field),n=m?Number(m[2]):NaN;
  if(!m||!Number.isSafeInteger(n)||counts.has(m[1])){valid=false;break;}counts.set(m[1],n);
 }
 const keys=[...goals.map(g=>g.key),'changedWrites','observedTransitions'];
 valid=valid&&counts.size===keys.length&&keys.every(k=>counts.has(k));
 const result=goals.map(g=>{const hits=valid?counts.get(g.key)!:null;return {...g,hits,status:(hits===null?'UNKNOWN':!g.required?(hits===0?'UNREACHABLE':'UNKNOWN'):hits>0?'HIT':'UNTESTED') as StateCoverageResult['goals'][number]['status']};});
 return {status:result.some(g=>g.status==='UNKNOWN')?'UNKNOWN':result.some(g=>g.status==='UNTESTED')?'INCOMPLETE':'COMPLETE',goals:result,changedWrites:valid?counts.get('changedWrites')!:null,observedTransitions:valid?counts.get('observedTransitions')!:null};
}
