import {z} from 'zod';
import {idSchema} from './schema';

export const positive=z.number().int().safe().positive().max(1e9);
export const nonnegative=z.number().int().safe().nonnegative().max(1e9);
const tick=z.number().int().nonnegative().max(4095);
export const computeTimingSchema=z.strictObject({latencyCycles:nonnegative.nullable(),initiationInterval:positive.nullable()});
export const launchesSchema=z.array(z.strictObject({id:idSchema,cycle:tick,lane:nonnegative})).max(256);
export const feedbackSchema=z.array(z.strictObject({id:idSchema,latencyCycles:nonnegative.nullable(),distance:positive})).max(32);
export const portKindSchema=z.enum(['shared_rw','independent_1r1w','true_dual_2rw']);
export const memoryOrganizationSchema=z.strictObject({
 kind:portKindSchema,bankIds:z.array(idSchema).min(1).max(16),
 readLatencyCycles:nonnegative.nullable(),sameAddressReadWrite:z.enum(['old_data','new_data','no_change','forbidden','unknown']),
 mapping:z.array(z.strictObject({address:nonnegative,bank:idSchema,word:nonnegative})).max(512),
});
export const accessesSchema=z.array(z.strictObject({id:idSchema,cycle:tick,kind:z.enum(['read','write']),address:nonnegative.nullable()})).max(512);
const rate=z.number().finite().nonnegative().max(1e12).nullable();
export const sustainedSchema=z.discriminatedUnion('unit',[
 z.strictObject({unit:z.literal('items_per_cycle'),arrival:rate,consumption:rate}),
 z.strictObject({unit:z.literal('bytes_per_second'),arrival:rate,consumption:rate,bytesPerItem:positive}),
]);
export const exact=(n:number)=>{if(!Number.isSafeInteger(n))throw new Error('预算超过安全整数范围，请缩小计算范围或分阶段计算');return n;};
export const ceiling=(work:number,units:number)=>Number((BigInt(exact(work))+BigInt(units)-1n)/BigInt(units));
type Timing=z.infer<typeof computeTimingSchema>;
type Launch=z.infer<typeof launchesSchema>[number];
type Organization=z.infer<typeof memoryOrganizationSchema>;
type Access=z.infer<typeof accessesSchema>[number];
type Sustained=z.infer<typeof sustainedSchema>;
export type ConstraintIssue={code:string;message:string;members:string[];cycle?:number;bank?:string;lane?:number};
export const portKindLabels={shared_rw:'共享单 R/W',independent_1r1w:'独立 1R1W',true_dual_2rw:'双端口 2RW'};

/** Each launch reserves the whole declared lane, not its result latency. No scheduler is run. */
export function resourceConstraint(compute:{lanes:number;operationsPerItem:number;cyclesPerOperation:number;timing?:Timing;launches?:Launch[]},workItems:number){
 const timing=compute.timing,spacing=Math.max(compute.cyclesPerOperation,timing?.initiationInterval??0);
 const issues:ConstraintIssue[]=[],launches=[...(compute.launches??[])].sort((a,b)=>a.cycle-b.cycle||a.id.localeCompare(b.id));
 const rows=launches.map(l=>({...l,reservedUntil:exact(l.cycle+compute.cyclesPerOperation),nextLaunchNotBefore:exact(l.cycle+spacing),resultVisibleCycle:timing?.latencyCycles==null?null:exact(l.cycle+timing.latencyCycles)}));
 for(let j=0;j<rows.length;j++){
  const b=rows[j],previous=rows.slice(0,j).filter(a=>a.lane===b.lane&&b.cycle<a.nextLaunchNotBefore);
  const occupied=previous.filter(a=>b.cycle<a.reservedUntil),interval=previous.filter(a=>b.cycle>=a.reservedUntil);
  if(occupied.length)issues.push({code:'RESOURCE_OCCUPIED',message:`E${b.cycle} / 资源 ${b.lane} 的独占区间重叠`,members:[...occupied.map(a=>a.id),b.id],cycle:b.cycle,lane:b.lane});
  if(interval.length)issues.push({code:'INITIATION_INTERVAL',message:`${b.id} 在 E${b.cycle} 提前启动；同资源的前序请求尚未满足启动间隔`,members:[...interval.map(a=>a.id),b.id],cycle:b.cycle,lane:b.lane});
 }
 const intervalLowerBound=exact(compute.operationsPerItem*spacing)/compute.lanes;
 const total=exact(workItems*compute.operationsPerItem),waves=ceiling(total,compute.lanes);
 return {resourceCount:compute.lanes,occupancyCycles:compute.cyclesPerOperation,latencyCycles:timing?.latencyCycles??null,declaredInitiationInterval:timing?.initiationInterval??null,
  spacingLowerBound:spacing,intervalLowerBound,timingComplete:!!timing&&timing.initiationInterval!==null&&timing.latencyCycles!==null,
  resultWindowLowerBound:timing?.latencyCycles==null?null:exact(exact((waves-1)*spacing)+timing.latencyCycles),
  traceStatus:!launches.length?'not_run' as const:issues.length?'conflict' as const:!timing||timing.initiationInterval===null?'unknown' as const:'no_conflict_in_declared_trace' as const,rows,issues,
  explanation:`每项资源下界 = 运算数 × max(独占周期 ${compute.cyclesPerOperation}, 已知启动间隔 ${timing?.initiationInterval??'UNKNOWN'}) / 资源数 ${compute.lanes}。latency 只决定单笔结果可见时间，不乘入吞吐服务量；未知 II 时仅保留已知独占下界。有限请求不自动排队或重排。`,
 };
}

