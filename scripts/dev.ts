import { spawn } from 'node:child_process';
const children = [spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], { stdio: 'inherit', env: process.env }), spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', env: process.env })];
let stopping = false;
function stop(code: number) {
  if (stopping) return; stopping = true; process.exitCode = code;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL'); }, 3000); timer.unref();
}
for (const child of children) { child.on('error', error => { console.error(error); stop(1); }); child.on('exit', code => stop(code ?? 1)); }
process.on('SIGINT', () => stop(0)); process.on('SIGTERM', () => stop(0));
