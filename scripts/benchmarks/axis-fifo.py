"""Run the fixed axis_fifo matrix, four directed cases, and an early-commit fault."""

import argparse
from hashlib import sha256
from itertools import product
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import gettempdir, mkdtemp
from time import monotonic
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

from axis_fifo_model import source_model, state_specs


ROOT = Path(__file__).resolve().parents[2]
FROZEN = ROOT / 'examples/external-axis/benchmark/upstream'


COMMIT = '48ff7a7e2ef782cf778d47910cf85835c64b1bce'
RTL = 'rtl/axis_fifo.v'
TEST = 'tb/axis_fifo/test_axis_fifo.py'
LOCK = {
    RTL: 'aefddc67fc3552d919280424606fc6b048e61d7df9ee7ee0f8801c082c1cfc39',
    TEST: '64a38e6c2205417be175d9082c25a96dd7c7fa6369a80736293098fac82633a4',
    'tb/axis_fifo/Makefile': '50039f860bf47d0a452c32c9d35383d175825736b4638d1d21cb606fb6e4d86a',
    'tox.ini': '76c4dda4eb8c59d04b41b4a22ce062f16f5732818b45f0326c8c0d15b0bb5b86',
    'COPYING': '8ea57f95365e9b16a5b516f422b71269183a1ae53bab5878ae6d69039e58fe77',
}
POLICIES = [(0,0,0,0,0), (1,0,0,0,0), (1,1,0,0,0), (1,1,1,0,0), (1,1,1,1,0), (0,0,0,0,1)]
PIPELINES = [(0,0), (1,0), (4,0), (0,1), (1,1), (4,1)]
COCOTB = [*(f'run_test_{i:03}' for i in range(1,5)), *(
    f'run_test_{name}_001' for name in ('tuser_assert','init_sink_pause','init_sink_pause_reset','pause','overflow','oversize')),
    *(f'run_stress_test_{i:03}' for i in range(1,5))]


def digest(file):
    return sha256(file.read_bytes()).hexdigest()


def read(file):
    return json.loads(file.read_text())


def write(file, value):
    file.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    return str(file)


def case_id(width, pipe, policy):
    return '-'.join(map(str, (width,*pipe,*policy)))


def parameters(width, pipe, policy):
    keep = (width + 7) // 8
    f, ov, bad, full, mark = policy
    return dict(DATA_WIDTH=width, KEEP_ENABLE=int(width > 8), KEEP_WIDTH=keep, DEPTH=1024*keep,
        LAST_ENABLE=1, ID_ENABLE=1, ID_WIDTH=8, DEST_ENABLE=1, DEST_WIDTH=8, USER_ENABLE=1, USER_WIDTH=1,
        RAM_PIPELINE=pipe[0], OUTPUT_FIFO_ENABLE=pipe[1], FRAME_FIFO=f, USER_BAD_FRAME_VALUE=1,
        USER_BAD_FRAME_MASK=1, DROP_OVERSIZE_FRAME=ov, DROP_BAD_FRAME=bad, DROP_WHEN_FULL=full,
        MARK_WHEN_FULL=mark, PAUSE_ENABLE=1, FRAME_PAUSE=1)


def status(test):
    return next((part.tag for part in test if part.tag in ('failure','error','skipped')), 'passed')


def audit_original(upstream, junit):
    outer = {n.get('name'): status(n) for n in ET.parse(junit).iter('testcase')}
    rows = []
    for w,p,f in product((8,16,32,64), PIPELINES, POLICIES):
        key = case_id(w,p,f)
        folder = upstream/'tb/axis_fifo/sim_build'/f'test_axis_fifo-{key}'
        [xml] = folder.glob('*_results.xml')
        root = ET.parse(xml)
        tests = {t.get('name'): status(t) for t in root.iter('testcase')}
        seeds = [n.get('value') for n in root.iter('property') if n.get('name') == 'random_seed']
        image = folder/'axis_fifo.vvp'
        compiled = {k:int(v,2) for k,v in re.findall(r'\.param/l "(\w+)" \d+ \d+ \d+, [+-]?C4<([01]+)>;', image.read_text())}
        expected = parameters(w,p,f)
        assert seeds == ['1'] and set(tests) == set(COCOTB), (key, seeds, list(tests))
        assert {k:compiled[k] for k in expected} == expected, key
        assert outer[f'test_axis_fifo[{key}]'] == 'passed' and set(tests.values()) == {'passed'}, (key,tests)
        rows.append(dict(case=key, parameters=expected, passed=len(tests), seed=1,
                         junitSha256=digest(xml), executableSha256=digest(image)))
    assert len(outer) == len(rows) == 144
    return dict(configurations=rows, passed=144, cocotbPerCase=len(COCOTB), cocotbPassed=sum(row['passed'] for row in rows),
                tests=COCOTB, junitSha256=digest(junit))


