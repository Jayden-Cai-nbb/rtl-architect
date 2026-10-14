/** Bounded, canonical two-state Boolean functions. No HDL parsing or reachability assumptions. */
export class BitFunctions {
 private nodes=[{v:Infinity,lo:0,hi:0},{v:Infinity,lo:1,hi:1}];
 private unique=new Map<string,number>(); private cache=new Map<string,number>(); private work=0;
 constructor(private limit=50000,private workLimit=500000){}
 private node(v:number,lo:number,hi:number):number {
  if(lo===hi)return lo;
  const key=`${v}/${lo}/${hi}`,old=this.unique.get(key);if(old!==undefined)return old;
  if(this.nodes.length>=this.limit)throw Error('布尔函数节点超过预算');
  const id=this.nodes.length;this.nodes.push({v,lo,hi});this.unique.set(key,id);return id;
 }
 variable(v:number){return this.node(v,0,1);}
 apply(op:'and'|'or'|'xor',a:number,b:number):number {
  if(++this.work>this.workLimit)throw Error('布尔函数计算超过预算');
  if(a>b)[a,b]=[b,a];
  if(op==='and'&&(a===0||a===1||a===b))return a===0?0:b;
  if(op==='or'&&(a===0||a===1||a===b))return a===1?1:b;
  if(op==='xor'&&(a===0||a===b))return a===b?0:b;
  if(a<2&&b<2)return op==='and'?a&b:op==='or'?a|b:a^b;
  const key=`${op}/${a}/${b}`,old=this.cache.get(key);if(old!==undefined)return old;
  const x=this.nodes[a],y=this.nodes[b],v=Math.min(x.v,y.v);
  const result=this.node(v,this.apply(op,x.v===v?x.lo:a,y.v===v?y.lo:b),this.apply(op,x.v===v?x.hi:a,y.v===v?y.hi:b));
  this.cache.set(key,result);return result;
 }
 not(a:number){return this.apply('xor',a,1);}
 mux(s:number,a:number,b:number){return this.apply('or',this.apply('and',s,b),this.apply('and',this.not(s),a));}
 truth(a:number[]){return a.reduce((r,x)=>this.apply('or',r,x),0);}
 resize(a:number[],width:number,signed=false){if(width<1||width>256||!a.length)throw Error('只支持 1..256 位向量');return Array.from({length:width},(_,i)=>a[i]??(signed?a.at(-1)!:0));}
 constant(width:number,value:bigint){return this.resize([0],width).map((_,i)=>Number(value>>BigInt(i)&1n));}
 vectorMux(s:number,a:number[],b:number[]){if(a.length!==b.length)throw Error('选择器宽度不一致');return a.map((x,i)=>this.mux(s,x,b[i]));}
 shift(a:number[],amount:number[],direction:'left'|'right',arithmetic=false){
  // Saturate distances before exponentiation; a large shift amount never allocates a large vector.
  let out=[...a];const fill=arithmetic&&direction==='right'?a.at(-1)!:0;
  for(let i=0;i<amount.length;i++){
   const distance=i<9?Math.min(2**i,a.length):a.length;
   const shifted=out.map((_,j)=>out[direction==='left'?j-distance:j+distance]??fill);
   out=this.vectorMux(amount[i],out,shifted);
  }return out;
 }
 add(a:number[],b:number[],subtract=false){
  if(a.length!==b.length)throw Error('算术宽度不一致');let carry=subtract?1:0;
  return a.map((x,i)=>{const y=subtract?this.not(b[i]):b[i],xy=this.apply('xor',x,y),sum=this.apply('xor',xy,carry);carry=this.apply('or',this.apply('and',x,y),this.apply('and',xy,carry));return sum;});
 }
 equal(a:number[],b:number[]){if(a.length!==b.length)throw Error('比较宽度不一致');return this.not(this.truth(a.map((x,i)=>this.apply('xor',x,b[i]))));}
 less(a:number[],b:number[],signed=false){
  if(a.length!==b.length)throw Error('比较宽度不一致');let result=0;
  for(let i=0;i<a.length;i++){const x=signed&&i===a.length-1?this.not(a[i]):a[i],y=signed&&i===b.length-1?this.not(b[i]):b[i];result=this.mux(this.apply('xor',x,y),result,this.apply('and',this.not(x),y));}return result;
 }
 witness(root:number){
  if(root===0)return null;const values=new Map<number,number>();
  while(root>1){const n=this.nodes[root],hi=n.lo===0;values.set(n.v,hi?1:0);root=hi?n.hi:n.lo;}return values;
 }
 evaluate(root:number,values:Map<number,number>):number {while(root>1){const n=this.nodes[root];root=values.get(n.v)?n.hi:n.lo;}return root;}
 value(bits:number[],values:Map<number,number>){return '0x'+bits.reduce((v,b,i)=>v|(BigInt(this.evaluate(b,values))<<BigInt(i)),0n).toString(16);}
 get metrics(){return {nodes:this.nodes.length,operations:this.work};}
}
