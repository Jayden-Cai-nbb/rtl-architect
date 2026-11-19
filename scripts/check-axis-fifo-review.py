"""Run the four fixed FIFO review cases and the original early-commit mutation."""

import argparse
from itertools import product
import json
import os
from pathlib import Path
import shutil
import sys
from tempfile import gettempdir


ROOT = Path(__file__).resolve().parents[1]
TRIAL = ROOT / 'docs/evidence/axis-fifo-skill-trial'
sys.path.insert(0, str(TRIAL))
from candidate import source_model, state_specs
from run_trial import COMMIT, LOCK, POLICIES, RTL, TEST, Workspace, audit_original, digest, parameters, read, write


class Review(Workspace):
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
    work = Review(args.out / key, args)
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ('upstream','junit','out','python','icarus-bin'):
        parser.add_argument('--'+flag,type=lambda p: Path(p).absolute(),required=True)
    parser.set_defaults(cli=ROOT/'bin/rtlarch',yosys=shutil.which('yosys'))
    args = parser.parse_args()
    assert args.out.parent.resolve().is_relative_to(Path(gettempdir()).resolve()), 'Use an isolated temporary directory'
    args.out.mkdir()
    assert {name:digest(args.upstream/name) for name in LOCK} == LOCK
    os.environ.update(PATH=str(args.icarus_bin)+os.pathsep+os.environ['PATH'], SIM='icarus', RANDOM_SEED='1', PYTHONHASHSEED='1')
    original = audit_original(args.upstream,args.junit)
    write(args.out/'upstream-matrix.json', original)
    cases = []
    for width,frame in product((16,32),(0,1)):
        row = test_case(args,width,frame)
        cases.append(row)
        print(width,frame,row['state'],row['simulation'],flush=True)
    fault = test_case(args,16,1,cases[1]['candidateHash'])
    assert {name:digest(args.upstream/name) for name in LOCK} == LOCK
    write(args.out/'summary.json', dict(commit=COMMIT, upstream=original['passed'], cocotb=original['cocotbPassed'], cases=cases, fault=fault))
    print('Fault:',fault['state'],fault['simulation'],args.out/'summary.json',flush=True)


if __name__=='__main__':
    main()