class Workspace:
    def __init__(self, root, args):
        self.root = root
        self.args = args
        self.commands = []
        self.files = list(LOCK)
        for file in self.files:
            dest = root/file
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(args.upstream/file, dest)

    def cli(self, label, *args, expect=0):
        argv = [str(self.args.cli), *args, '--workspace', str(self.root), '--json']
        start = monotonic()
        proc = subprocess.run(argv, cwd=self.root, capture_output=True, text=True, timeout=120)
        stdout = self.root/(label + '.stdout.json')
        stdout.write_text(proc.stdout)
        (self.root/(label + '.stderr.txt')).write_text(proc.stderr)
        self.commands.append(dict(argv=argv, cwd=str(self.root), elapsedMs=round((monotonic()-start)*1000),
                                  rc=proc.returncode, path=stdout.name, sha256=digest(stdout)))
        write(self.root/'commands.json', self.commands)
        result = json.loads(proc.stdout)
        if expect is not None:
            assert proc.returncode == expect and result['ok'] == (expect == 0), (self.root.name, label, result.get('error'))
        return result

    def json(self, file, obj):
        write(self.root/file, obj)
        return file

    def profile(self, label, stage, program, version, args, checks, inputs):
        name = label+'.json'
        return self.json(name, dict(schemaVersion=1, name=label, stage=stage, moduleIds=['top'],
                         inputs=[*inputs,'configuration.json',name], timeoutMs=60000,
                         inputClosure=dict(status='declared_complete',note='显式源文件、配置、脚本、生成步骤和已核对的本机工具。'),
                         commands=[dict(program=str(program),versionArgs=version,args=args)], checks=checks))

    def install(self, model_file):
        draft = self.cli('draft','draft',model_file,'proposals/fifo.json','--open')
        opened = self.cli('open','open')
        service = opened['service']
        assert draft['committed'] is False and not [i for i in draft['issues'] if 'commit' in i['blocks']], draft['issues']
        assert parse_qs(urlparse(draft['reviewUrl']).query)['workspace'] == [service['workspaceId']]
        proposal = read(self.root/'proposals/fifo.json')
        assert proposal['baseHash'] == draft['modelHash']
        body = dict(proposal=proposal, candidateHash=draft['candidateHash'])
        request = Request(service['apiUrl']+'/api/commit', data=json.dumps(body).encode(), method='POST',
                          headers={'Content-Type':'application/json','X-RTLArch-Workspace':service['workspaceId']})
        with urlopen(request, timeout=15) as response:
            committed = json.load(response)
        self.json('commit-response.json',committed)
        assert committed['modelHash'] == draft['candidateHash'] and committed['reviewStatus'] == 'DRAFT'
        return dict(buildId=service['buildId'], candidateHash=draft['candidateHash'], baseHash=draft['modelHash'],
                    proposalId=draft['proposalId'], initialUrl=draft['reviewUrl'], savedStatus=committed['reviewStatus'])

    def directed(self, mutated=False):
        shutil.copyfile(Path(__file__).with_name('directed_fifo.py'),self.root/'directed_fifo.py')
        kinds = [dict(kind='artifact',file=name) for name in ('edges.json','directed-summary.json')]
        profile = self.profile('directed','simulation',self.args.python,['--version'],
                               ['directed_fifo.py','configuration.json','{runDir}'],
                               [*kinds,dict(kind='junit',file='directed.xml')],[*self.files,'directed_fifo.py'])
        recorded = self.cli('directed','verify',profile,expect=None)
        assert recorded['status'] == ('check_failed' if mutated else 'passed'), (self.root.name,recorded)
        report = read(Path(recorded['directory'])/'directed-summary.json')
        return recorded, report

    def elaborate_once(self, config):
        parameters_args = ''.join(f' -chparam {key} {value}' for key, value in config.items())
        recipe = f'read_verilog {RTL}; hierarchy -check -top axis_fifo{parameters_args}; proc; opt_muxtree; check; write_json {{runDir}}/netlist.json'
        profile_file = self.profile('elaboration', 'elaboration', self.args.yosys, ['-V'], ['-Q', '-p', recipe],
                                    [dict(kind='artifact', file='netlist.json')], [*self.files, 'inventory.json'])
        profile = read(self.root / profile_file)
        profile['elaborationInputs'] = 'inventory.json'
        return self.cli('elaboration', 'verify', self.json(profile_file, profile))

    def qualify(self, label, model, task):
        report = self.cli(label, 'diagram-quality', '--model', model, '--task', 'overview', '--reading-task', task, expect=1)
        assert report['error']['code'] == 'READING_TASK_INCOMPLETE', report.get('error')
        assert report['quality']['status'] == 'passed'
        assert report['quality']['taskEvidence']['status'] == 'blocked'
        return {key: report['quality'][key] for key in ('taskEvidence', 'crossings', 'hiddenLabels', 'maxRouteLength', 'status')}


