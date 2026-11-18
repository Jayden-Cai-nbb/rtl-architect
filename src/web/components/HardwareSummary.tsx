import {PageList} from './Issues';
import type {hardwareChangeSummary} from '../../core/diff';
export function HardwareSummary({summary}:{summary:ReturnType<typeof hardwareChangeSummary>}){return <section data-testid="hardware-change-summary"><h3>硬件对象变化 · {summary.items.length}</h3><p className="hint">{summary.note}</p><PageList items={summary.items} render={(d,i)=><details key={i}><summary>{d.text} · {d.target}</summary><div className="diff-values"><pre>{JSON.stringify(d.before,null,2)}</pre><span>→</span><pre>{JSON.stringify(d.after,null,2)}</pre></div></details>}/></section>;}
