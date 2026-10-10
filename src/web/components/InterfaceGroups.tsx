import type {Module} from '../../core/schema';
type Groups=NonNullable<Module['interfaceGroups']>;
const categories:Record<Groups[number]['category'],string>={data:'数据',request:'请求',response:'返回数据',writeback:'写回',configuration:'配置（默认折叠）',clock_reset:'时钟与复位（默认折叠）',control:'控制',other:'其他'};
export function InterfaceGroups({groups,change}:{groups:Groups;change:(value:Groups)=>void}){
 const update=(index:number,patch:Partial<Groups[number]>)=>change(groups.map((group,i)=>i===index?{...group,...patch}:group));
 return <details className="interface-groups"><summary>业务分组 · {groups.length}</summary><p className="hint">填写用途，再将下方端口归入同一个组 ID。分组不合并 RTL 端口；只有明确声明的配置、时钟与复位连接默认收起。</p>
  {groups.map((group,index)=><section className="interface-card" key={index}>
   <label>组 ID<input aria-label={`分组 ${index+1} ID`} value={group.id} onChange={e=>update(index,{id:e.target.value})}/></label>
   <label>显示名称<input aria-label={`分组 ${index+1} 名称`} value={group.label} onChange={e=>update(index,{label:e.target.value})}/></label>
   <label>用途<select aria-label={`分组 ${index+1} 用途`} value={group.category} onChange={e=>update(index,{category:e.target.value as Groups[number]['category']})}>{Object.entries(categories).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
   <label>分组依据<textarea value={group.description} onChange={e=>update(index,{description:e.target.value})}/></label>
   <button onClick={()=>change(groups.filter((_,i)=>i!==index))}>移除分组</button>
  </section>)}<button onClick={()=>change([...groups,{id:`group_${groups.length+1}`,label:'新分组',category:'other',description:''}])}>添加分组</button>
 </details>;
}
