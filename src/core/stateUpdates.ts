import type {Model} from './schema';
import {signalText,endpointLabel} from './signals';
export function stateDescription(local:NonNullable<Model['localSignals']>[number]){
 if(local.driver.kind!=='register'||!local.driver.update)return undefined;
 const u=local.driver.update;
 const rows=[...(u.reset?[{id:'reset',condition:`${endpointLabel(u.reset.signal)} = ${u.reset.activeLevel==='low'?'0':'1'}`,action:signalText(u.reset.value),role:'复位'}]:[]),...u.branches.map(b=>({id:b.id,condition:signalText(b.condition),action:signalText(b.value),role:'更新'})),{id:'otherwise',condition:'以上条件均不成立',action:'保持原值',role:'保持'}];
 return {pattern:u.branches.length===1?'条件装载寄存器':'优先级更新寄存器',rows,note:'按表从上到下匹配，第一个成立的条件生效；条件和右值均取有效时钟沿前值。规则为模型声明，来源与本次仿真需独立核对。'};
}
