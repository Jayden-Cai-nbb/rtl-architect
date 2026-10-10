import { resolve } from 'node:path';
import { startService } from './service';
const demo = process.env.RTLARCH_MODE === 'demo';
try {
  const managed = process.env.RTLARCH_MANAGED === '1';
  const running = await startService(resolve(process.env.RTLARCH_WORKSPACE || '.'), managed ? { port: 0 } : demo ? {
    port: Number(process.env.RTLARCH_WEB_PORT || 5173), apiPort: Number(process.env.RTLARCH_API_PORT || 4317),
  } : { port: Number(process.env.RTLARCH_API_PORT || 4317), dev: true, devWebPort: Number(process.env.RTLARCH_WEB_PORT || 5173) });
  console.log(JSON.stringify({ ok: true, ...running.info }));
  process.once('SIGTERM', () => void running.close()); process.once('SIGINT', () => void running.close());
  await running.closed;
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
