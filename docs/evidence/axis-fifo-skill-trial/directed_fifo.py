"""Finite axis_fifo skill trial. The behavioral oracle reads only public pins."""

import argparse
from collections import deque
import json
import os
from pathlib import Path
from xml.etree import ElementTree as ET

import cocotb
from cocotb.triggers import Timer
from cocotb_test.simulator import run


FIELDS = ('tdata', 'tkeep', 'tlast', 'tid', 'tdest', 'tuser')
PORTS = ('rst', 'pause_req', 'pause_ack', 'status_depth', 'status_depth_commit',
         'status_bad_frame', 'status_overflow', 'status_good_frame',
         *(f'{bus}_{name}' for bus in ('s_axis', 'm_axis') for name in (*FIELDS, 'tvalid', 'tready')))
STATES = ('wr_ptr_reg', 'wr_ptr_commit_reg', 'rd_ptr_reg', 'm_axis_tvalid_pipe_reg', 'drop_frame_reg')
PIPE = ('m_axis_pipe_reg[0]', 'm_axis_pipe_reg[1]')


def payload(pins, bus):
    return tuple(pins[f'{bus}_{field}'] for field in FIELDS)


class BoundaryOracle:
    def __init__(self, frame_mode, capacity):
        self.frame_mode = frame_mode
        self.capacity = capacity
        self.committed = deque()
        self.pending = []
        self.next_frame = 0
        self.accepted = self.consumed = self.cancelled = 0
        self.bad_beats = self.oversize_beats = 0
        self.held_output = None
        self.error_count = 0
        self.errors = []
        self.events = []

    def check(self, condition, edge, phase, code, **details):
        if not condition:
            self.error_count += 1
            if len(self.errors) < 16:
                self.errors.append(dict(edge=edge, phase=phase, code=code, **details))

    def step(self, edge, pre, post):
        statuses = dict(good_frame=0, bad_frame=0, overflow=0)
        if pre['rst']:
            cancelled = (*self.committed, *self.pending)
            self.cancelled += len(cancelled)
            if cancelled:
                self.events.append(dict(edge=edge, kind='reset_cancel', beats=[t[0] for t in cancelled]))
            self.committed.clear()
            self.pending.clear()
            self.held_output = None
            self.next_frame += bool(cancelled)
            self.check(post['m_axis_tvalid'] == 0, edge, 'post', 'RESET_OUTPUT_STILL_VALID')
        else:
            received = payload(pre, 'm_axis') if pre['m_axis_tvalid'] else None
            self.check(self.held_output is None or self.held_output == received, edge, 'pre', 'OUTPUT_HOLD',
                       expected=self.held_output, observed=received)
            self.held_output = received if not pre['m_axis_tready'] else None
            if self.held_output is not None:
                self.check(post['m_axis_tvalid'] == 1 and self.held_output == payload(post, 'm_axis'),
                           edge, 'post', 'OUTPUT_HOLD', expected=self.held_output, observed=payload(post, 'm_axis'))
            if received is not None:
                expected = self.committed[0] if self.committed else None
                if expected is None:
                    pending = self.pending[0] if self.pending else None
                    self.check(False, edge, 'pre', 'VISIBLE_BEFORE_ELIGIBLE',
                               frame=pending[1] if pending else None, beat=pending[0] if pending else None,
                               acceptedAt=pending[3] if pending else None, observed=received)
                else:
                    self.check(expected[2] == received, edge, 'pre', 'OUTPUT_FIELDS', frame=expected[1], beat=expected[0],
                               expected=expected[2], observed=received)
                if pre['m_axis_tready'] and expected is not None:
                    self.committed.popleft()
                    self.consumed += 1

            if pre['s_axis_tvalid'] and pre['s_axis_tready']:
                beat = payload(pre, 's_axis')
                token = (self.accepted, self.next_frame, beat, edge)
                self.accepted += 1
                if self.frame_mode:
                    self.pending.append(token)
                else:
                    self.committed.append(token)
                if beat[2]:
                    if self.frame_mode:
                        count = len(self.pending)
                        if count > self.capacity:
                            self.oversize_beats += count
                            statuses['overflow'] = 1
                            kind = 'oversize_drop'
                        elif beat[-1] == 1:
                            self.bad_beats += count
                            statuses['bad_frame'] = 1
                            kind = 'bad_drop'
                        else:
                            self.committed.extend(self.pending)
                            statuses['good_frame'] = 1
                            kind = 'commit'
                        self.events.append(dict(edge=edge, frame=self.next_frame, kind=kind, count=count,
                                                firstBeat=self.pending[0][0], lastBeat=token[0]))
                        self.pending.clear()
                    self.next_frame += 1
            if post['m_axis_tvalid'] and not self.committed:
                pending = self.pending[0] if self.pending else None
                self.check(False, edge, 'post', 'VISIBLE_BEFORE_ELIGIBLE', frame=pending[1] if pending else None,
                           beat=pending[0] if pending else None, acceptedAt=pending[3] if pending else None,
                           observed=payload(post, 'm_axis'))
        for status, value in statuses.items():
            actual = post[f'status_{status}']
            self.check(actual == value, edge, 'post', 'STATUS_PULSE', status=status, expected=value, observed=actual)


