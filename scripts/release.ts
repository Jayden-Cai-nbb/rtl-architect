import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { toolRoot, toolVersion } from '../src/workspace/environment';

const releaseFiles = [
  'README.md', 'AGENTS.md', 'VALIDATION.md', 'LICENSE',
  'docs/USER-GUIDE.md', 'docs/ARCHITECTURE.md', 'docs/HISTORY.md',
  '.node-version', '.npmrc', '.gitignore', '.github/workflows/ci.yml',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'env.sh',
  'bin/rtlarch', '.agents/skills/rtl-architect', 'src', 'scripts', 'examples',
];
const localFiles = new Set([
  '.git', '.runtime', '.venv', '.archive', '.rtlarch', 'node_modules', 'dist',
  'generated', 'evidence', 'proposals', 'exports', 'sim_build', 'obj_dir', '.pytest_cache', '__pycache__',
  'workbench.json', 'review.json', 'module-reviews.json',
]);
const exec = promisify(execFile);

function contains(root: string, path: string) {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep));
}

async function stage(destination?: string) {
  const root = await realpath(toolRoot);
  const releases = join(root, 'release');
  const requested = destination ? resolve(destination) : join(releases, `rtl-architect-${toolVersion}`);
  if (dirname(requested) === releases) {
    await mkdir(releases, { recursive: true });
    assert.equal(await realpath(releases), releases, 'release/ must be inside the tool directory');
  }
  const output = join(await realpath(dirname(requested)), basename(requested));
  assert(!contains(root, output) || (output !== releases && contains(releases, output)),
    'Use release/<name> or a new directory outside the tool directory');
  await mkdir(output);
  try {
    const copyFilter = async (path: string) => {
      if (localFiles.has(basename(path)) || /\.(pyc|vvp|vcd|fst)$/.test(path)) return false;
      const entry = await lstat(path);
      assert(entry.isDirectory() || entry.isFile(), `Non-regular release input: ${relative(root, path)}`);
      return true;
    };
    for (const file of releaseFiles) {
      const target = join(output, file);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(root, file), target, { recursive: true, errorOnExist: true, force: false, filter: copyFilter });
    }
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  return output;
}

async function smoke(output: string) {
  const temporary = await mkdtemp(join(tmpdir(), 'rtlarch-release-'));
  const copy = join(temporary, 'tool source');
  const workspace = join(temporary, 'user project');
  const env = { ...process.env };
  delete env.RTLARCH_WORKSPACE;
  delete env.RTLARCH_API_PORT;
  const command = (program: string, args: string[], cwd = copy) => exec(program, args, {
    cwd, env, timeout: 240_000, maxBuffer: 6 * 1024 * 1024,
  });
  const cli = async (args: string[], program = join(copy, 'bin/rtlarch')) =>
    JSON.parse((await command(program, [...args, '--workspace', workspace, '--json'], workspace)).stdout);
  let opened = false;
  try {
    await cp(output, copy, { recursive: true });
    const read = async (file: string) => JSON.parse(await readFile(join(copy, file), 'utf8'));
    const packageInfo = await read('package.json');
    const lock = await read('package-lock.json');
    assert.equal(packageInfo.version, lock.version);
    assert.equal(packageInfo.version, lock.packages[''].version);
    assert.equal(packageInfo.license, 'MIT');
    assert.match(await readFile(join(copy, 'LICENSE'), 'utf8'), /^MIT License/);
    assert.equal((await command('node', ['--version'])).stdout.trim(), 'v' + packageInfo.engines.node);
    assert.equal((await command('npm', ['--version'])).stdout.trim(), packageInfo.engines.npm);
    for (const name of ['node_modules', 'dist', '.runtime', '.git', 'architecture']) {
      await assert.rejects(lstat(join(copy, name)), { code: 'ENOENT' });
    }
    await command('npm', ['ci', '--no-audit', '--no-fund']);
    assert.equal(await realpath(join(copy, 'node_modules')), join(await realpath(copy), 'node_modules'));
    await command('npm', ['run', 'build']);

    await mkdir(workspace);
    await cp(join(copy, 'examples/external-axis/architecture'), join(workspace, 'architecture'), { recursive: true });
    const model = join(workspace, 'architecture/model.json');
    const before = await readFile(model);
    assert.equal((await cli(['install'])).ok, true);
    const skillEntry = join(workspace, '.agents/skills/rtl-architect/scripts/rtlarch');
    assert.equal((await cli(['context', '--offline'], skillEntry)).ok, true);
    const page = await cli(['open']);
    opened = true;
    assert.equal(page.ok, true);
    assert.equal(page.toolVersion, packageInfo.version);
    const health = await (await fetch(page.service.apiUrl + '/api/health', { signal: AbortSignal.timeout(15_000) })).json();
    assert.equal(health.toolVersion, packageInfo.version);
    assert.equal(health.buildId, page.service.buildId);
    const html = await (await fetch(page.reviewUrl, { signal: AbortSignal.timeout(15_000) })).text();
    assert.match(html, /\/assets\//);
    assert.deepEqual(await readFile(model), before);
    console.log(JSON.stringify({ version: toolVersion, output, buildId: health.buildId, lockfileInstall: true,
      inheritedDependencies: false, workspaceWithSpaces: true, skillInstall: true, pageServed: true, modelUnchanged: true }, null, 2));
  } finally {
    if (opened) await cli(['stop']).catch(() => {});
    await rm(temporary, { recursive: true, force: true });
  }
}

const { values, positionals } = parseArgs({ options: { check: { type: 'boolean' }, help: { type: 'boolean' } }, allowPositionals: true });
const usage = 'npm run release -- [--check] [新目录]';
if (values.help) {
  console.log(usage);
} else {
  assert(positionals.length <= 1, usage);
  const output = await stage(positionals[0]);
  console.log(`发布源码目录 ${output}`);
  if (values.check) await smoke(output);
}
