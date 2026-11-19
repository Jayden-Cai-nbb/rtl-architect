import { resolve } from 'node:path';
import { startService } from './service';
try {
  const running = await startService(resolve(process.env.RTLARCH_WORKSPACE || '.'));
  console.log(JSON.stringify({ ok: true, ...running.info }));
  process.once('SIGTERM', () => void running.close()); process.once('SIGINT', () => void running.close());
  await running.closed;
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
