import type {Endpoint,Model,SignalValue} from './schema';
import {resolveEndpoint} from './endpoints';
import {widthValue} from './parameters';
import {endpointLabel,localSignalAnalysis,signalChildren} from './signals';
import {BitFunctions} from './bitFunctions';

export type Bit=number|'0'|'1'|'x'|'z';
export type Cell={type:string;parameters:Record<string,string|number>;attributes:Record<string,string|number>;connections:Record<string,Bit[]>;port_directions?:Record<string,string>};
export type Definition={attributes:Record<string,string|number>;ports:Record<string,{direction:string;bits:Bit[]}>;cells:Record<string,Cell>;netnames:Record<string,{bits:Bit[];attributes:Record<string,string|number>;hide_name?:number}>;processes?:Record<string,unknown>};
export type StateMapping={moduleId:string;localSignalId:string;state:string;clock:string;signals:{endpoint:Endpoint;pin:string}[]};
const same=(a:Bit[]|undefined,b:Bit[]|undefined)=>!!a&&!!b&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const param=(c:Cell,key:string)=>{const v=c.parameters[key];if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)return v;if(typeof v==='string'&&/^[01]{1,32}$/.test(v))return Number(BigInt('0b'+v));throw Error(`缺少明确参数 ${c.type}.${key}`);};
const source=(c:Cell)=>typeof c.attributes.src==='string'?c.attributes.src:null;
// A user module with an output named Q is not evidence of a register.
const stateTypes=new Set(['$dff','$dffe','$dffsr','$dffsre','$adff','$adffe','$aldff','$aldffe','$sdff','$sdffe','$sdffce','$dlatch','$adlatch','$dlatchsr','$sr','$ff']);
const stateCells=(d:Definition)=>Object.entries(d.cells).filter(([,c])=>c.connections.Q!==undefined&&(stateTypes.has(c.type)||/^\$_(?:DFF|SDFF|DLATCH|SR)_/.test(c.type)));
export function stateInventory(def:Definition){return stateCells(def).map(([cell,c])=>({cell,type:c.type,width:c.connections.Q.length,aliases:Object.entries(def.netnames).filter(([,n])=>!n.hide_name&&same(n.bits,c.connections.Q)).map(([n])=>n),source:source(c)}));}

