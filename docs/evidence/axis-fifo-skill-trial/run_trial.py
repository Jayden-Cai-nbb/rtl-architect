"""Check the original matrix evidence, then try the current rtl-architect on four FIFO cases."""

import argparse
from datetime import datetime, timezone
from hashlib import sha256
from itertools import product
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from time import monotonic
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET

from candidate import source_model, state_specs


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


def now():
    return datetime.now(timezone.utc).isoformat()


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

    def elaboration(self, label, config):
        params = ''.join(f' -chparam {key} {value}' for key,value in config.items())
        yosys = f'read_verilog {RTL}; hierarchy -check -top axis_fifo{params}; proc; opt_muxtree; check; write_json {{runDir}}/netlist.json'
        profile = self.profile(label,'elaboration',self.args.yosys, ['-V'], ['-Q','-p',yosys],
                               [dict(kind='artifact',file='netlist.json')], self.files)
        return self.cli(label,'verify',profile)

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

    def observe(self, label, run, specs, expect):
        mapping = self.json(label+'.json', dict(schemaVersion=2, runId=run['id'], netlist='netlist.json', top='axis_fifo',
                            scopes=[dict(instancePath=[],mappings=specs)]))
        return self.cli(label,'observe-state',mapping,expect=expect)

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


def diagram(work, label, *command):
    value = work.cli(label,'diagram-quality',*command,expect=None)
    if 'quality' not in value:
        return value
    quality = value['quality']
    return dict(ok=value['ok'], modelHash=value['modelHash'], view=value['view'], generatedMs=round(value['generatedMs'],2),
        crossings=quality['crossings'], hiddenLabels=len(quality['hiddenLabels']), geometry=quality['status'],
        fidelity=quality['structuralFidelity']['status'], semantic=quality.get('semanticCoverage'),
        counts={k:v for k,v in quality.items() if type(v) is int})


def summarise_observation(obs):
    return {k: obs.get(k) for k in ('status','producerFresh','scope','basis','record','results')}


