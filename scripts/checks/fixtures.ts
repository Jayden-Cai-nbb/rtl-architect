import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { modelHash } from '../../src/core/export';
import { type Endpoint, type Interface, type Model, modelSchema, type Module, type ScopeLayout } from '../../src/core/schema';

// Hand-mapped, source-backed RTL reading fixtures. This is not an RTL inference frontend.




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
 const source=await readFile(new URL(`../../examples/architecture-patterns/rtl/${id}.sv`,import.meta.url),'utf8'),digest=createHash('sha256').update(source).digest('hex');
 model.provenance={origin:'as_built',fidelity:'partial',scope:'手工核对的顶层实例、端口和所列内部状态；不是自动 RTL 行为提取。',sourceDigest:digest,configuration:'固定 8 位数据；shared_ram 为 16×8 位',coverage:{elaboratedInstances:null,representedInstances:model.modules.length},evidence:[{id:'rtl',file:`rtl/${id}.sv`,fileHash:digest,sourceKind:'code',targets:model.modules.map(m=>({kind:'module' as const,moduleId:m.id}))}],findings:[{id:'boundary',classification:'unknown',moduleIds:['top'],text:'未完整表达状态更新、存储内容、仲裁时序及验收义务；保留 partial。',evidenceIds:['rtl']}],unsupportedStructures:[],verification:[]};
 const parsed=modelSchema.parse(model);reading.modelHash=modelHash(parsed);
 return {id,title,model:parsed,reading,source,localNetBindings:(id==='fifo'?{visible:'m_valid'}:{}) as Record<string,string>,question:{pipeline:'输入经过几个真实寄存级？',fork_join:'两条分支在哪里汇合？',arbiter:'A、B 同时请求时谁获得授权？',shared_ram:'两个读者是否共用同一个存储实例？',accumulator:'本次加法的旧值来自哪里？',fifo:'下游阻塞时什么状态阻止覆盖已有数据？'}[id]};
}

// Synthetic architecture fixtures: no project RTL or behavioral verification is implied.

export function autoReadingFixture(shape: 'pipeline'|'fork'|'controlled'|'ring'|'mixed'|'unknown'|'shared'|'inline'|'nested'): Model {
  const model: Model = {schemaVersion:3,design:{id:shape,name:`自动阅读布局 · ${shape}`,top:'top'},clocks:[],resets:[],modules:[],connections:[]};
  function node(id:string,name:string,kind:Module['kind']='module',parent:string|null='top') {
    const n:Module={id,name,parent,kind,rtlModule:id,clock:null,reset:null,timing:'combinational',parameters:{},interfaces:[],interfaceGroups:[],contract:{responsibility:`合成展示样例中的${name}；用于检查布局，不代表已验证 RTL。`,latencyMinCycles:0,latencyCondition:'未验证',backpressure:'未验证',resetBehavior:'未验证',invariants:[],verificationPlan:[],openQuestions:['该模型仅用于工具维护，不用于实现交接。']}};
    model.modules.push(n); return n;
  }
  const top=node('top','结构与连接', 'subsystem',null);
  type Category=NonNullable<Module['interfaceGroups']>[number]['category'];
  function link(id:string,a:Module,b:Module,category?:Category,label?:string,from=id,to=id) {
    const group=category?`${category}_${id}`:undefined;
    for(const [n,port,role] of [[a,from,a===top?'consumer':'producer'],[b,to,b===top?'producer':'consumer']] as const) {
      if(!n.interfaces.some(p=>p.id===port))n.interfaces.push({id:port,role,protocol:'signal',width:1,required:false,...(group?{group}:{})} as Interface);
      if(group&&!n.interfaceGroups!.some(g=>g.id===group))n.interfaceGroups!.push({id:group,category:category!,label:label??id,description:'样例显式声明的用途'});
    }
    model.connections.push({id,scope:'top',from:{moduleId:a.id,interfaceId:from},to:{moduleId:b.id,interfaceId:to}});
  }
  const input=node('input','输入接收'),work=node('work','共享运算','compute'),output=node('output','结果输出');
  link('input_data',top,input,shape==='unknown'?undefined:'data','输入数据');
  if(shape==='fork') {
    const branch=node('branch','并行运算','compute');
    link('left',input,work,'data','左支数据');link('right',input,branch,'data','右支数据');
    link('left_result',work,output,'data','左支结果');link('right_result',branch,output,'data','右支结果');
  } else {link('samples',input,work,shape==='pipeline'||shape==='unknown'?undefined:'data','待处理数据');link('result',work,output,shape==='pipeline'||shape==='unknown'?undefined:'data','计算结果');}
  link('output_data',output,top,shape==='unknown'?undefined:'data','输出数据');
  if(['controlled','mixed','shared','nested'].includes(shape)) {
    const ctrl=node('scheduler','任务控制','controller'),mem=node('store','局部状态','memory');
    link('start',top,ctrl,'request','任务请求');link('dispatch',ctrl,work,'control','启动运算');link('done',work,ctrl,'response','运算完成');
    link('load',ctrl,input,'control','输入使能');link('drain',ctrl,output,'control','发布结果');
    link('read',work,mem,'request','存储请求');link('readback',mem,work,'response','存储返回');
    if(shape==='shared'){link('other_read',output,mem,'request','另一使用者请求');link('other_return',mem,output,'response','另一使用者返回');}
    if(shape==='mixed')link('payload',input,ctrl,'data','控制器处理的数据');
  }
  if(shape==='ring')link('feedback',output,input,undefined,undefined,'feedback','feedback');
  if(shape==='unknown') {
    work.name='controller_memory_clk'; // A suggestive name is deliberately not a kind/category declaration.
    link('clk',input,work);link('rst_n',input,work);link('config',input,work);node('unused','无连接实例');
  }
  if(shape==='inline')work.kind='memory';
  if(shape==='nested'){const root=node('root','多层结构','subsystem',null);top.parent=root.id;model.design.top=root.id;}
  return model;
}