def add_reading_path(model):
    steps = [
        dict(id='write_address', label='写地址', target=dict(kind='local', id='wr_ptr_reg'), evidenceIds=['address_logic', 'write_logic']),
        dict(id='commit', label='帧提交边界', target=dict(kind='local', id='wr_ptr_commit_reg'), evidenceIds=['write_logic']),
        dict(id='ram_read', label='RAM 读入', target=dict(kind='local', id='pipe_word0'), gapId='memory_words', evidenceIds=['read_logic']),
        dict(id='output_pipe', label='输出管线', target=dict(kind='local', id='pipe_word1'), connectionIds=['to_m_axis_tdata'],
             evidenceIds=['read_logic', 'pause_logic']),
    ]
    model['provenance']['readingTasks'].append(dict(id='fifo_path', label='从写地址沿帧边界到输出', moduleId='top', steps=steps))


def test_case(args, width, frame, fault_basis=None):
    fault = fault_basis is not None
    key = 'fault-16-frame' if fault else f'{width}-{frame}'
    work = Workspace(args.out / key, args)
    config = parameters(width, (1, 0), POLICIES[3 if frame else 0])
    work.json('configuration.json', dict(case=key, parameters=config, commit=COMMIT, seed=1, pauseRequest=0))
    work.json('inventory.json', dict(top='axis_fifo', configuration=key, parameters=config,
              defines=[], includeDirs=[], files=[RTL, {'path':TEST,'stages':['simulation']}], assets=[]))
    if fault:
        edit = work.root / RTL
        before = b'if (s_axis_tlast || (!DROP_OVERSIZE_FRAME && (full_wr || send_frame_reg))) begin'
        original = edit.read_bytes()
        assert original.count(before) == 1
        edit.write_bytes(original.replace(before, b"if (1'b1) begin"))
    try:
        work.cli('init', 'init')
        run = work.elaborate_once(config)
        ref = dict(runId=run['id'], netlist='netlist.json', reuseElaboration=True, top='axis_fifo')
        prototype = None
        raw_quality = None
        if fault:
            model = read(args.out / '16-1/candidate.json')
            specs = dict(schemaVersion=2, **ref, scopes=[dict(instancePath=[], mappings=[])])
        else:
            req = work.json('import-input.json', dict(schemaVersion=2, runId=run['id'], netlist='netlist.json'))
            imported = work.cli('import', 'import-yosys', req, 'imported')
            assert imported['committed'] is False
            assert read(Path(imported['reportFile']))['producer']['runId'] == run['id']
            prototype = read(Path(imported['review']['conformance']))
            assert len(prototype['mappings'][0]['ports']) == 25
            specs = read(Path(imported['review']['stateDiscovery']))
            raw = read(Path(imported['modelFile']))
            assert all(raw['modules'][0]['parameters'][k] == v for k, v in config.items())
            if width == 16 and frame:
                raw_quality = work.qualify('raw-reading', 'imported/model.json', 'memory_access_top')
                assert imported['connections'] == 2
            model = source_model(raw, config, LOCK[RTL], LOCK[TEST])
            add_reading_path(model)
        saved = work.install(work.json('candidate.json', model))
        assert saved['baseHash'] == run['modelHash'] and saved['candidateHash'] != run['modelHash']

        conformance = quality = None
        if prototype:
            prototype['mappings'][0].update(clock='clk', reset='rst')
            conformance = work.cli('conform', 'conform', work.json('conformance.json', prototype), expect=1)
            assert conformance['producerFresh'] and conformance['reusedElaboration']
            assert conformance['status'] == 'UNKNOWN'
            assert all(p['status']=='MATCH' for p in conformance['items'] if '.ports.' in p['target'])
            quality = work.qualify('reading', 'candidate.json', 'fifo_path')
            task = next(t for t in quality['taskEvidence']['tasks'] if t['id']=='fifo_path')
            assert [step['status'] for step in task['steps']] == ['located', 'located', 'gap', 'located']
        specs['scopes'][0]['mappings'] = state_specs(model)
        mapping_file = work.json('state-map.json', specs)
        observed = work.cli('state', 'observe-state', mapping_file, expect=1 if fault else 0)
        assert observed['producerFresh'] and observed['reusedElaboration'] and observed['producerModelHash'] == run['modelHash']
        assert observed['status'] == ('MISMATCH' if fault else 'MATCH')
        if fault:
            assert saved['candidateHash'] == fault_basis
            failures = [r for r in observed['results'] if r['status'] != 'MATCH']
            assert len(failures)==1 and failures[0]['state']=='wr_ptr_commit_reg'
            assert (failures[0]['witness']['expected'], failures[0]['witness']['actual']) == ('0x0', '0x1')
        sim, directed = work.directed(fault)
        if fault:
            assert directed['errors'][0]['code']=='VISIBLE_BEFORE_ELIGIBLE' and directed['errors'][0]['edge']==4
            # Verify the symbolic witness against the independently driven E2 samples.
            trace = read(Path(sim['directory'])/'edges.json')
            pre, post = [dict(zip(trace['columns'],values)) for values in trace['rows'][2]]
            original_sim = read(args.out/'16-1/directed.stdout.json')
            trace_base = read(Path(original_sim['directory'])/'edges.json')
            original_post = dict(zip(trace_base['columns'],trace_base['rows'][2][1]))
            witness = failures[0]['witness']
            assert all(pre[item['signal']]==int(item['value'],16) for item in witness['inputs'])
            assert original_post['wr_ptr_commit_reg']==int(witness['expected'],16) and post['wr_ptr_commit_reg']==int(witness['actual'],16)

        assurance = work.cli('assurance','assurance','--module','top')
        assert assurance['approval']['status']=='DRAFT' and assurance['stateObservation']['status']==observed['status']
        assert next(r for r in assurance['runs'] if r['id']==run['id'])['fresh'] is False
        replay = None
        if width==16 and frame and not fault:
            missing = work.cli('supported-undeclared','replay','--module','top','--semantics','registered_skid')
            unavailable = work.cli('unsupported','replay','--module','top','--semantics','addressed_frame_fifo')
            assert missing['availability']['status']=='NOT_DECLARED' and unavailable['availability']['status']=='UNSUPPORTED'
            upload = work.json('unsupported-map.json',dict(schemaVersion=2,moduleId='top',pathId='addressed_frame_fifo',
                origin='simulation',runId=sim['id'],artifact='edges.json',configuration='configuration.json',ports={},states={}))
            refused = work.cli('upload-unsupported','replay',upload,expect=1)
            assert refused['error']['code']=='REPLAY_UNSUPPORTED'
            replay = dict(supported=missing['availability'], unsupported=unavailable['availability'], failure=refused['error'])
            manifest = work.root/'inventory.json'
            original = manifest.read_bytes()
            try:
                manifest.write_bytes(original + b'\n')
                stale = work.cli('stale-source','assurance','--module','top')
                assert stale['stateObservation']['status']=='STALE' and stale['structural']['status']=='STALE'
            finally:
                manifest.write_bytes(original)
        return dict(root=str(work.root), buildId=saved['buildId'], candidateHash=saved['candidateHash'], runId=run['id'],
            elaborations=1, parameters=config, reviewStatus=saved['savedStatus'], producerModelHash=observed['producerModelHash'],
            state=observed['status'], engine=observed['engine'], states=[{k:v for k,v in row.items() if k in ('state','status','metrics','witness','reason')} for row in observed['results']],
            stateRecord=observed['record'], reading=quality, rawReading=raw_quality, simulation=sim['status'], simId=sim['id'],
            simDirectory=sim['directory'], totals=directed['totals'], firstError=directed['errors'][0] if fault else None, replay=replay)
    finally:
        work.cli('stop','stop',expect=None)