def analyse(work, config, pipeline, policy, mutated_from=None):
    root = work.root
    key = case_id(config['DATA_WIDTH'],pipeline,policy)
    work.json('configuration.json',dict(case=key,parameters=config,commit=COMMIT,seed=1,pauseRequest=0))
    work.cli('inventory','inventory',work.json('inventory.json',dict(top='axis_fifo',configuration=key,parameters=config,
        defines=[],includeDirs=[],files=[RTL,dict(path=TEST,stages=['simulation'])],assets=list(LOCK)[2:])))
    work.cli('init','init')
    figures = None
    if mutated_from is None:
        initial = work.elaboration('initial-elaboration',config)
        net = Path(initial['directory'])/'netlist.json'
        definition = read(net)['modules']['axis_fifo']
        expected = {k:int(definition['parameter_default_values'][k],2) for k in config}
        assert expected == config and len(definition['ports']) == 25
        mem = definition['memories']['mem']
        assert (mem['width'],mem['size']) == (config['DATA_WIDTH']+config['KEEP_WIDTH']+18,1024)
        imported = work.cli('import','import-yosys',work.json('import-input.json',dict(schemaVersion=1,top='axis_fifo',
                            netlist=str(net.relative_to(root)),files=[RTL],configuration=key)),'imported')
        raw = read(root/'imported/model.json')
        ports = {i['id']:(i['width'], 'input' if i['role']=='consumer' else 'output') for i in raw['modules'][0]['interfaces']}
        assert ports == {k:(len(p['bits']),p['direction']) for k,p in definition['ports'].items()}
        raw_stats = dict(ports=len(ports), bits=sum(w for w,_ in ports.values()), cells=len(definition['cells']),
                         netlistSha256=digest(net), memory=mem, connections=len(raw['connections']),
                         fidelity=raw['provenance']['fidelity'], gaps=[g['kind'] for g in raw['provenance']['unsupportedStructures']])
        if config['DATA_WIDTH']==16 and config['FRAME_FIFO']:
            raw_stats['overview'] = diagram(work,'raw-overview','--model','imported/model.json','--task','overview')
            raw_stats['commitState'] = diagram(work,'raw-missing-state','--model','imported/model.json','--task','state','--state','wr_ptr_commit_reg')
        model = source_model(raw,config,LOCK[RTL],LOCK[TEST])
        model['modules'][0]['parameters'].update(config)
    else:
        model = read(mutated_from/'candidate.json')
        raw_stats = None
    saved = work.install(work.json('candidate.json',model))
    current = work.elaboration('current-elaboration',config)
    if mutated_from is None:
        assert current['modelHash'] == saved['candidateHash'] and initial['modelHash'] != current['modelHash']
        ports = {p['id']:p['id'] for p in model['modules'][0]['interfaces']}
        conformance = work.cli('conform','conform',work.json('conform-input.json',dict(schemaVersion=1,runId=current['id'],
            netlist='netlist.json',top='axis_fifo',mappings=[dict(moduleId='top', instancePath=[], rtlType='axis_fifo',
                parameters={n:n for n in config}, ports=ports, clock='clk', reset='rst')])),expect=None)
        discovered = work.observe('discover',current,[],None)
        figures = dict(overview=diagram(work,'overview','--model','candidate.json','--task','overview'),
                       commitState=diagram(work,'commit-state','--model','candidate.json','--task','state','--state','wr_ptr_commit_reg'),
                       bundle=work.cli('bundle','bundle','reading','--model','candidate.json',expect=None))
        assert figures['overview'].get('modelHash') == saved['candidateHash']
    else:
        conformance = discovered = None
    obs = work.observe('state',current,state_specs(model),None)
    recorded, direct = work.directed(mutated_from is not None)
    replay = work.cli('replay-list','replay')
    assert replay['records'] == [], 'a separate test must not appear as native evidence'
    assured = work.cli('assurance','assurance','--module','top')
    assert assured['approval']['status'] != 'APPROVED'
    if mutated_from is None and config['FRAME_FIFO'] and config['DATA_WIDTH']==16:
        mapped = work.json('unsupported-replay.json',dict(schemaVersion=2,moduleId='top',pathId='addressed_frame_fifo',
            origin='simulation',runId=recorded['id'],artifact='edges.json',configuration='configuration.json',ports={},states={}))
        probe = work.cli('replay-unsupported','replay',mapped,expect=1)
        invalid = read(root/'candidate.json')
        invalid['modules'][0]['contract']['transactionPaths'] = [dict(schemaVersion=2,semantics='addressed_frame_fifo')]
        invalid_path = work.json('unsupported-candidate.json',invalid)
        schema_probe = work.cli('draft-unsupported','draft',invalid_path,'proposals/unsupported.json',expect=1)
        assert not (root/'proposals/unsupported.json').exists()
        replay['unsupportedProbe'] = probe['error']
        replay['schemaProbe'] = {k:schema_probe['error'][k] for k in ('code','message')}
    return dict(case=key, root=str(root), raw=raw_stats, review=saved, diagrams=figures,
                conform=None if conformance is None else conformance.get('status',conformance.get('error')),
                discovery=None if discovered is None else {k:discovered.get(k) for k in ('status','scope','record','reason')},
                state=summarise_observation(obs), simulation=dict(status=recorded['status'],id=recorded['id'],run=str(Path(recorded['directory'])/'run.json'),
                    artifacts=recorded['artifacts'], conclusiveApprovals=assured['approval'], directed=direct), replay=replay)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for option in ('upstream','junit','out','python','icarus-bin','cli'):
        parser.add_argument('--'+option, type=Path, required=True)
    parser.add_argument('--yosys', default=shutil.which('yosys'))
    args = parser.parse_args()
    for name in ('upstream','junit','out','python','icarus_bin','cli'):
        # Preserve a virtualenv interpreter symlink's prefix.
        setattr(args,name,getattr(args,name).absolute())
    os.environ.update(PATH=f'{args.icarus_bin}{os.pathsep}'+os.environ['PATH'], SIM='icarus', RANDOM_SEED='1', PYTHONHASHSEED='1')
    assert {f:digest(args.upstream/f) for f in LOCK} == LOCK
    args.out.mkdir()
    upstream = audit_original(args.upstream,args.junit)
    write(args.out/'upstream-matrix.json',upstream)
    print(f'Original matrix: {upstream["passed"]}/144, cocotb {upstream["cocotbPassed"]}',flush=True)
    results = []
    def run_case(name,config,policy,baseline=None):
        root = args.out/name
        work = Workspace(root,args)
        if baseline:
            before = b'if (s_axis_tlast || (!DROP_OVERSIZE_FRAME && (full_wr || send_frame_reg))) begin'
            data = (root/RTL).read_bytes()
            assert data.count(before) == 1
            fault = data.replace(before,b"if (1'b1) begin")
            (root/RTL).write_bytes(fault)
            write(root/'fault.json',dict(path=RTL,line=data[:data.index(before)].count(b'\n')+1, before=before.decode(),after="if (1'b1) begin",
                                         pristineSha256=LOCK[RTL],mutatedSha256=digest(root/RTL)))
        try:
            assessed = analyse(work,config,(1,0),policy,baseline)
            write(root/'summary.json',assessed)
            print(name,assessed['state']['status'],assessed['simulation']['status'],flush=True)
            return assessed
        finally:
            work.cli('stop','stop',expect=None)
    for width,frame in product((16,32),(0,1)):
        policy = POLICIES[3 if frame else 0]
        results.append(run_case(f'{width}-{frame}',parameters(width,(1,0),policy),policy))
    fault = run_case('fault-16-frame',parameters(16,(1,0),POLICIES[3]),POLICIES[3],args.out/'16-1')
    assert fault['review']['candidateHash']==results[1]['review']['candidateHash']
    assert {f:digest(args.upstream/f) for f in LOCK} == LOCK
    write(args.out/'summary.json',dict(commit=COMMIT, finishedAt=now(), frozenFiles=LOCK, cases=results, fault=fault))


if __name__ == '__main__':
    main()