export function feedbackFixture():Model{
 const contract={responsibility:'处理一笔带状态的事务',latencyMinCycles:0,latencyCondition:'按真实寄存边界解释',backpressure:'按使能保持',resetBehavior:'同步清除有效状态',invariants:[],verificationPlan:[],openQuestions:[]};
 const model:Model={schemaVersion:3,design:{id:'state_pipeline',name:'状态边界与反馈检查',top:'top'},clocks:[{id:'clk',edge:'rising'}],resets:[{id:'rst',clock:'clk',activeLevel:'high',synchronous:true}],modules:[{id:'top',name:'状态处理',parent:null,kind:'subsystem',rtlModule:'pipeline',clock:'clk',reset:'rst',timing:'sequential',parameters:{},interfaces:[],contract}],connections:[],localSignals:[]};
 for(let i=0;i<5;i++){
  model.modules.push({id:`unit${i}`,name:`处理 ${i}`,parent:'top',kind:'compute',rtlModule:'stage',clock:'clk',reset:'rst',timing:'sequential',parameters:{},interfaces:[{id:'din',role:'consumer',protocol:'signal',width:32,required:false},{id:'dout',role:'producer',protocol:'signal',width:32,required:false}],contract});
  if(i<4){model.localSignals!.push({id:`state${i}`,scope:'top',name:`状态 ${i}`,width:32,description:'源代码中的流水寄存状态；不是 RTL 实例',evidenceIds:[],driver:{kind:'register',inputs:[{moduleId:`unit${i}`,interfaceId:'dout'},...(i?[{moduleId:'top',interfaceId:`state${i-1}`,local:true as const}]:[])],sourceText:'enabled state update; fixture'}});model.connections.push({id:`state_to_${i+1}`,scope:'top',from:{moduleId:'top',interfaceId:`state${i}`,local:true},to:{moduleId:`unit${i+1}`,interfaceId:'din'}});}
 }
 model.localSignals!.push({id:'feedback',scope:'top',name:'返回选择',width:32,description:'按位或；重复读取相同端点应仅绘制一次依赖',evidenceIds:[],driver:{kind:'comb',value:{kind:'operator',operator:'|',operands:[{kind:'endpoint',endpoint:{moduleId:'top',interfaceId:'state3',local:true}},{kind:'endpoint',endpoint:{moduleId:'top',interfaceId:'state3',local:true}}]}}});
 model.connections.push({id:'feedback_to_first',scope:'top',from:{moduleId:'top',interfaceId:'feedback',local:true},to:{moduleId:'unit0',interfaceId:'din'}});
 return model;
}
export function feedbackReading(model:Model){return {modelHash:modelHash(model),reason:'独立展示分区与真实状态交替；不改变实例',mainPath:['unit0','local:top:state0','unit1','local:top:state1','unit2','local:top:state2','unit3','local:top:state3','unit4'],control:[],adjacent:[],stages:[{id:'input',label:'接收',nodes:['unit0','local:top:state0']},{id:'process',label:'处理',nodes:['unit1','local:top:state1','unit2','local:top:state2']},{id:'output',label:'完成',nodes:['unit3','local:top:state3','unit4']} ]};}