/** Interpret only explicitly supported post-proc cells; never turn a missing driver into a free input. */
class Network {
 readonly functions=new BitFunctions();
 private drivers=new Map<number,{name:string;port:string;index:number}[]>();
 private inputs=new Set<number>();private registers=new Map<number,string>();private memo=new Map<string,number[]>();private visiting=new Set<string>();
 readonly used=new Set<string>();readonly leaves=new Set<number>();
 readonly state:Cell;
 constructor(readonly def:Definition,readonly name:string){
  if(Object.keys(def.cells).length>10000||Object.keys(def.netnames).length>20000)throw Error('展开作用域超过预算，请选择较小子层级');
  if(Object.keys(def.processes??{}).length)throw Error('仍有未执行 proc 的过程');
  if(def.attributes.blackbox&&String(def.attributes.blackbox).includes('1'))throw Error('黑盒没有状态实现');
  this.state=def.cells[name];if(!this.state||this.state.type!=='$dff')throw Error(`暂不支持状态单元 ${this.state?.type??name}；保留真实行为，使用对应仿真或专用验证`);
  const q=this.state.connections.Q,d=this.state.connections.D,clk=this.state.connections.CLK;
  if(!q||!d||!clk||clk.length!==1||q.length!==d.length||q.length!==param(this.state,'WIDTH')||q.length<1||q.length>256||q.some(b=>typeof b!=='number')||new Set(q).size!==q.length)throw Error('状态必须是单个完整的 1..256 位同步 $dff');
  if(![0,1].includes(param(this.state,'CLK_POLARITY')))throw Error('时钟有效沿未知');
  for(const p of Object.values(def.ports))if(p.direction==='input')for(const bit of p.bits){if(typeof bit!=='number'||this.inputs.has(bit))throw Error('输入位存在常量或别名；无法独立比较');this.inputs.add(bit);}
  for(const [n,c] of Object.entries(def.cells)){
   if(!c.port_directions)throw Error('单元缺少端口方向：'+n);
   for(const [p,bits] of Object.entries(c.connections)){
    if(!c.port_directions[p]||c.port_directions[p]==='inout')throw Error('单元端口方向未知或双向：'+n+'.'+p);
    if(c.port_directions[p]==='output')bits.forEach((bit,index)=>{if(typeof bit==='number'){const list=this.drivers.get(bit)??[];list.push({name:n,port:p,index});this.drivers.set(bit,list);}});
   }
   if(c.type==='$dff')for(const b of c.connections.Q??[])if(typeof b==='number')this.registers.set(b,n);
  }
  if(typeof clk[0]!=='number'||!this.inputs.has(clk[0])||this.drivers.has(clk[0]))throw Error('仅支持直接来自本作用域输入的单一时钟');
 }
 pin(name:string){const n=this.def.netnames[name]??this.def.ports[name];if(!n?.bits.length)throw Error('RTL 信号不存在：'+name);return n.bits;}
 private vector(bits:Bit[],depth=0):number[]{if(!bits.length||bits.length>256)throw Error('向量超出 1..256 位预算');return bits.map(b=>this.bit(b,depth));}
 private bit(bit:Bit,depth:number):number {
  if(depth>128)throw Error('状态逻辑深度超过预算');
  if(bit==='x'||bit==='z')throw Error('更新逻辑含 X/Z；二态比较无法判断');
  if(typeof bit==='string')return Number(bit);
  const drivers=this.drivers.get(bit)??[];
  if(drivers.length>1||this.inputs.has(bit)&&drivers.length)throw Error('信号有多个驱动：bit '+bit);
  if(this.inputs.has(bit)){this.leaves.add(bit);return this.functions.variable(bit);}
  const reg=this.registers.get(bit);
  if(reg){const c=this.def.cells[reg];if(!same(c.connections.CLK,this.state.connections.CLK)||param(c,'CLK_POLARITY')!==param(this.state,'CLK_POLARITY'))throw Error('状态依赖跨越不同或未知时钟');this.leaves.add(bit);return this.functions.variable(bit);}
  const driver=drivers[0];if(!driver)throw Error('信号未驱动：bit '+bit);
  if(driver.port!=='Y')throw Error('不支持的驱动端口：'+driver.name+'.'+driver.port);
  return this.cell(driver.name,depth+1)[driver.index];
 }
 private cell(name:string,depth:number):number[]{
  const cached=this.memo.get(name);if(cached)return cached;
  if(this.visiting.has(name))throw Error('状态输入存在组合环');
  if(this.used.size>=256)throw Error('状态输入逻辑超过 256 个单元预算');
  this.used.add(name);this.visiting.add(name);
  const c=this.def.cells[name],f=this.functions,p=c.connections;
  const get=(key:string)=>{if(!p[key])throw Error('缺少单元端口：'+name+'.'+key);return this.vector(p[key],depth);};
  const check=(key:string,n:number)=>{if(param(c,key)!==n)throw Error('单元位宽参数与连线不一致：'+name+'.'+key);};
  const flag=(key:string)=>{const n=param(c,key);if(n!==0&&n!==1)throw Error('无效符号参数');return n===1;};
  const width=p.Y?.length;if(!width||width>256)throw Error('单元输出宽度超出预算');
  let out:number[];
  if(c.type==='$mux'||c.type==='$pmux'){
   const a=get('A'),b=get('B'),s=get('S');check('WIDTH',width);if(a.length!==width)throw Error('MUX 输入宽度不符');
   if(c.type==='$mux'){if(b.length!==width||s.length!==1)throw Error('MUX 选择/数据宽度不符');out=f.vectorMux(s[0],a,b);}
   else {check('S_WIDTH',s.length);if(b.length!==width*s.length)throw Error('PMUX 宽度不符');let selected=0;out=a;for(let i=0;i<s.length;i++){if(f.apply('and',selected,s[i])!==0)throw Error('case 选择条件可能同时成立，PMUX 行为未知');selected=f.apply('or',selected,s[i]);out=f.vectorMux(s[i],out,b.slice(i*width,(i+1)*width));}}
  }else if(['$shl','$shr','$sshl','$sshr'].includes(c.type)){
   const a=get('A'),b=get('B');check('A_WIDTH',a.length);check('B_WIDTH',b.length);check('Y_WIDTH',width);
   if(flag('B_SIGNED'))throw Error('移位量的 B_SIGNED 必须为 0');
   const signed=flag('A_SIGNED'),x=f.resize(a,Math.max(a.length,width),signed);
   out=f.resize(f.shift(x,b,c.type==='$shl'||c.type==='$sshl'?'left':'right',c.type==='$sshr'&&signed),width);
  }else {
   const unary=['$not','$logic_not','$reduce_and','$reduce_or','$reduce_xor','$reduce_xnor','$reduce_bool','$pos'];
   const binary=['$and','$or','$xor','$xnor','$logic_and','$logic_or','$add','$sub','$eq','$ne','$lt','$le','$gt','$ge'];
   if(!unary.includes(c.type)&&!binary.includes(c.type))throw Error('未支持的状态运算：'+c.type);
   const a=get('A'),b=binary.includes(c.type)?get('B'):undefined;check('A_WIDTH',a.length);check('Y_WIDTH',width);if(b)check('B_WIDTH',b.length);
   const as=flag('A_SIGNED'),bs=b?flag('B_SIGNED'):false,signed=b?as&&bs:as;
   const comparison=['$eq','$ne','$lt','$le','$gt','$ge'].includes(c.type),w=comparison?Math.max(a.length,b!.length):width;
   const x=f.resize(a,w,signed),y=b?f.resize(b,w,signed):[];
   const pair=(op:'and'|'or'|'xor')=>x.map((v,i)=>f.apply(op,v,y[i]));
   switch(c.type){
    case '$pos':out=x;break;case '$not':out=x.map(v=>f.not(v));break;
    case '$and':out=pair('and');break;case '$or':out=pair('or');break;case '$xor':out=pair('xor');break;case '$xnor':out=pair('xor').map(v=>f.not(v));break;
    case '$add':out=f.add(x,y);break;case '$sub':out=f.add(x,y,true);break;
    case '$logic_not':out=[f.not(f.truth(a))];break;
    case '$reduce_and':out=[a.reduce((r,v)=>f.apply('and',r,v),1)];break;
    case '$reduce_xor':case '$reduce_xnor':{const n=a.reduce((r,v)=>f.apply('xor',r,v),0);out=[c.type==='$reduce_xnor'?f.not(n):n];break;}
    case '$reduce_or':case '$reduce_bool':out=[f.truth(a)];break;
    case '$logic_and':out=[f.apply('and',f.truth(a),f.truth(b!))];break;case '$logic_or':out=[f.apply('or',f.truth(a),f.truth(b!))];break;
    case '$eq':out=[f.equal(x,y)];break;case '$ne':out=[f.not(f.equal(x,y))];break;
    case '$lt':out=[f.less(x,y,signed)];break;case '$ge':out=[f.not(f.less(x,y,signed))];break;
    case '$gt':out=[f.less(y,x,signed)];break;case '$le':out=[f.not(f.less(y,x,signed))];break;
    default:throw Error('未支持的运算');
   }
   out=f.resize(out,width);
  }
  this.visiting.delete(name);this.memo.set(name,out);return out;
 }
 next(){return this.vector(this.state.connections.D);}
 private expression(){
  let calls=0,abbreviated=false;
  const text=(bits:Bit[],depth=0):string=>{
   if(!bits.length)return '?';
   if(++calls>256||depth>16){abbreviated=true;return '…';}
   if(bits.every(b=>b==='0'||b==='1'))return `${bits.length}'h${BigInt('0b'+[...bits].reverse().join('')).toString(16)}`;
   const pin=Object.entries(this.def.netnames).find(([,n])=>!n.hide_name&&same(n.bits,bits)&&bits.every(b=>typeof b==='number'&&(this.inputs.has(b)||this.registers.has(b))));if(pin)return pin[0];
   const driver=typeof bits[0]==='number'?this.drivers.get(bits[0])?.[0]:undefined,c=driver?this.def.cells[driver.name]:undefined;
   if(c&&same(c.connections.Y,bits)){
    if(c.type==='$mux')return `(${text(c.connections.S,depth+1)} ? ${text(c.connections.B,depth+1)} : ${text(c.connections.A,depth+1)})`;
    const op:Record<string,string>={$add:'+', $sub:'-', $and:'&', $or:'|', $xor:'^', $logic_and:'&&', $logic_or:'||', $eq:'==', $ne:'!=', $lt:'<', $le:'<=', $gt:'>', $ge:'>=', $shl:'<<', $shr:'>>', $sshl:'<<<', $sshr:'>>>'};
    const a=c.connections.A?text(c.connections.A,depth+1):'?';
    if(op[c.type])return `${c.type}[${bits.length}](${a} ${op[c.type]} ${text(c.connections.B,depth+1)})`;
    if(c.type==='$not'||c.type==='$logic_not')return `${c.type==='$not'?'~':'!'}(${a})`;
    return `${c.type}[${bits.length}](${Object.entries(c.connections).filter(([p])=>p!=='Y').map(([p,b])=>p+'='+text(b,depth+1)).join(', ')})`;
   }
   return `bits[${bits.join(',')}]`;
  };
  const value=text(this.state.connections.D);return {text:value.slice(0,4096),abbreviated:abbreviated||value.length>4096};
 }
 mapped(name:string,width:number){const bits=this.pin(name);if(bits.length!==width||new Set(bits).size!==bits.length||bits.some(b=>typeof b!=='number'||!this.inputs.has(b)&&!this.registers.has(b)))throw Error('映射必须是等宽的完整输入或同步状态：'+name);return this.vector(bits);}
 observation(){
  const cells=[...this.used].sort().map(name=>{const c=this.def.cells[name];return {name,type:c.type,source:source(c),parameters:c.parameters,connections:c.connections};});
  const aliases=stateInventory(this.def).find(s=>s.cell===this.name)!.aliases;
  const leafBits=[...this.leaves].sort((a,b)=>a-b);
  return {cell:this.name,aliases,width:this.state.connections.Q.length,source:source(this.state),clock:{bits:this.state.connections.CLK,edge:param(this.state,'CLK_POLARITY')===1?'rising':'falling'},stateBits:this.state.connections.Q,nextBits:this.state.connections.D,leafBits,cells,expression:this.expression(),bitOrder:'lsb_first' as const,domain:'two_state' as const};
 }
 witnessValues(values:Map<number,number>,stateName:string){
  const candidates=[...Object.entries(this.def.ports).filter(([,p])=>p.direction==='input').map(([name,p])=>({name,bits:p.bits,kind:'input' as const})),...stateInventory(this.def).filter(s=>s.type==='$dff').map(s=>({name:s.cell===this.name?stateName:s.aliases[0]??s.cell,bits:this.def.cells[s.cell].connections.Q,kind:'state' as const}))];
  return candidates.filter(p=>p.bits.some(b=>typeof b==='number'&&this.leaves.has(b))).map(p=>({signal:p.name,kind:p.kind,width:p.bits.length,value:'0x'+p.bits.reduce<bigint>((v,b,i)=>v|(BigInt(typeof b==='number'?values.get(b)??0:Number(b))<<BigInt(i)),0n).toString(16)}));
 }
}
export function observeState(def:Definition,cell:string){
 let n:Network|undefined;
 try{n=new Network(def,cell);n.next();return {status:'EXTRACTED' as const,reason:'已提取有限二态下一拍函数；未与设计声明比较',observed:n.observation(),metrics:n.functions.metrics};}
 catch(e){return {status:'UNKNOWN' as const,reason:e instanceof Error?e.message:String(e),observed:n?.observation(),metrics:n?.functions.metrics};}
}
export type StateComparison={status:'MATCH'|'MISMATCH'|'UNKNOWN';reason:string;observed?:ReturnType<Network['observation']>;metrics?:{nodes:number;operations:number};expectedWidth?:number;expectedEdge?:string;witness?:{inputs:{signal:string;kind:'input'|'state';width:number;value:string}[];expected:string;actual:string;reachable:'not_checked'}};
export function compareState(model:Model,def:Definition,mapping:StateMapping):StateComparison{
 let n:Network|undefined;
 try{
  const m=model.modules.find(m=>m.id===mapping.moduleId),local=model.localSignals?.find(l=>l.scope===mapping.moduleId&&l.id===mapping.localSignalId);
  if(!m||m.instances||!local||local.driver.kind!=='register'||!local.driver.update)throw Error('没有可比较的单实例 register.update 声明');
  const analysis=localSignalAnalysis(model,(scope,e)=>resolveEndpoint(model,scope,e));analysis.local(local.id);
  const bits=(def.netnames[mapping.state]??def.ports[mapping.state])?.bits,found=stateCells(def).filter(([,c])=>same(c.connections.Q,bits));
  if(found.length!==1)throw Error('状态映射不对应唯一完整寄存器：'+mapping.state);
  n=new Network(def,found[0][0]);const network=n,f=n.functions,actual=n.next(),observed=n.observation();
  const width=widthValue(model,m,local.width),clock=model.clocks.find(c=>c.id===m.clock);
  if(!clock||!same(n.pin(mapping.clock),n.state.connections.CLK))throw Error('缺少同一时钟的明确映射');
  if(width!==actual.length)return {status:'MISMATCH' as const,reason:'状态位宽不一致',observed,expectedWidth:width};
  if(clock.edge!==observed.clock.edge)return {status:'MISMATCH' as const,reason:'寄存器采样沿不一致',observed,expectedEdge:clock.edge};
  const bound=new Map<string,number[]>(),claimed=new Set<Bit>();
  const bind=(key:string,pin:string,w:number)=>{if(bound.has(key))throw Error('重复端点映射：'+key);const b=network.pin(pin);if(b.some(x=>claimed.has(x)))throw Error('映射存在重叠 RTL 位：'+pin);const value=network.mapped(pin,w);b.forEach(x=>claimed.add(x));bound.set(key,value);};
  bind(endpointLabel({moduleId:m.id,interfaceId:local.id,local:true}),mapping.state,width);
  for(const b of mapping.signals){const e=b.endpoint,r=resolveEndpoint(model,m.id,e);if(e.slice||e.sliceMapping||e.index!==undefined||!r||r.direction!=='source'||r.intf.protocol!=='signal'||!r.width)throw Error('映射须为完整单实例 signal source');if(e.local&&model.localSignals?.find(l=>l.id===e.interfaceId)?.driver.kind==='comb')throw Error('组合规则必须内联，不能用 RTL 引脚替换');bind(endpointLabel(e),b.pin,r.width);}
  let budget=0;
  const render=(v:SignalValue,depth=0):number[]=>{
   if(++budget>4000||depth>64)throw Error('设计表达式内联超过预算');
   if(v.kind==='constant')return f.constant(v.width,BigInt(v.value));
   if(v.kind==='endpoint'){
    const {slice,...e}=v.endpoint;if(e.index!==undefined||e.sliceMapping)throw Error('暂不支持数组端点');
    const l=e.local?model.localSignals?.find(l=>l.scope===m.id&&l.id===e.interfaceId):undefined;
    const b=l?.driver.kind==='comb'?render(l.driver.value,depth+1):bound.get(endpointLabel(e));if(!b)throw Error('缺少设计输入映射：'+endpointLabel(e));return slice?b.slice(slice.lsb,slice.msb+1):b;
   }
   const args=signalChildren(v).map(x=>render(x,depth+1));
   if(v.kind==='concat')return args.reverse().flat();
   if(v.kind==='cast')return f.resize(args[0],v.width,v.mode==='sign_extend');
   const [a,b,c]=args;
   const signed=analysis.value(m.id,v.operands[0]).signed;
   switch(v.operator){
    case 'mux':return f.vectorMux(a[0],c,b);case '~':return a.map(x=>f.not(x));case '!':return [f.not(f.truth(a))];
    case '&':case '|':case '^':return a.map((x,i)=>f.apply(v.operator==='&'?'and':v.operator==='|'?'or':'xor',x,b[i]));
    case '&&':case '||':return [f.apply(v.operator==='&&'?'and':'or',f.truth(a),f.truth(b))];
    case '+':case '-':return f.add(a,b,v.operator==='-');
    case '==':return [f.equal(a,b)];case '!=':return [f.not(f.equal(a,b))];
    case '<':return [f.less(a,b,signed)];case '>=':return [f.not(f.less(a,b,signed))];
    case '>':return [f.less(b,a,signed)];case '<=':return [f.not(f.less(b,a,signed))];
    case '<<':case '>>':case '>>>':return f.shift(a,b,v.operator==='<<'?'left':'right',v.operator==='>>>'&&signed);
    case 'reduce_and':return [a.reduce((r,x)=>f.apply('and',r,x),1)];
    case 'reduce_or':return [f.truth(a)];case 'reduce_xor':return [a.reduce((r,x)=>f.apply('xor',r,x),0)];
   }
  };
  const u=local.driver.update;let expected=bound.get(endpointLabel({moduleId:m.id,interfaceId:local.id,local:true}))!;
  for(const branch of [...u.branches].reverse())expected=f.vectorMux(render(branch.condition)[0],expected,render(branch.value));
  if(u.reset){const reset=render({kind:'endpoint',endpoint:u.reset.signal})[0];expected=f.vectorMux(u.reset.activeLevel==='high'?reset:f.not(reset),expected,render(u.reset.value));}
  const differs=f.not(f.equal(expected,actual)),values=f.witness(differs);
  return {status:values?'MISMATCH' as const:'MATCH' as const,reason:values?'存在使下一拍值不同的二态输入/旧状态组合；未判断该状态是否可达':'所有二态输入与旧状态组合下，映射寄存器的单步更新函数相同',observed,metrics:f.metrics,...(values?{witness:{inputs:n.witnessValues(values,mapping.state),expected:f.value(expected,values),actual:f.value(actual,values),reachable:'not_checked' as const}}:{})};
 }catch(e){return {status:'UNKNOWN' as const,reason:e instanceof Error?e.message:String(e),observed:n?.observation(),metrics:n?.functions.metrics};}
}