def trace_summary(rows, phases, capacity, keep):
    mask = 2 * capacity - 1
    eligible = lambda p: (p['wr_ptr_commit_reg'] - p['rd_ptr_reg']) & mask
    occupancy = lambda p: (p['wr_ptr_reg'] - p['rd_ptr_reg']) & mask
    both = lambda pre, post: occupancy(pre) != capacity and (post['wr_ptr_reg'] - pre['wr_ptr_reg']) & mask == 1 \
        and (post['rd_ptr_reg'] - pre['rd_ptr_reg']) & mask == 1
    wraps = {p: [i for i, (_, pre, post) in enumerate(rows) if not pre['rst'] and
                 pre[p] % capacity == capacity - 1 and (post[p] - pre[p]) & mask == 1] for p in STATES[:3]}
    trace = lambda edge, pre, post: dict(edge=edge, pre={p: pre[p] for p in (*STATES, 's_axis_tready', 'm_axis_tvalid', 'm_axis_tready', 'status_depth', 'status_depth_commit')},
                                         post={p: post[p] for p in (*STATES, 's_axis_tready', 'm_axis_tvalid', 'm_axis_tready', 'status_depth', 'status_depth_commit')})
    longest = stall = 0
    witnesses = {}
    for i, (name, pre, post) in enumerate(rows):
        stall = stall + 1 if not pre['rst'] and pre['m_axis_tvalid'] and not pre['m_axis_tready'] else 0
        longest = max(longest, stall)
        if name == 'release_full' and 'fullRelease' not in witnesses:
            witnesses['fullRelease'] = trace(i, pre, post)
        if name == 'release_full' and pre['s_axis_tvalid'] and pre['s_axis_tready']:
            witnesses['firstInputAfterFull'] = trace(i, pre, post)
        if name == 'reset_cancel':
            witnesses['reset'] = trace(i, pre, post)
        if both(pre, post) and not pre['rst'] and 'simultaneousRamReadWrite' not in witnesses:
            witnesses['simultaneousRamReadWrite'] = trace(i, pre, post)
        if name == 'first_frame' and pre['s_axis_tvalid'] and pre['s_axis_tready']:
            witnesses.setdefault('firstAccept', trace(i, pre, post))
            if pre['s_axis_tlast']:
                witnesses['firstFrameEnd'] = trace(i, pre, post)
        if not pre['rst'] and post['m_axis_tvalid'] and 'firstVisible' not in witnesses:
            witnesses['firstVisible'] = trace(i, pre, post)
        if not pre['rst'] and pre['m_axis_tvalid'] and pre['m_axis_tready'] and 'firstConsume' not in witnesses:
            witnesses['firstConsume'] = trace(i, pre, post)
        for status in ('bad_frame', 'overflow'):
            if post[f'status_{status}'] and status not in witnesses:
                witnesses[status] = trace(i, pre, post)
    return dict(phases=phases, sampledEdges=len(rows), peakRam=max(occupancy(post) for _, _, post in rows),
                peakCommittedRam=max(eligible(post) for _, _, post in rows),
                peakPipe=max(popcount(post['m_axis_tvalid_pipe_reg']) for _, _, post in rows),
                longestOutputStall=longest, capacity=capacity, wraps=wraps, witnesses=witnesses,
                statusDelayMismatches=sum(post['status_depth'] != occupancy(pre)*keep or
                                          post['status_depth_commit'] != eligible(pre)*keep for _, pre, post in rows))