// Fixed scale and explicit expectations; no generated evidence is a real RTL result.

const contract={responsibility:'按使能接收数据，完成当前模块约定的处理。',latencyMinCycles:0,latencyCondition:'由当前实现决定，尚未实测。',backpressure:'输入不能接收时保持上游数据。',resetBehavior:'控制寄存器同步复位。',invariants:['端口位宽与连线一致。'],verificationPlan:['核对输入输出及复位行为。'],openQuestions:[]};
const module=(id:string,parent:string|null,kind:Module['kind']='module'):Module=>({id,name:id,parent,kind,rtlModule:id,clock:'clk',reset:'rst_n',parameters:{},interfaces:[],contract:structuredClone(contract)});
export function reviewFixture():Model{
 const top=module('top',null,'subsystem'),mem=module('mem','top','subsystem'),pro=module('pro','top','subsystem'),config=module('config','top');
 top.parameters={ROM_FILE:'data/rom.hex',UNUSED:8};pro.parameters={INIT_FILE:'default.hex'};pro.parameterBindings={INIT_FILE:{scope:'parent',reference:'ROM_FILE',type:'string'}};
 top.interfaceGroups=[{id:'llr',label:'LLR配置',category:'configuration',description:'把同用途的32个原始配置输入放在一起，便于查看。'}];
 for(let i=0;i<32;i++)top.interfaces.push({id:`llr_${i}`,role:'consumer',protocol:'signal',width:8,required:false,group:'llr'});
 const modules:Module[]=[top,mem,pro,config,...Array.from({length:31},(_,i)=>module(`control_${i}`,i%2?'mem':'pro'))];
 for(let i=0;i<7;i++){
  const array=module(`lane_${i}`,'pro');array.parameters={DATA_W:30,ROM_FILE:'default.hex'};array.parameterBindings={ROM_FILE:{scope:'parent',reference:'INIT_FILE',type:'string'}};
  array.instances={indexVariable:'z',from:0,to:255,sourcePath:`top.pro.g[{z}].lane_${i}`};
  // Nine independent ports × seven arrays × 256 elements = 16,128 missing endpoint diagnostics.
  for(let port=0;port<9;port++){
   array.interfaces.push({id:`in_${port}`,role:'consumer',protocol:'signal',width:30,required:true});
   pro.interfaces.push({id:`packed_${i}_${port}`,role:'consumer',protocol:'signal',width:7680,required:false});
  }
  modules.push(array);
 }
 return {schemaVersion:3,design:{id:'review_fixture',name:'数组与审阅回归样例',top:'top'},clocks:[{id:'clk',edge:'rising'}],resets:[{id:'rst_n',clock:'clk',synchronous:true,activeLevel:'low'}],modules,connections:[],provenance:{origin:'as_built',fidelity:'partial',scope:'固定的工具检查样例；不对应用户 RTL',configuration:'7组256元素、35个普通实例',sourceDigest:'a'.repeat(64),coverage:{elaboratedInstances:1827,representedInstances:1827},evidence:[{id:'fixture',file:'fixture.txt',fileHash:'b'.repeat(64),sourceKind:'report',targets:[{kind:'module',moduleId:'lane_0'}]}],findings:[{id:'unknown',classification:'unknown',moduleIds:['lane_0'],text:'该行为尚未核对。',evidenceIds:['fixture']}],unsupportedStructures:[{id:'import_gap',kind:'connection',category:'not_imported',moduleIds:['lane_0'],description:'lane_0 的数据端口尚未导入。',evidenceIds:['fixture'],targets:[{kind:'module',moduleId:'lane_0'}],causes:[{issueCodes:['REQUIRED_UNCONNECTED'],moduleId:'lane_0',interfaceId:'in_0',scope:'pro',indices:{from:0,to:255},bits:{lsb:0,msb:29}}]}],verification:[]}};
}
export function mappedFixture(){
 const model=reviewFixture();
 for(let i=0;i<5;i++)for(let port=0;port<9;port++)model.connections.push({id:`map_${i}_${port}`,scope:'pro',from:{moduleId:'pro',interfaceId:`packed_${i}_${port}`,sliceMapping:{arrayModuleId:`lane_${i}`,stride:30,offset:0,width:30}},to:{moduleId:`lane_${i}`,interfaceId:`in_${port}`,index:'all'}});
 return model;
}
