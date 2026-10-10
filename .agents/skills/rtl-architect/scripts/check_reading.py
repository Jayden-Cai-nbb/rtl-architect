#!/usr/bin/env python3
"""Read-only guard for a presentation-only Model revision; not equivalence proof."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import sys


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def keyed(items, path):
    if not isinstance(items, list):
        raise ValueError(f"{path} must be an array")
    result = {}
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get('id'), str):
            raise ValueError(f"{path} entries require string IDs")
        if item['id'] in result:
            raise ValueError(f"duplicate ID in {path}: {item['id']}")
        result[item['id']] = item
    return result


def normalized(model, strip_reading=False):
    result = copy.deepcopy(model)
    if not isinstance(result, dict) or 'design' not in result or 'modules' not in result:
        raise ValueError('expected a Model, not a Proposal or API response')
    for field in ('modules', 'connections', 'clocks', 'resets', 'localSignals'):
        if field in result:
            result[field] = keyed(result[field], field)
    for module in result['modules'].values():
        module['interfaces'] = keyed(module.get('interfaces', []), 'interfaces')
        if 'interfaceGroups' in module:
            module['interfaceGroups'] = keyed(module['interfaceGroups'], 'interfaceGroups')
        if strip_reading:
            module.pop('name', None)
            module.pop('interfaceGroups', None)
            for port in module['interfaces'].values():
                port.pop('group', None)
            if 'contract' in module:
                module['contract'].pop('responsibility', None)
    if strip_reading:
        result['design'].pop('name', None)
        if 'specification' in result:
            result['specification'].pop('summary', None)
            for field in ('requirements', 'decisions', 'openQuestions'):
                if result['specification'].get(field) == []:
                    result['specification'].pop(field)
            if not result['specification']:
                result.pop('specification')
    return result


def different_paths(a, b, path=''):
    if type(a) is not type(b):
        return [path or '/']
    if isinstance(a, dict):
        paths = []
        for key in sorted(a.keys() | b.keys()):
            child = path + '/' + key.replace('~', '~0').replace('/', '~1')
            paths.extend([child] if key not in a or key not in b else different_paths(a[key], b[key], child))
        return paths
    if isinstance(a, list):
        if len(a) != len(b):
            return [path]
        return [p for i, (x, y) in enumerate(zip(a, b)) for p in different_paths(x, y, path + '/' + str(i))]
    return [] if a == b else [path or '/']


def audit(before, after):
    protected = different_paths(normalized(before, True), normalized(after, True))
    return {
        'ok': not protected, 'check': 'reading-only',
        'code': 'READING_FIELDS_ONLY' if not protected else 'PROTECTED_FIELDS_CHANGED',
        'protectedChanges': protected,
        'changedPaths': different_paths(normalized(before), normalized(after)),
        'textMeaningVerified': False, 'schemaValidated': False,
        'note': '仅检查字段边界；不证明文字等价或分组正确。仍需源码核对、schema校验及提案审阅。',
    }


def invalid_constant(value):
    raise ValueError(f'invalid JSON number: {value}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('before', type=Path, help='baseline Model JSON')
    parser.add_argument('after', type=Path, help='reading candidate Model JSON')
    args = parser.parse_args()
    try:
        raw = [p.read_bytes() for p in (args.before, args.after)]
        models = [json.loads(b, object_pairs_hook=unique_object, parse_constant=invalid_constant) for b in raw]
        result = audit(*models)
        result['inputFileSha256'] = [hashlib.sha256(b).hexdigest() for b in raw]
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result['ok'] else 1
    except (OSError, ValueError, TypeError, AttributeError, KeyError) as error:
        print(json.dumps({'ok': False, 'code': 'READING_INPUT_INVALID', 'message': str(error)}, ensure_ascii=False))
        return 2


if __name__ == '__main__':
    sys.exit(main())