def run_upstream(args):
    sources = args.out / 'upstream'
    for file in LOCK:
        dest = sources / file
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.upstream / file, dest)
    junit = args.out / 'upstream-junit.xml'
    argv = [str(args.python), '-m', 'pytest', '-c', 'tox.ini', '-n', '8', '--tb=short', '-q',
            '--junitxml=' + str(junit), TEST]
    record = args.out / 'upstream-command.json'
    log = args.out / 'upstream.log'
    write(record, dict(argv=argv, cwd=str(sources), seed=1))
    print(f'Running original upstream pytest (144 configurations). Evidence: {args.out}', flush=True)
    with log.open('w') as output:
        result = subprocess.run(argv, cwd=sources, stdout=output, stderr=subprocess.STDOUT, timeout=1200)
    write(record, dict(argv=argv, cwd=str(sources), seed=1, returncode=result.returncode, logSha256=digest(log)))
    if result.returncode:
        raise SystemExit(f'Upstream pytest exited {result.returncode}. See {log}')
    return sources, junit


def tool_versions(args):
    def identify(*command):
        result = subprocess.run(list(command), capture_output=True, text=True, timeout=15, check=True)
        return (result.stdout or result.stderr).strip()

    return dict(python=identify(args.python, '--version'),
                pythonPackages=json.loads(identify(args.python, '-c',
                    "import json; from importlib.metadata import version; print(json.dumps({p: version(p) for p in ('pytest', 'cocotb', 'cocotbext-axi', 'cocotb-test')}))")),
                iverilog=identify(args.icarus_bin / 'iverilog', '-V').splitlines()[0],
                vvp=identify(args.icarus_bin / 'vvp', '-V').splitlines()[0], yosys=identify(args.yosys, '-V'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    path = lambda value: Path(value).absolute()
    parser.add_argument('--upstream', type=path, default=FROZEN, help='frozen upstream files, defaults to the bundled checkout')
    parser.add_argument('--junit', type=path, help='audit a prior original pytest run in --upstream instead of running it again')
    parser.add_argument('--out', type=path, help='new directory under the system temporary directory')
    parser.add_argument('--python', type=path, required=True, help='Python environment with the upstream tox.ini dependencies')
    parser.add_argument('--icarus-bin', type=path, required=True, help='directory with Icarus and vvp compatible with that environment')
    parser.set_defaults(cli=ROOT/'bin/rtlarch',yosys=shutil.which('yosys'))
    args = parser.parse_args()
    if not args.yosys:
        parser.error('Yosys is required on PATH for structure and state comparison')
    if args.junit and args.upstream == FROZEN:
        parser.error('--junit requires --upstream pointing to its own completed run directory')
    if args.out:
        if not args.out.parent.resolve().is_relative_to(Path(gettempdir()).resolve()):
            parser.error('--out must be in the system temporary directory')
        args.out.mkdir()
    else:
        args.out = Path(mkdtemp(prefix='rtlarch-fifo-benchmark-'))
    assert {name:digest(args.upstream/name) for name in LOCK} == LOCK
    os.environ.update(PATH=str(args.icarus_bin)+os.pathsep+os.environ['PATH'], SIM='icarus', RANDOM_SEED='1', PYTHONHASHSEED='1')
    tools = tool_versions(args)
    reran_upstream = args.junit is None
    if reran_upstream:
        sources, junit = run_upstream(args)
    else:
        sources, junit = args.upstream, args.junit
    original = audit_original(sources,junit)
    assert {name:digest(sources/name) for name in LOCK} == LOCK
    write(args.out/'upstream-matrix.json', original)
    cases = []
    for width,frame in product((16,32),(0,1)):
        row = test_case(args,width,frame)
        cases.append(row)
        print(width,frame,row['state'],row['simulation'],flush=True)
    fault = test_case(args,16,1,cases[1]['candidateHash'])
    assert {name:digest(args.upstream/name) for name in LOCK} == LOCK
    scripts = [Path(__file__), Path(__file__).with_name('axis_fifo_model.py'), Path(__file__).with_name('directed_fifo.py')]
    write(args.out/'summary.json', dict(commit=COMMIT, upstream=original['passed'], cocotb=original['cocotbPassed'],
        reranUpstream=reran_upstream, tools=tools, seed=1, frozenInputs=LOCK,
        runnerInputs={str(file.resolve().relative_to(ROOT)): digest(file) for file in scripts}, cases=cases, fault=fault))
    print('Fault:',fault['state'],fault['simulation'],args.out/'summary.json',flush=True)


if __name__=='__main__':
    main()
