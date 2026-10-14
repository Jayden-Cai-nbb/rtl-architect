// Hand-mapped, source-backed RTL reading fixtures. This is not an RTL inference frontend.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {modelSchema,type Model,type Module,type ScopeLayout,type Endpoint} from '../src/core/schema';
import {modelHash} from '../src/core/export';
export const patternIds=['pipeline','fork_join','arbiter','shared_ram','accumulator','fifo'] as const;
export type PatternId=typeof patternIds[number];
export async function architecturePattern(id:PatternId){
 const title={pipeline:'两级寄存流水线',fork_join:'分支运算与汇合',arbiter:'固定优先级仲裁',shared_ram:'两个读者共享 RAM',accumulator:'累加状态与返回',fifo:'单槽弹性 FIFO'}[id];
 const model:Model={schemaVersion:3,design:{id,name:title,top:'top'},clocks:[],resets:[],modules:[],connections:[],localSignals:[]};
 type Category=NonNullable<Module['interfaceGroups']>[number]['category'];
 function node(id:string,name:string,rtlModule:string,kind:Module['kind']='module',clock=false,reset=false){
  const n:Module={id,name,rtlModule,parent:id==='top'?null:'top',kind,clock:clock?'clk':null,reset:reset?'rst':null,timing:clock?(model.design.id==='shared_ram'?'mixed':'sequential'):'combinational',parameters:{},interfaces:[],interfaceGroups:[],contract:{responsibility:name,latencyMinCycles:clock?(model.design.id==='shared_ram'?0:model.design.id==='pipeline'&&id==='top'?2:1):0,latencyCondition:clock?(model.design.id==='shared_ram'?'异步读在地址稳定后组合可见；写入在 posedge clk 且 we 时发生。未建模同址读写时序保证。':'按源码记录无阻塞最小接收沿至消费沿；使能、停顿与复位条件仍须对照源码，未完成时序验收。'):'组合输出；没有时钟周期推进，未验证门级延迟。',backpressure:'按源码条件；未在本模型完整形式化。',resetBehavior:reset?'posedge clk 同步高有效 rst':clock?'无复位；初值未定义':'无寄存状态',invariants:[],verificationPlan:['独立综合前端检查层级及端口连接；阅读检查不代替功能验证。'],openQuestions:['行为合同及来源覆盖尚未完整建模。']}};
  model.modules.push(n);return id;
 }
 const sequential=['pipeline','shared_ram','accumulator','fifo'].includes(id),reset=sequential&&id!=='shared_ram';
 if(sequential)model.clocks=[{id:'clk',edge:'rising'}];
 if(reset)model.resets=[{id:'rst',clock:'clk',activeLevel:'high',synchronous:true}];
 node('top',title,id,'subsystem',sequential,reset);
 const endpoint=(s:string):Endpoint=>{const [moduleId,interfaceId]=s.split('.');return moduleId==='local'?{moduleId:'top',interfaceId,local:true}:{moduleId,interfaceId};};
 function port(ref:string,role:'consumer'|'producer',width:number,category:Category,label:string){
  const e=endpoint(ref);if(e.local)return;
  const n=model.modules.find(n=>n.id===e.moduleId)!;if(n.interfaces.some(p=>p.id===e.interfaceId))return;
  const group=`g_${e.interfaceId}`;n.interfaces.push({id:e.interfaceId,role,protocol:'signal',width,required:false,group});n.interfaceGroups!.push({id:group,label,category,description:'用途按随附 RTL 的端口连接明确记录。'});
 }
 function link(from:string,to:string,width=8,category:Category='data',label='数据'){
  port(from,from.startsWith('top.')?'consumer':'producer',width,category,label);port(to,to.startsWith('top.')?'producer':'consumer',width,category,label);
  model.connections.push({id:`c${model.connections.length}`,scope:'top',from:endpoint(from),to:endpoint(to)});
 }
 function domain(child:string){link('top.clk',`${child}.clk`,1,'clock_reset','时钟');if(reset)link('top.rst',`${child}.rst`,1,'clock_reset','复位');}
 function input(name:string,width:number,category:Category,label:string){port(`top.${name}`,'consumer',width,category,label);}
 const ref=(s:string)=>({kind:'endpoint' as const,endpoint:endpoint(s)});
 const reading:NonNullable<ScopeLayout['reading']>={modelHash:'0'.repeat(64),reason:'按随附 RTL 的实例、状态及真实连接安排；阅读顺序不代表周期。',mainPath:[],control:[],adjacent:[]};
 const local=(id:string)=>`local:top:${id}`;
 if(id==='pipeline'){
  node('first','输入寄存级','pipe_reg','module',true,true);node('second','输出寄存级','pipe_reg','module',true,true);
  link('top.din','first.d',8,'data','输入');link('first.q','second.d',8,'data','第一级结果');link('second.q','top.dout',8,'data','输出');domain('first');domain('second');reading.mainPath=['first','second'];
  reading.stages=[{id:'s1',label:'第一寄存级',nodes:['first']},{id:'s2',label:'第二寄存级',nodes:['second']}];
 }
 if(id==='fork_join'){
  node('left','输入加一','add_one','compute');node('right','逐位取反','invert_byte','compute');node('merge','异或汇合','join_xor','compute');
  link('top.din','left.din',8,'data','输入数据');link('top.din','right.din',8,'data','输入数据');link('left.dout','merge.a',8,'data','加一结果');link('right.dout','merge.b',8,'data','取反结果');link('merge.result','top.dout',8,'data','汇合结果');
  reading.mainPath=['left','merge'];reading.parallel=[{id:'branches',label:'两个组合分支',nodes:['left','right']}];
 }
 if(id==='arbiter'){
  node('client_a','使用方 A','gated_client');node('client_b','使用方 B','gated_client');node('choose','A 优先仲裁','priority_grant','controller');node('merge','选中数据汇合','merge_or','compute');
  for(const [c,suffix] of [['client_a','a'],['client_b','b']]){
   link(`top.req_${suffix}`,`${c}.request`,1,'request',`${suffix.toUpperCase()} 请求`);link(`top.${suffix}`,`${c}.din`,8,'data',`${suffix.toUpperCase()} 数据`);
   link(`${c}.req`,`choose.req_${suffix}`,1,'request',`${suffix.toUpperCase()} 待选`);link(`choose.grant_${suffix}`,`${c}.grant`,1,'control',`${suffix.toUpperCase()} 授权`);link(`${c}.selected`,`merge.${suffix}`,8,'data',`${suffix.toUpperCase()} 已选数据`);
  }
  link('merge.dout','top.dout',8,'data','选中结果');reading.mainPath=['client_a','merge'];reading.control=['choose'];reading.parallel=[{id:'clients',label:'两个使用方',nodes:['client_a','client_b']}];reading.feedback=[{from:'choose',to:'client_b',side:'top'}];reading.reason='两个使用方并排；较远的 B 授权经外侧绕过 A，A 授权就近连接。依据 RTL 请求/授权关系，不表示寄存反馈。';
 }
 if(id==='shared_ram'){
  node('reader_a','读者 A','reader');node('reader_b','读者 B','reader');node('store','双读口存储','dual_read_ram','memory',true);
  for(const suffix of ['a','b']){
   link(`top.addr_${suffix}`,`reader_${suffix}.addr`,4,'request',`${suffix.toUpperCase()} 地址`);link(`reader_${suffix}.request`,`store.${suffix}_addr`,4,'request',`${suffix.toUpperCase()} 读地址`);link(`store.${suffix}_data`,`reader_${suffix}.response`,8,'response',`${suffix.toUpperCase()} 读返回`);link(`reader_${suffix}.result`,`top.out_${suffix}`,8,'data',`${suffix.toUpperCase()} 结果`);
  }
  domain('store');link('top.we','store.we',1,'control','写使能');link('top.wa','store.wa',4,'request','写地址');link('top.wd','store.wd',8,'data','写数据');reading.mainPath=['reader_a'];reading.parallel=[{id:'readers',label:'两个读端',nodes:['reader_a','reader_b']}];reading.shared=[{node:'store',clients:['reader_a','reader_b']}];
 }
 if(id==='accumulator'){
  input('din',8,'data','本次增量');input('enable',1,'control','累加使能');input('rst',1,'clock_reset','复位');input('clk',1,'clock_reset','时钟');
  model.localSignals!.push({id:'sum',scope:'top',evidenceIds:['rtl'],name:'旧值加增量',width:8,description:'源码 wire sum = q + din，8 位截断。',driver:{kind:'comb',value:{kind:'operator',operator:'+',operands:[ref('local.q'),ref('top.din')]}}},
   {id:'q',scope:'top',evidenceIds:['rtl'],name:'累加寄存器',width:8,description:'同步复位，enable 时装入 sum，否则保持；本样例仅记录输入集合。',driver:{kind:'register',inputs:['top.rst','top.enable','local.sum'].map(endpoint),sourceText:"if (rst) q <= '0; else if (enable) q <= sum;"}});
  link('local.q','top.q',8,'data','累加值');reading.mainPath=[local('sum'),local('q')];reading.feedback=[{from:local('q'),to:local('sum'),side:'bottom'}];
 }
 if(id==='fifo'){
  for(const [name,width,category,label] of [['s_data',8,'data','输入数据'],['s_valid',1,'control','输入有效'],['m_ready',1,'control','下游可接收'],['rst',1,'clock_reset','复位'],['clk',1,'clock_reset','时钟']] as const)input(name,width,category,label);
  const not=(s:string)=>({kind:'operator' as const,operator:'!' as const,operands:[ref(s)]});
  model.localSignals!.push({id:'accept',scope:'top',evidenceIds:['rtl'],name:'槽空闲或本拍消费',width:1,description:'复位释放且为空或下游 ready。',driver:{kind:'comb',value:{kind:'operator',operator:'&&',operands:[not('top.rst'),{kind:'operator',operator:'||',operands:[not('local.full'),ref('top.m_ready')]}]}}},
   {id:'full',scope:'top',evidenceIds:['rtl'],name:'槽占用状态',width:1,description:'复位清零；accept 时采样 s_valid；本样例未精确记录规则。',driver:{kind:'register',inputs:['top.rst','local.accept','top.s_valid'].map(endpoint),sourceText:"if (rst) full <= 1'b0; else if (accept) full <= s_valid;"}},
   {id:'data_q',scope:'top',evidenceIds:['rtl'],name:'槽数据寄存器',width:8,description:'复位清零；accept && s_valid 时采样 s_data；否则保持。',driver:{kind:'register',inputs:['top.rst','local.accept','top.s_valid','top.s_data'].map(endpoint),sourceText:"if (rst) data_q <= '0; else if (accept && s_valid) data_q <= s_data;"}},
   {id:'visible',scope:'top',evidenceIds:['rtl'],name:'对外有效',width:1,description:'m_valid 的派生表达式节点，复位期间屏蔽 full；不是新 RTL 网络。',driver:{kind:'comb',value:{kind:'operator',operator:'&&',operands:[not('top.rst'),ref('local.full')]}}});
  link('local.accept','top.s_ready',1,'control','输入可接收');link('local.visible','top.m_valid',1,'control','输出有效');link('local.data_q','top.m_data',8,'data','输出数据');
  reading.mainPath=[local('accept'),local('data_q')];reading.parallel=[{id:'slot',label:'同一槽的状态',nodes:[local('data_q'),local('full')]}];reading.feedback=[{from:local('full'),to:local('accept'),side:'bottom'}];
 }
 const source=await readFile(new URL(`../examples/architecture-patterns/rtl/${id}.sv`,import.meta.url),'utf8'),digest=createHash('sha256').update(source).digest('hex');
 model.provenance={origin:'as_built',fidelity:'partial',scope:'手工核对的顶层实例、端口和所列内部状态；不是自动 RTL 行为提取。',sourceDigest:digest,configuration:'固定 8 位数据；shared_ram 为 16×8 位',coverage:{elaboratedInstances:null,representedInstances:model.modules.length},evidence:[{id:'rtl',file:`rtl/${id}.sv`,fileHash:digest,sourceKind:'code',targets:model.modules.map(m=>({kind:'module' as const,moduleId:m.id}))}],findings:[{id:'boundary',classification:'unknown',moduleIds:['top'],text:'未完整表达状态更新、存储内容、仲裁时序及验收义务；保留 partial。',evidenceIds:['rtl']}],unsupportedStructures:[],verification:[]};
 const parsed=modelSchema.parse(model);reading.modelHash=modelHash(parsed);
 return {id,title,model:parsed,reading,source,localNetBindings:(id==='fifo'?{visible:'m_valid'}:{}) as Record<string,string>,question:{pipeline:'输入经过几个真实寄存级？',fork_join:'两条分支在哪里汇合？',arbiter:'A、B 同时请求时谁获得授权？',shared_ram:'两个读者是否共用同一个存储实例？',accumulator:'本次加法的旧值来自哪里？',fifo:'下游阻塞时什么状态阻止覆盖已有数据？'}[id]};
}