export function recurrenceConstraint(feedback:z.infer<typeof feedbackSchema>|undefined){
 const rows=(feedback??[]).map(f=>({...f,intervalLowerBound:f.latencyCycles===null?null:f.latencyCycles/f.distance,integerIILowerBound:f.latencyCycles===null?null:Math.ceil(f.latencyCycles/f.distance)}));
 const known=rows.flatMap(r=>r.intervalLowerBound===null?[]:[r.intervalLowerBound]);
 return {status:!rows.length?'not_declared' as const:rows.some(r=>r.intervalLowerBound===null)?'unknown' as const:'bounded' as const,
  intervalLowerBound:known.length?Math.max(...known):null,rows,
  explanation:'每条明确反馈依赖要求 distance × II ≥ latency；平均间隔下界为 latency / distance，固定整数 II 还需向上取整。没有声明不等于没有递推；不从图形位置、名称或 RTL 猜测依赖。'};
}

/** Supported banks have one request per port per cycle; latency does not occupy a request port. */
export function memoryConstraint(organization:Organization,accesses:Access[]|undefined){
 const issues:ConstraintIssue[]=[],unknowns:ConstraintIssue[]=[];
 const mapped=new Map(organization.mapping.map(m=>[m.address,m]));
 const rows=[...(accesses??[])].sort((a,b)=>a.cycle-b.cycle||a.id.localeCompare(b.id)).map(a=>{
  const m=a.address===null?undefined:mapped.get(a.address);
  if(!m)unknowns.push({code:'BANK_MAPPING_UNKNOWN',message:`${a.id} 在 E${a.cycle} 的地址或 bank 映射未知`,members:[a.id],cycle:a.cycle});
  if(a.kind==='read'&&organization.readLatencyCycles===null)unknowns.push({code:'READ_LATENCY_UNKNOWN',message:`${a.id} 的读结果可见沿未知`,members:[a.id],cycle:a.cycle});
  return {...a,bank:m?.bank??null,word:m?.word??null,port:null as string|null,portStatus:m?'pending':'unknown',readVisibleCycle:a.kind==='read'&&organization.readLatencyCycles!==null?exact(a.cycle+organization.readLatencyCycles):null,readValue:a.kind==='read'?'stored_value':'not_a_read'};
 });
 const groups=new Map<string,typeof rows>();
 for(const r of rows){if(r.bank===null)continue;const key=JSON.stringify([r.cycle,r.bank]);groups.set(key,[...(groups.get(key)??[]),r]);}
 const occupancy=[];
 for(const group of groups.values()){
  const {cycle,bank}=group[0],reads=group.filter(r=>r.kind==='read'),writes=group.filter(r=>r.kind==='write');
  const capacity=organization.kind==='shared_rw'?1:2;
  const conflict=organization.kind==='independent_1r1w'?reads.length>1||writes.length>1:group.length>capacity;
  const unresolved=rows.some(r=>r.cycle===cycle&&r.bank===null);
  if(conflict)issues.push({code:'BANK_PORT_CONFLICT',message:`E${cycle} / ${bank} 请求 ${reads.length} 读 + ${writes.length} 写，超过${portKindLabels[organization.kind]}能力`,members:group.map(r=>r.id),cycle,bank:bank!});
  group.forEach((r,i)=>{r.portStatus=conflict?'conflict':unresolved?'unknown':'within_declared_ports';r.port=conflict||unresolved?null:organization.kind==='independent_1r1w'?(r.kind==='read'?'R':'W'):`RW${i}`;});
  occupancy.push({cycle,bank:bank!,reads:reads.length,writes:writes.length,members:group.map(r=>r.id),status:conflict?'conflict':unresolved?'unknown':'within_declared_ports'});
  for(const word of new Set(group.map(a=>a.word))){
   const same=group.filter(a=>a.word===word),ws=same.filter(a=>a.kind==='write'),rs=same.filter(a=>a.kind==='read'),members=same.map(a=>a.id);
   if(ws.length>1)issues.push({code:'SAME_WORD_WRITES',message:`E${cycle} / ${bank}[${word}] 多次写入冲突，不猜测优先级`,members,cycle,bank:bank!});
   if(!ws.length||!rs.length)continue;
   const mode=organization.sameAddressReadWrite;
   for(const read of rs){read.readValue=mode;if(mode==='no_change')read.readVisibleCycle=null;}
   if(mode==='unknown')unknowns.push({code:'READ_DURING_WRITE_UNKNOWN',message:`E${cycle} / ${bank}[${word}] 同址读写值未知`,members,cycle,bank:bank!});
   if(mode==='forbidden')issues.push({code:'READ_DURING_WRITE_FORBIDDEN',message:`E${cycle} / ${bank}[${word}] 违反禁止同址读写的声明`,members,cycle,bank:bank!});
  }
 }
 for(const r of rows){
  if(r.kind!=='read')continue;
  if(r.portStatus==='unknown'){r.readValue='unknown';r.readVisibleCycle=null;}
  if(issues.some(i=>i.members.includes(r.id))){r.readValue='unresolved_conflict';r.readVisibleCycle=null;}
 }
 return {kind:organization.kind,label:portKindLabels[organization.kind],readLatencyCycles:organization.readLatencyCycles,sameAddressReadWrite:organization.sameAddressReadWrite,
  status:!rows.length?'not_run' as const:issues.length?'conflict' as const:unknowns.length?'unknown' as const:'no_conflict_in_declared_trace' as const,
  rows,occupancy,issues,unknowns,explanation:'按显式地址 → bank/word 映射检查同周期请求。bank 各有独立端口；总端口数不能消除局部冲突。端口编号仅说明该拍请求可分配，不是已接受事务或实际调度。读值仅报告声明语义，不仿真 RAM 内容；no_change 不产生该读请求的新结果。'};
}

