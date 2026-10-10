import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelSchema } from '../src/core/schema';
import { modelHash } from '../src/core/export';
const root = fileURLToPath(new URL('..', import.meta.url));
const tool = spawnSync('verilator', ['--version'], { encoding: 'utf8' });
if (tool.error || tool.status !== 0) { console.error((tool.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? 'MISSING_TOOL: Verilator 未安装；未执行 RTL 仿真。' : `TOOL_EXECUTION_FAILED: Verilator 无法执行；未执行 RTL 仿真。${tool.error?.message ?? tool.stderr}`); process.exitCode = 1; }
else {
  console.log(tool.stdout.trim());
  const build = await mkdtemp(join(tmpdir(), 'rtlarch-rtl-'));
  const run = (command: string, args: string[], timeout: number) => spawnSync(command, args, { cwd: build, encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024 });
  try {
    const fixture = modelSchema.parse(JSON.parse(await readFile(resolve(root, 'examples/tiny-stream/model.json'), 'utf8')));
    console.log(`仅验证初始 fixture hash=${modelHash(fixture)}；不验证 architecture/model.json 的一致性。`);
    const files = ['rtl/rv_fifo.sv', 'rtl/add_const.sv', 'rtl/stream_path.sv', 'rtl/tiny_stream.sv', 'tb/tb_tiny_stream.sv'].map(file => resolve(root, 'examples/tiny-stream', file));
    const compilation = run('verilator', ['--binary', '--timing', '--assert', '--top-module', 'tb_tiny_stream', '--Mdir', join(build, 'obj'), '-j', '2', ...files], 180000);
    if (compilation.error || compilation.status !== 0) throw new Error(`编译失败\n${compilation.stdout}\n${compilation.stderr}\n${compilation.error ?? ''}`);
    console.log('Verilator --binary --timing 编译完成。');
    const binary = join(build, 'obj/Vtb_tiny_stream'), positive = run(binary, [], 30000);
    console.log(positive.stdout);
    if (positive.error || positive.status !== 0 || !positive.stdout.includes('PASS fixture')) throw new Error(`自检失败\n${positive.stderr}\n${positive.error ?? ''}`);
    const negative = run(binary, ['+force_timeout'], 30000);
    if (negative.error || (negative.status === 0 && !negative.signal) || !`${negative.stdout}${negative.stderr}`.includes('TIMEOUT:')) throw new Error('负向超时测试未按预期以 TIMEOUT 非零/信号退出');
    console.log('PASS timeout negative control: testbench 明确 TIMEOUT 并失败退出。');
  } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }
  finally { await rm(build, { recursive: true, force: true }); }
}
