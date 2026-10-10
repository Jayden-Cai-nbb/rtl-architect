import type { Model, Module, Interface } from './schema';
import { integerExpression, expressionReferences } from './expressions';
export const instanceCount=(module:Module)=>module.instances?module.instances.to-module.instances.from+1:1;
export const physicalInstanceCount=(model:Model)=>model.modules.reduce((n,m)=>n+instanceCount(m),0);
export function parameterValue(model:Model, module:Module, key:string, index?:number, visiting=new Set<string>()):number|string|boolean {
 const token=`${module.id}/${index??''}/${key}`;if(visiting.has(token))throw new Error(`参数依赖环: ${token}`);visiting.add(token);
 try {
  if(module.instances&&index!==undefined&&key===module.instances.indexVariable)return index;
  const override=index===undefined?undefined:module.instances?.overrides?.[String(index)];
  if(override&&Object.hasOwn(override,key))return override[key];
  const binding=module.parameterBindings?.[key];
  if(binding){const scope=binding.scope==='self'?module:model.modules.find(m=>m.id===module.parent);if(!scope)throw new Error('参数绑定没有父作用域');
   if('reference'in binding){const value=parameterValue(model,scope,binding.reference,scope.id===module.id?index:undefined,visiting);if(typeof value!==binding.type||typeof module.parameters[key]!==binding.type)throw new Error(`参数 ${module.id}.${key} 的引用类型与声明不一致`);return value;}
   return integerExpression(binding.expression,name=>{const value=parameterValue(model,scope,name,scope.id===module.id?index:undefined,visiting);if(typeof value!=='number')throw new Error(`${name} 不是数值参数`);return value});}
  if(!Object.hasOwn(module.parameters,key))throw new Error(`未知参数 ${module.id}.${key}`);return module.parameters[key];
 }finally{visiting.delete(token)}
}
export function widthValue(model:Model,module:Module,width:Interface['width'],index?:number):number {
 const value=typeof width==='number'?width:'param'in width?parameterValue(model,module,width.param,index):integerExpression(width.expr,name=>{const v=parameterValue(model,module,name,index);if(typeof v!=='number')throw new Error(`${name} 不是数值参数`);return v});
 if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>65536)throw new Error('位宽须为1..65536');return value;
}
export function bindingText(binding:NonNullable<Module['parameterBindings']>[string]):string {
 return `${binding.scope}: ${'reference'in binding?`${binding.reference} (${binding.type})`:binding.expression}`;
}
export function parameterReport(model:Model,module:Module,index?:number){
 const users=(owner:string,key:string)=>model.modules.flatMap(m=>Object.entries(m.parameterBindings??{}).filter(([,b])=>{
  if((b.scope==='self'?m.id:m.parent)!==owner)return false;
  if('reference'in b)return b.reference===key;
  try{return expressionReferences(b.expression).includes(key)}catch{return false}
 }).map(([key])=>({module:m,key})));
 return Object.keys(module.parameters).map(key=>{
  let value:number|string|boolean|undefined,error:string|undefined;try{value=parameterValue(model,module,key,index)}catch(e){error=String(e)}
  const root=`${module.id}.${key}`,paths:string[][]=[];
  const visit=(owner:string,key:string,path:string[])=>{for(const next of users(owner,key)){const token=`${next.module.id}.${next.key}`;if(path.includes(token))continue;const branch=[...path,token];paths.push(branch);visit(next.module.id,next.key,branch)}};
  visit(module.id,key,[root]);
  const override=index!==undefined&&Object.hasOwn(module.instances?.overrides?.[String(index)]??{},key);
  const binding=module.parameterBindings?.[key];
  return {key,declared:module.parameters[key],binding,value,error,source:override?'element_override':binding?'binding':'default',propagatesTo:users(module.id,key).map(u=>`${u.module.id}.${u.key}`),paths};
 });
}
