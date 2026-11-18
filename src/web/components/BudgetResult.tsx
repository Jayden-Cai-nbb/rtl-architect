import {useState} from 'react';
import type {evaluateStudy} from '../../core/studies';
import {PageList} from './Issues';
const number=(n:number|null)=>n===null?'UNKNOWN':n!==0&&Math.abs(n)<1e-4?n.toPrecision(6):n.toLocaleString(undefined,{maximumFractionDigits:6});
const traceLabel={not_run:'未执行',conflict:'存在冲突',unknown:'UNKNOWN',no_conflict_in_declared_trace:'所列请求未发现冲突'};
const valueLabel:Record<string,string>={stored_value:'存储内容（未求值）',old_data:'写前值',new_data:'本拍写值',no_change:'保持输出；无新读结果',unknown:'UNKNOWN',unresolved_conflict:'冲突，结果未确定',forbidden:'禁止同址读写',not_a_read:'—'};
function Table({headers,rows}:{headers:string[];rows:(string|number)[][]}){
 const [page,setPage]=useState(0),last=Math.max(0,Math.ceil(rows.length/30)-1),current=Math.min(page,last);
 return <><div className="budget-table"><table><thead><tr>{headers.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{rows.slice(current*30,current*30+30).map((r,i)=><tr key={i}>{r.map((v,j)=><td key={j}>{v}</td>)}</tr>)}</tbody></table></div>{rows.length>30&&<div className="pagination"><button disabled={!current} onClick={()=>setPage(current-1)}>上一页</button><span>{current+1} / {last+1} · {rows.length} 行</span><button disabled={current===last} onClick={()=>setPage(current+1)}>下一页</button></div>}</>;
}
export function BudgetResult({result}:{result:ReturnType<typeof evaluateStudy>}){
 return <section className="budget-results" aria-label="预算计算结果"><h3>派生预算 · 完整调度未证明</h3><p className="hint">{result.note}</p>
 <Table headers={['方案','资源间隔下界','存储间隔下界','递推间隔下界','合并间隔下界','服务量周期下界','存储位数']} rows={result.options.map(o=>[o.label,number(o.computeII),number(o.memoryII),number(o.constraints.recurrence.intervalLowerBound),number(o.intervalLowerBound),number(o.cyclesLowerBound),o.storageBits??'未计入'])}/>
 {result.options.map(o=>{const {resource:r,recurrence:f,memory:m,capacity:c}=o.constraints,t=m.trace;return <article key={o.id} className="work-thread budget-constraint" data-testid={`budget-result-${o.id}`}><h3>{o.label} · {o.bottleneck}下界</h3>
 <p>固定整数 II 下界：{number(o.integerIILowerBound)}；不保证可达。{o.runIds.length?`关联 ${o.runIds.length} 次历史检查，未自动认证性能数值。`:''}</p>
 <h4>资源约束</h4><p>资源 {r.resourceCount} 个 · latency {number(r.latencyCycles)} 拍 · 声明 II {number(r.declaredInitiationInterval)} 拍 · 每次独占 {r.occupancyCycles} 拍。</p><p>{r.explanation}</p><p>独立运算结果窗口下界：{number(r.resultWindowLowerBound)} 拍（不含存储及整体依赖）。启动序列：{traceLabel[r.traceStatus]}。</p>
 <PageList items={r.issues} render={(i,n)=><p key={n} className="collaboration-notice">{i.code} · {i.message} · {i.members.join('、')}</p>}/>
 {!!r.rows.length&&<details><summary>资源占用 · {r.rows.length} 次请求</summary><Table headers={['请求','启动沿','资源编号','独占区间','再次启动下界','假定接受后的结果可见沿']} rows={r.rows.map(l=>[l.id,`E${l.cycle}`,l.lane,`[${l.cycle}, ${l.reservedUntil})`,`E${l.nextLaunchNotBefore}`,l.resultVisibleCycle===null?'UNKNOWN':`E${l.resultVisibleCycle}`])}/></details>}
 <h4>递推约束</h4><p>{f.explanation}</p>{!f.rows.length?<p>未声明；不等于无反馈。</p>:<Table headers={['依赖','latency','距离','平均 II 下界','固定整数 II 下界']} rows={f.rows.map(d=>[d.id,number(d.latencyCycles),d.distance,number(d.intervalLowerBound),number(d.integerIILowerBound)])}/>}
 <h4>存储端口与访问</h4><p>{m.explanation}</p>{t?<><p>{t.label} · 读延迟 {number(t.readLatencyCycles)} 拍 · 同址读写 {valueLabel[t.sameAddressReadWrite]} · {traceLabel[t.status]}</p>
 <PageList items={[...t.issues,...t.unknowns]} render={(i,n)=><p key={n} className="collaboration-notice">{i.code} · {i.message} · {i.members.join('、')}</p>}/>
 <details><summary>逐拍 bank 占用与访问 · {t.rows.length} 次请求</summary><p>{t.explanation}</p><Table headers={['沿','bank','读数','写数','请求','端口检查']} rows={t.occupancy.map(b=>[`E${b.cycle}`,b.bank,b.reads,b.writes,b.members.join('、'),b.status])}/><Table headers={['请求','沿','操作','逻辑地址','bank / word','端口分配','读可见沿','读值语义']} rows={t.rows.map(a=>[a.id,`E${a.cycle}`,a.kind,a.address??'UNKNOWN',`${a.bank??'UNKNOWN'} / ${a.word??'UNKNOWN'}`,a.port??a.portStatus,a.kind==='write'?'—':a.readVisibleCycle===null?'UNKNOWN / 无新结果':`E${a.readVisibleCycle}`,valueLabel[a.readValue]??a.readValue])}/></details></>:<p>{m.status==='missing_ports'?'缺少所需读/写端口':m.status==='not_declared'?'未声明存储约束':'旧总端口预算；bank 访问检查未执行。'}</p>}
 <h4>容量与长期流率</h4><p>停顿缓存需求：{c.stallRequired??'未计入'} 项 · {c.stallCapacitySufficient===null?'未检查':c.stallCapacitySufficient?'覆盖所声明停顿':'容量不足'}。</p><p className={c.sustained.status==='unbounded_growth'?'collaboration-notice':''}>{c.sustained.status} · {c.sustained.explanation}</p>{c.sustained.timeToFill!==null&&<p>按恒定流率估算填满时间：{c.sustained.timeToFill.toPrecision(6)} {c.sustained.timeUnit}。</p>}
 <h4>未建模假设与缺口</h4><PageList items={o.unmodeled} render={(s,n)=><p className="hint" key={n}>{s}</p>}/>
 </article>;})}</section>;
}
