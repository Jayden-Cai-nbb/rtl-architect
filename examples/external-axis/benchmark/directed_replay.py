"""Complement the frozen upstream tests with field-distinct, long-stall and cancellation traces."""

import argparse
from collections import deque
import json
import os
from pathlib import Path
import sys

import cocotb
from cocotb.triggers import Timer
from cocotb_test.simulator import run

from probe import PAYLOAD, digest, environment, replay_samples, state_wave_names, write_json


def oracle(edges, reg_type, constants):
    """Check public transfer order using an independent end-to-end queue."""
    queue, failures = deque(), []
    accepted, consumed, cancelled = [], [], []
    for i, edge in enumerate(edges):
        p = edge["pre"]
        if p["rst"] and reg_type:
            cancelled.extend({"edge": i, "sequence": n} for n, _ in queue)
            queue.clear()
            continue
        if p["s_axis_tvalid"] and p["s_axis_tready"]:
            expected = {f: constants.get(f, p[f"s_axis_{f}"]) for f in PAYLOAD}
            queue.append((len(accepted), expected))
            accepted.append({"edge": i, "fields": expected})
        if p["m_axis_tvalid"] and p["m_axis_tready"]:
            actual = {f: p[f"m_axis_{f}"] for f in PAYLOAD}
            sequence, expected = queue.popleft() if queue else (None, None)
            consumed.append({"edge": i, "sequence": sequence})
            if expected != actual:
                failures.append({"edge": i, "sequence": sequence, "expected": expected, "actual": actual})
    return {"accepted": accepted, "consumed": consumed, "cancelled": cancelled, "failures": failures,
            "inFlight": [sequence for sequence, _ in queue]}


@cocotb.test()
async def capture_directed(dut):
    out = Path(os.environ["RTLARCH_AXIS_TRACE_OUT"])
    p = json.loads(os.environ["RTLARCH_AXIS_TRACE_PARAMETERS"])
    reg_type = p["REG_TYPE"]
    states = state_wave_names(reg_type)
    inputs = {field: getattr(dut, f"s_axis_{field}") for field in PAYLOAD}
    names = ("rst", *(f"{axis}_{field}" for axis in ("s_axis", "m_axis") for field in (*PAYLOAD, "tvalid", "tready")))
    pins = {name: getattr(dut, name) for name in names}
    for name, hier in states.items():
        handle = dut
        for part in hier.split("."):
            handle = getattr(handle, part)
        pins[name] = handle
    edges = []
    phases = {}

    def beat(n):
        # Every tdata is equal. Some complete beats repeat, and the other fields vary independently.
        return dict(tdata=0x5a, tkeep=n % (1 << p["KEEP_WIDTH"]), tlast=(n >> 1) & 1,
                    tid=n * 7 % (1 << p["ID_WIDTH"]), tdest=(n * 3 + 0xa1) % (1 << p["DEST_WIDTH"]),
                    tuser=(n >> 2) % (1 << p["USER_WIDTH"]))

    def snapshot():
        return {name: int(pin.value) if pin.value.is_resolvable else None for name, pin in pins.items()}

    async def edge(reset, ready, offered=None):
        dut.clk.value = 0
        dut.rst.value = reset
        dut.m_axis_tready.value = ready
        dut.s_axis_tvalid.value = int(offered is not None)
        for field, pin in inputs.items():
            pin.value = (offered or beat(0))[field]
        await Timer(5, units="ns")
        pre = snapshot()
        dut.clk.value = 1
        await Timer(5, units="ns")
        edges.append({"pre": pre, "post": snapshot()})
        return pre["s_axis_tready"] and pre["s_axis_tvalid"]

    async def phase(name, sequence, ready, cycles, drain):
        first = len(edges)
        for _ in range(cycles):
            if await edge(0, ready, beat(sequence[0]) if sequence else None):
                sequence.popleft()
        phases[name] = [first, len(edges) - 1]
        if drain:
            assert not sequence, f"incomplete stimulus for {name}"

    await edge(1, 0)
    await edge(0, 1)
    await phase("continuous", deque([1, 1, 2, 3, 4, 5]), 1, 15, True)
    waiting = deque([6, 7, 8, 9])
    await phase("long_stall", waiting, 0, 18, False)
    await phase("recover", waiting, 1, 12, True)
    await phase("fill_for_reset", deque([10, 11, 12]), 0, 4, False)
    phases["reset"] = [len(edges), len(edges)]
    # A physically transparent bypass also transfers during the reset marker.
    await edge(1, int(reg_type == 0), beat(16) if reg_type == 0 else None)
    await phase("restart", deque([20, 21]), 1, 12, True)

    constants = {field: value for field, enable, value in (
        ("tkeep", "KEEP_ENABLE", (1 << p["KEEP_WIDTH"]) - 1), ("tlast", "LAST_ENABLE", 1),
        ("tid", "ID_ENABLE", 0), ("tdest", "DEST_ENABLE", 0), ("tuser", "USER_ENABLE", 0),
    ) if not p[enable]}
    write_json(out / "directed.samples.json", replay_samples(edges))
    write_json(out / "directed-oracle.json", {"parameters": p, "phases": phases, **oracle(edges, reg_type, constants)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", required=True)
    parser.add_argument("--icarus-bin", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    lock = json.loads(Path("baseline.json").read_text())
    config = next(c for c in lock["configurations"] if c["id"] == args.case)
    env, versions = environment(lock, args.icarus_bin)
    parameters = config["parameters"]
    source = Path("rtl/axis_register.v").resolve()
    out = args.out.resolve()
    write_json(out / "directed-inputs.json", {"source": str(source), "sourceSha256": digest(source), "parameters": parameters,
               "tools": versions, "seed": lock["seed"], "argv": sys.argv})
    os.environ.update(env)
    run(verilog_sources=[str(source)], toplevel=lock["top"], module=Path(__file__).stem, simulator=lock["simulator"],
        python_search=[str(Path(__file__).resolve().parent)], parameters=parameters, waves=False, sim_build=str(out / "directed-build"),
        extra_env={"RTLARCH_AXIS_TRACE_OUT": str(out), "RTLARCH_AXIS_TRACE_PARAMETERS": json.dumps(parameters)})


if __name__ == "__main__":
    main()
