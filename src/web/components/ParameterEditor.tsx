import type {Model,Module} from '../../core/schema';
import {bindingText,parameterReport} from '../../core/parameters';
type Bindings=NonNullable<Module['parameterBindings']>;
export function ParameterEditor({model,module,values,bindings,changeValues,changeBindings}:{model:Model;module:Module;values:Record<string,string>;bindings:Bindings;changeValues:(v:Record<string,string>)=>void;changeBindings:(v:Bindings)=>void}){
 const report=parameterReport(model,module,module.instances?.from);
 return <><h3>参数与传递关系</h3>{report.map(row=>{
  const binding=bindings[row.key],original=module.parameters[row.key],reference=binding&&'reference'in binding;
  const set=(b:Bindings[string]|undefined)=>{const next={...bindings};if(b)next[row.key]=b;else delete next[row.key];changeBindings(next)};
  return <section className="parameter-binding" key={row.key}><label>{row.key}{typeof original==='boolean'?<select disabled={!!binding} aria-label={row.key} value={values[row.key]} onChange={e=>changeValues({...values,[row.key]:e.target.value})}><option>true</option><option>false</option></select>:<input disabled={!!binding} aria-label={row.key} type={typeof original==='number'?'number':'text'} value={values[row.key]} onChange={e=>changeValues({...values,[row.key]:e.target.value})}/>}</label>
   {!['fifo','add_const'].includes(module.kind)&&<><label>取值来源<select aria-label={`参数 ${row.key} 绑定作用域`} value={binding?.scope??''} onChange={e=>set(!e.target.value?undefined:typeof original==='number'?{scope:e.target.value as 'self'|'parent',expression:binding?reference?binding.reference:binding.expression:String(original)}:{scope:e.target.value as 'self'|'parent',reference:reference?binding.reference:row.key,type:typeof original as 'string'|'boolean'})}><option value="">本模块默认值</option><option value="self">当前模块的参数</option><option value="parent">父模块的参数</option></select></label>{binding&&<label>{reference?'引用参数名':'整数表达式'}<input aria-label={`参数 ${row.key} 表达式`} value={reference?binding.reference:binding.expression} onChange={e=>set(reference?{...binding,reference:e.target.value}:{...binding,expression:e.target.value})}/></label>}</>}
   <p className="hint">当前值：{String(row.error??row.value)} · {row.source==='element_override'?'元素覆盖':row.binding?bindingText(row.binding):'默认值'}</p>
   <details><summary>{row.paths.length?`传递路径 · ${row.paths.length}`:'没有声明下游绑定'}</summary>{row.paths.length?row.paths.map((path,i)=><p key={i} className="parameter-path">{path.join(' → ')}</p>):<p className="hint">修改此参数不会通过当前模型的绑定传到下游。同名参数不会自动关联；RTL 中未导入的依赖仍需核对。</p>}</details>
  </section>;
 })}</>;
}
