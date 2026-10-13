import type {Model} from '../src/core/schema';
import {modelHash} from '../src/core/export';
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