def popcount(word):
    return bin(word).count('1')


@cocotb.test()
async def exercise_fifo(dut):
    config = json.loads(os.environ['FIFO_TRIAL_PARAMETERS'])
    result_dir = Path(os.environ['FIFO_TRIAL_OUT'])
    capacity = config['DEPTH'] // config['KEEP_WIDTH']
    frame_mode = config['FRAME_FIFO'] == 1
    inputs = [getattr(dut, f's_axis_{f}') for f in FIELDS]
    signals = {n: getattr(dut, n) for n in (*PORTS, *STATES)}
    signals.update(zip(PIPE, (dut.m_axis_pipe_reg[i] for i in range(2))))
    oracle = BoundaryOracle(frame_mode, capacity)
    rows, phases = [], {}

    def beat(n, last=1, user=0):
        return (0x5a, 1 + n % ((1 << config['KEEP_WIDTH']) - 1), last, n % 256, (37 + n * 3) % 256, user)

    def snapshot():
        return {n: int(handle.value) if handle.value.is_resolvable else None for n, handle in signals.items()}

    async def edge(phase, ready, offered=None, reset=False):
        dut.clk.value = 0
        dut.rst.value = int(reset)
        dut.pause_req.value = 0
        dut.m_axis_tready.value = ready
        dut.s_axis_tvalid.value = int(offered is not None)
        for handle, field in zip(inputs, offered or beat(0)):
            handle.value = field
        await Timer(5, units='ns')
        pre = snapshot()
        dut.clk.value = 1
        await Timer(5, units='ns')
        post = snapshot()
        i = len(rows)
        rows.append((phase, pre, post))
        phases.setdefault(phase, [i, i])[1] = i
        oracle.step(i, pre, post)
        return bool(pre['s_axis_tvalid'] and pre['s_axis_tready'])

    async def idle(name, clocks, ready=1):
        for _ in range(clocks):
            await edge(name, ready)

    async def send(name, offered, ready=1):
        for _ in range(12):
            if await edge(name, ready, offered):
                return
        oracle.check(False, len(rows)-1, 'pre', 'STIMULUS_NOT_ACCEPTED', scenario=name)

    await edge('initial_reset', 0, reset=True)
    await idle('first_frame', 1)
    await send('first_frame', beat(1, last=0))
    await idle('first_frame', 6)
    await send('first_frame', beat(1, last=0))
    await send('first_frame', beat(2, user=int(not frame_mode)))
    await idle('first_frame', 8)

    for n in range(capacity + 2):
        await send('fill', beat(n), 0)
    waiting = beat(42)
    for _ in range(20):
        accepted = await edge('full_stall', 0, waiting)
        oracle.check(not accepted, len(rows)-1, 'pre', 'FULL_ACCEPTED_WHILE_STALLED')
    await send('release_full', waiting)
    await idle('drain_full', capacity + 10)

    if frame_mode:
        await send('bad_frame', beat(3, last=0))
        await send('bad_frame', beat(4, user=1))
        await idle('bad_frame', 6)
        await send('good_after_bad', beat(5))
        await idle('good_after_bad', 8)
        for n in range(capacity + 2):
            await send('oversize', beat(n, last=int(n == capacity + 1)))
        await idle('oversize', 8)
        await send('good_after_oversize', beat(6))
        await idle('good_after_oversize', 8)

    for n in range(4):
        await send('queue_before_reset', beat(200 + n), 0)
    if frame_mode:
        await send('queue_before_reset', beat(210, last=0), 0)
        await send('queue_before_reset', beat(211, last=0), 0)
    await idle('queue_before_reset', 5, 0)
    await edge('reset_cancel', 0, reset=True)
    await idle('after_reset', 2)
    await send('after_reset', beat(45))
    await idle('after_reset', 8)

    statistics = trace_summary(rows, phases, capacity, config['KEEP_WIDTH'])
    pending = len(oracle.committed) + len(oracle.pending)
    oracle.check(pending == 0, len(rows)-1, 'post', 'IN_FLIGHT', count=pending)
    oracle.check(oracle.cancelled == (6 if frame_mode else 4), len(rows)-1, 'post', 'CANCEL_COVERAGE', count=oracle.cancelled)
    oracle.check(not frame_mode or (oracle.bad_beats, oracle.oversize_beats) == (2, capacity + 2), len(rows)-1, 'post', 'DROP_COVERAGE')
    oracle.check(statistics['peakRam'] == capacity and statistics['peakPipe'] == 2 and statistics['longestOutputStall'] >= 20 and
                 all(statistics['wraps'].values()) and 'simultaneousRamReadWrite' in statistics['witnesses'], len(rows)-1, 'post', 'STORAGE_COVERAGE')
    oracle.check(statistics['statusDelayMismatches'] == 0, len(rows)-1, 'post', 'STATUS_DEPTH_PHASE')
    totals = {key: getattr(oracle, key) for key in ('accepted', 'consumed', 'cancelled', 'bad_beats', 'oversize_beats')}
    oracle.check(totals['accepted'] == totals['consumed'] + totals['cancelled'] + totals['bad_beats'] + totals['oversize_beats'] + pending,
                 len(rows)-1, 'post', 'ACCOUNTING')
    trace = dict(format='axis-fifo-trial-v1', parameters=config, columns=list(signals),
                 rows=[[list(pre.values()), list(post.values())] for _, pre, post in rows])
    (result_dir/'edges.json').write_text(json.dumps(trace, separators=(',', ':')) + '\n')
    report = dict(format='axis-fifo-trial-v1', fields=FIELDS, parameters=config, totals=totals, inFlight=pending,
                  errors=oracle.errors, errorCount=oracle.error_count, events=oracle.events, **statistics)
    (result_dir/'directed-summary.json').write_text(json.dumps(report, ensure_ascii=False) + '\n')
    suite = ET.Element('testsuite', name='axis_fifo_directed_trial', tests='1', failures=str(int(oracle.error_count != 0)))
    testcase = ET.SubElement(suite, 'testcase', name='independent_port_oracle_and_scenario_coverage')
    if oracle.error_count:
        ET.SubElement(testcase, 'failure', message=oracle.errors[0]['code']).text = json.dumps(oracle.errors[0])
    # The collector can complete on a bad DUT. The verify JUnit check reads the independent verdict.
    ET.ElementTree(suite).write(result_dir/'directed.xml', encoding='utf-8', xml_declaration=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('config', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    parameters = json.loads(args.config.read_text())['parameters']
    run(simulator='icarus', verilog_sources=[str(Path('rtl/axis_fifo.v').resolve())], toplevel='axis_fifo',
        module='directed_fifo', python_search=[str(Path(__file__).resolve().parent)], parameters=parameters,
        sim_build=str(args.out/'sim'), extra_env={'RANDOM_SEED': '1', 'FIFO_TRIAL_OUT': str(args.out),
                                                'FIFO_TRIAL_PARAMETERS': json.dumps(parameters)})
