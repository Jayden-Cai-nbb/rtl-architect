// Synthetic architecture fixtures: no project RTL or behavioral verification is implied.
import type {Model,Module,Interface} from '../src/core/schema';
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