export function sustainedConstraint(flow:{capacity:number;inFlight:number;sustained?:Sustained}|undefined){
 const s=flow?.sustained;
 if(!s)return {status:'not_declared' as const,netGrowth:null,timeToFill:null,timeUnit:null,finiteCapacitySupportsLongTerm:null,explanation:'未声明持续到达率/消费率；停顿缓存充足不能证明长期稳定。'};
 if(s.arrival===null||s.consumption===null)return {status:'unknown' as const,netGrowth:null,timeToFill:null,timeUnit:null,finiteCapacitySupportsLongTerm:null,explanation:'持续到达率或消费率未知，不能判定长期稳定。'};
 const net=s.arrival-s.consumption,scale=s.unit==='bytes_per_second'?s.bytesPerItem:1;
 const remaining=exact(Math.max(0,flow!.capacity-flow!.inFlight)*scale),timeToFill=net>0?remaining/net:null;
 return {status:net>0?'unbounded_growth' as const:net===0?'balanced_rates' as const:'rate_headroom' as const,netGrowth:net,
  timeToFill:timeToFill!==null&&Number.isFinite(timeToFill)?timeToFill:null,timeUnit:s.unit==='bytes_per_second'?'seconds' as const:'cycles' as const,
  finiteCapacitySupportsLongTerm:net>0?false:null,
  explanation:net>0?`持续到达 ${s.arrival} > 消费 ${s.consumption}（${s.unit}），积压以 ${net} 增长；任何有限 FIFO 都不能支持长期无阻塞输入。填满时间仅按恒定流率、初始占用为 inFlight 的流体估算。`:'到达率不大于消费率，仅满足平均速率的必要条件；突发、消费停顿、仲裁和公平性未证明，不能保证有限容量长期无阻塞。'};
}
