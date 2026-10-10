// Fixed scale and explicit expectations; no generated evidence is a real RTL result.
import type {Model,Module} from '../src/core/schema';
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
