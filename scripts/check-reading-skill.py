"""Exercise the portable read-only skill guard; all candidates live in /tmp."""
import copy
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
GUARD = ROOT / '.agents/skills/rtl-architect/scripts/check_reading.py'
BASE = json.loads((ROOT / 'examples/tiny-stream/model.json').read_text())


def require(condition, message):
    if not condition:
        raise AssertionError(message)


with tempfile.TemporaryDirectory(prefix='rtlarch-reading-') as name:
    work = Path(name)

    def run(before, after, expected):
        files = [work / 'before.json', work / 'after.json']
        for path, obj in zip(files, (before, after)):
            path.write_text(obj if isinstance(obj, str) else json.dumps(obj), encoding='utf-8')
        snapshot = {p.name: p.read_bytes() for p in work.iterdir()}
        result = subprocess.run([sys.executable, str(GUARD), *map(str, files)], cwd=work,
                                capture_output=True, text=True, timeout=15)
        require(result.returncode == expected, result.stdout + result.stderr)
        report = json.loads(result.stdout)
        require(snapshot == {p.name: p.read_bytes() for p in work.iterdir()}, 'guard wrote files')
        if expected != 2:
            require(report['inputFileSha256'] == [hashlib.sha256(snapshot[p.name]).hexdigest() for p in files], 'wrong byte hashes')
            require(not report['textMeaningVerified'] and not report['schemaValidated'], 'overclaimed validation')
        return report

    refined = copy.deepcopy(BASE)
    refined['design']['name'] = '输入缓存与加法'
    refined.setdefault('specification', {})['summary'] = '缓存输入，再加常数后输出。'
    for module in refined['modules']:
        module['name'] = '职责名称'
        module['contract']['responsibility'] = '此处仅测试字段边界，文字仍须由人核对。'
        module['interfaceGroups'] = [{'id': 'input', 'label': '输入', 'category': 'data', 'description': '待核对'}]
        for port in module['interfaces']:
            port['group'] = 'input'
        module['interfaces'].reverse()
    refined['modules'].reverse()
    refined['connections'].reverse()
    allowed = run(BASE, refined, 0)
    require(allowed['changedPaths'] and not allowed['protectedChanges'], 'missing allowed changes')
    print('PASS reading skill: allowed fields, ID-based ordering, foreign cwd, read-only byte hashes')

    # Exercise structural and behavioural edits individually, even alongside a name edit.
    paths = [
        ('modules', 0, 'id'), ('modules', 0, 'parent'), ('modules', 0, 'rtlModule'),
        ('modules', 0, 'parameters'), ('modules', 0, 'parameterBindings'),
        ('modules', 0, 'instanceArray'), ('modules', 0, 'instanceParameterOverrides'),
        ('modules', 0, 'clock'), ('modules', 0, 'reset'), ('modules', 0, 'timing'),
        ('modules', 0, 'resetControlInputs'), ('connections',), ('clocks',), ('resets',), ('localSignals',),
    ]
    for path in paths:
        candidate = copy.deepcopy(BASE)
        candidate['design']['name'] = '顺便改名'
        target = candidate
        for key in path[:-1]:
            target = target[key]
        key = path[-1]
        old = target.get(key)
        if key in ('connections', 'clocks', 'resets'):
            target[key] = []
        elif key == 'localSignals':
            target[key] = [{'id': 'new', 'source': {'kind': 'constant', 'value': '0'}}]
        else:
            target[key] = '__changed__'
        require(target[key] != old, f'ineffective mutation: {path}')
        require(run(BASE, candidate, 1)['protectedChanges'], str(path))
    print('PASS reading skill: hierarchy, IDs, parameters, arrays, wiring, local drivers, clock/reset protected')

    module = next(m for m in BASE['modules'] if m['interfaces'])
    index = BASE['modules'].index(module)
    for field in ('id', 'name', 'direction', 'width', 'protocol', 'required', 'role'):
        candidate = copy.deepcopy(BASE)
        candidate['modules'][index]['interfaces'][0][field] = '__changed__'
        run(BASE, candidate, 1)
    for field in ('latencyMinCycles', 'latencyCondition', 'backpressure', 'resetBehavior', 'invariants', 'verificationPlan', 'openQuestions'):
        candidate = copy.deepcopy(BASE)
        candidate['modules'][0]['contract'][field] = '__changed__'
        run(BASE, candidate, 1)
    print('PASS reading skill: physical port fields and timing/behaviour contract protected')

    provenance = {'origin': 'as_built', 'fidelity': 'partial', 'sourceDigest': 'abc',
                  'evidence': [{'id': 'src', 'path': 'rtl/top.sv', 'lineStart': 10}],
                  'findings': [{'id': 'unknown', 'classification': 'unknown'}]}
    source = copy.deepcopy(BASE)
    source['provenance'] = provenance
    for field in provenance:
        candidate = copy.deepcopy(source)
        candidate['provenance'].pop(field)
        run(source, candidate, 1)
    candidate = copy.deepcopy(source)
    candidate.pop('provenance')
    run(source, candidate, 1)
    print('PASS reading skill: partial, source digest, evidence and unresolved findings cannot disappear')

    legacy = copy.deepcopy(BASE)
    legacy.pop('specification', None)
    candidate = copy.deepcopy(legacy)
    candidate['specification'] = {'summary': '新增用途说明', 'requirements': [], 'decisions': [], 'openQuestions': []}
    run(legacy, candidate, 0)
    for field in ('requirements', 'decisions', 'openQuestions'):
        changed = copy.deepcopy(candidate)
        changed['specification'][field] = ['新行为或问题']
        run(candidate, changed, 1)
        run(changed, candidate, 1)
    print('PASS reading skill: legacy summary addition allowed; requirements, decisions and questions preserved')

    bad = copy.deepcopy(BASE)
    bad['modules'].append(copy.deepcopy(bad['modules'][0]))
    for invalid in ('{"design":{},"design":{},"modules":[]}', '{', '{"design":{},"modules":[],"bad":NaN}',
                    {}, {'model': BASE}, bad):
        require(run(BASE, invalid, 2)['code'] == 'READING_INPUT_INVALID', 'input error not identified')
    duplicate_port = copy.deepcopy(BASE)
    duplicate_port['modules'][index]['interfaces'].append(copy.deepcopy(module['interfaces'][0]))
    run(BASE, duplicate_port, 2)
    print('PASS reading skill: duplicate keys/IDs, malformed and wrapped inputs rejected')

print('6 reading skill checks passed.')
