"""Run the frozen upstream test and read its reports and Icarus waveform."""

import argparse
import configparser
from decimal import Decimal
import hashlib
from importlib import metadata
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import xml.etree.ElementTree as ET


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    with path.open("x", encoding="utf-8") as output:
        json.dump(value, output, indent=2, ensure_ascii=False)
        output.write("\n")


def environment(lock, simulator_dir):
    version = f"{sys.version_info.major}.{sys.version_info.minor}"
    if version != lock["python"]:
        raise ValueError(f"upstream CI uses Python {lock['python']}, got {version}")
    tox = configparser.ConfigParser()
    tox.read("tox.ini", encoding="utf-8")
    pinned = dict((name.strip(), expected.strip()) for name, expected in
                  (line.split("==", 1) for line in tox["testenv"]["deps"].splitlines() if line.strip()))
    for name, expected in pinned.items():
        if metadata.version(name) != expected:
            raise ValueError(f"tox.ini requires {name}=={expected}, got {metadata.version(name)}")
    env = {
        "PATH": os.pathsep.join((str(simulator_dir), str(Path(sys.executable).parent), os.defpath)),
        "LANG": "C.UTF-8",
        "SIM": lock["simulator"],
        "RANDOM_SEED": str(lock["seed"]),
        "WAVES": str(lock["waves"]),
        "PYTHONHASHSEED": "0",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    versions = {
        "python": {"executable": sys.executable, "version": sys.version.splitlines()[0]},
        "toxDependencies": pinned,
        "installedDistributions": dict(sorted((p.metadata["Name"], p.version) for p in metadata.distributions())),
    }
    for name in ("iverilog", "vvp"):
        tool = simulator_dir / name
        result = subprocess.run([str(tool), "-V"], env=env, text=True, capture_output=True, check=True, timeout=10)
        output = result.stdout + result.stderr
        if "version" not in output or re.search(r"not found|Unable to get version", output):
            raise ValueError(f"{name} is not set up: {output}")
        versions[name] = {
            "executable": str(tool),
            "sha256": digest(tool),
            "version": output.strip().splitlines()[0],
        }
    return env, versions


def cases_in(path):
    raw = path.read_bytes()
    if b"<!DOCTYPE" in raw.upper() or b"<!ENTITY" in raw.upper():
        raise ValueError(f"unexpected XML declarations in {path}")
    root = ET.fromstring(raw)
    return root, list(root.iter("testcase"))


def outcome(case):
    for child in case:
        if child.tag in ("failure", "error", "skipped"):
            return child.tag
    return "passed"


def collect_case(lock, config, outer, log, out):
    case_id = config["id"]
    name = f"test_axis_register[{case_id}]"
    if name not in outer:
        raise ValueError(f"missing pytest testcase {name}")
    work = Path("tb/axis_register/sim_build") / f"test_axis_register-{case_id}"
    reports = list(work.glob("*_results.xml"))
    if len(reports) != 1:
        raise ValueError(f"expected one cocotb XML, got {len(reports)} for {case_id}")
    shutil.copyfile(reports[0], out / "cocotb.xml")
    root, tests = cases_in(out / "cocotb.xml")
    names = [test.get("name") for test in tests]
    if sorted(names) != sorted(lock["cocotbTests"]) or any(test.get("classname") != "test_axis_register" for test in tests):
        raise ValueError(f"unexpected cocotb test inventory: {names}")
    seeds = [p.get("value") for p in root.iter("property") if p.get("name") == "random_seed"]
    if seeds != [str(lock["seed"])]:
        raise ValueError(f"unexpected cocotb seeds: {seeds}")

    commands = re.findall(r"^.*Running command: (.*)$", log, re.M)
    compile_commands = [cmd for cmd in commands if cmd.startswith("iverilog ") and str(work) + "/" in cmd]
    simulation_commands = [cmd for cmd in commands if cmd.startswith("vvp ") and str(work) + "/" in cmd]
    if len(compile_commands) != 1 or len(simulation_commands) != 1:
        raise ValueError(f"missing or repeated compile/simulation command for {case_id}")
    arguments = re.findall(r"-Paxis_register\.(\w+)=(\d+)(?=\s)", compile_commands[0])
    parameters = {key: int(value) for key, value in arguments}
    if len(arguments) != len(parameters) or parameters != config["parameters"]:
        raise ValueError(f"Icarus used unexpected parameters: {parameters}")

    wave = work / "axis_register.fst"
    shutil.copyfile(wave, out / "axis_register.fst")
    statuses = {test.get("name"): outcome(test) for test in tests}
    counts = {status: list(statuses.values()).count(status) for status in ("passed", "failure", "error", "skipped")}
    outer_status = outcome(outer[name])
    if counts["passed"] == len(tests) and outer_status == "passed":
        status = "PASS"
    elif counts["failure"] and not counts["error"] and not counts["skipped"] and outer_status == "failure":
        status = "FAIL"
    else:
        raise ValueError(f"inconsistent or incomplete reports: pytest={outer_status}, cocotb={counts}")
    return {
        "status": status,
        "case": case_id,
        "pytestTest": name,
        "parameters": parameters,
        "seed": int(seeds[0]),
        "counts": counts,
        "tests": statuses,
        "compileCommand": compile_commands[0],
        "simulationCommand": simulation_commands[0],
        "artifacts": {name: digest(out / name) for name in ("cocotb.xml", "axis_register.fst")},
    }


def upstream(lock, args):
    env, tools = environment(lock, args.icarus_bin)
    selected = [c for c in lock["configurations"] if not args.fault or c["id"] == lock["fault"]["case"]]
    target = lock["pytestFile"]
    if args.fault:
        target += f"::test_axis_register[{selected[0]['id']}]"
    command = [
        sys.executable, "-m", "pytest", "-c", "tox.ini", "-v", "-s", "-o", "log_cli=true",
        "--log-cli-level=INFO", "--show-capture=no", f"--junitxml={args.out / 'pytest.xml'}", target,
    ]
    original = {file: digest(Path(file)) for file in lock["files"]}
    if any(original[f] != sha for f, sha in lock["files"].items() if not args.fault or f != lock["fault"]["file"]):
        raise ValueError("upstream file differs from the frozen input")
    if args.fault:
        fault = lock["fault"]
        lines = Path(fault["file"]).read_bytes().split(b"\n")
        index = fault["line"] - 1
        if lines[index] != fault["after"].encode():
            raise ValueError("unexpected fault injection")
        lines[index] = fault["before"].encode()
        if hashlib.sha256(b"\n".join(lines)).hexdigest() != lock["files"][fault["file"]]:
            raise ValueError("fault copy contains additional source changes")
    if Path("tb/axis_register/sim_build").exists():
        raise ValueError("a fresh upstream copy is required")
    log_path = args.out / "pytest.log"
    timed_out = False
    with log_path.open("xb") as log:
        with subprocess.Popen(command, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True) as process:
            try:
                process.wait(timeout=120 if args.fault else 180)
            except subprocess.TimeoutExpired:
                timed_out = True
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    read_log = log_path.read_text(encoding="utf-8", errors="replace")
    results = {
        "argv": command,
        "cwd": str(Path.cwd()),
        "environment": env,
        "tools": tools,
        "exitCode": process.returncode,
        "timedOut": timed_out,
        "inputs": original,
        "inputsAfter": {file: digest(Path(file)) for file in lock["files"]},
        "artifacts": {"pytest.log": digest(log_path)},
        "cases": {},
    }
    try:
        if timed_out or process.returncode not in (0, 1):
            raise ValueError(f"pytest timed out or exited unexpectedly: {process.returncode}")
        if results["inputs"] != results["inputsAfter"]:
            raise ValueError("upstream input changed during pytest")
        outer_path = args.out / "pytest.xml"
        _, tests = cases_in(outer_path)
        outer = {t.get("name"): t for t in tests}
        expected = {f"test_axis_register[{c['id']}]" for c in selected}
        if len(tests) != len(expected) or set(outer) != expected:
            raise ValueError(f"unexpected pytest test inventory: {list(outer)}")
        if (process.returncode == 0) != all(outcome(t) == "passed" for t in tests):
            raise ValueError("pytest return code disagrees with its XML report")
        results["artifacts"]["pytest.xml"] = digest(outer_path)
        for config in selected:
            out = args.out / config["id"]
            out.mkdir()
            try:
                results["cases"][config["id"]] = collect_case(lock, config, outer, read_log, out)
            except (ValueError, OSError, ET.ParseError) as error:
                results["cases"][config["id"]] = {"status": "BLOCKED", "reason": str(error)}
    except (ValueError, OSError, ET.ParseError) as error:
        results["error"] = str(error)
    write_json(args.out / "upstream-results.json", results)
    if results.get("error") or any(c["status"] == "BLOCKED" for c in results["cases"].values()):
        raise ValueError("incomplete upstream evidence; see upstream-results.json and pytest.log")
    # A complete failing simulation still produces valid JUnit. rtlarch verify grades the XML.


PAYLOAD = ("tdata", "tkeep", "tlast", "tid", "tdest", "tuser")


def state_wave_names(reg_type):
    if reg_type == 0:
        return {}
    bank = [f"m_axis_{field}_reg" for field in (*PAYLOAD, "tvalid")]
    states = ["s_axis_tready_reg", *bank]
    if reg_type == 2:
        states.extend(f"temp_{name}" for name in bank)
    prefix = "genblk3." if reg_type == 1 else "genblk1."
    return {name: prefix + name for name in states}


def replay_samples(edges):
    def columns(phase):
        return {key: None if value is None else str(value) for key, value in phase.items()}

    return {
        "format": "rtlarch-rv-samples-v2", "clock": {"id": "clk", "edge": "rising"},
        "sampling": "pre_edge_handshake_post_edge_settled",
        "rows": [{"edge": i, "pre": columns(e["pre"]), "post": columns(e["post"])} for i, e in enumerate(edges)],
    }


def wave_changes(vcd, wanted):
    """Read stable timestamp groups from fst2vcd's Icarus output for this fixture."""
    scopes, labels, values = [], {}, {}
    tick = None
    for raw in vcd:
        line = raw.strip()
        if line.startswith("$scope "):
            scopes.append(line.split()[2])
        elif line.startswith("$upscope"):
            scopes.pop()
        elif line.startswith("$var "):
            _, _, _, symbol, name, *_ = line.split()
            full_name = ".".join([*scopes, name])
            if full_name in wanted:
                labels.setdefault(symbol, []).append(full_name)
        elif line.startswith("$enddefinitions"):
            break
    if {name for aliases in labels.values() for name in aliases} != wanted:
        raise ValueError("missing explicit DUT signals in Icarus dump")
    for raw in vcd:
        line = raw.strip()
        if line.startswith("#"):
            if tick is not None:
                yield tick, values.copy()
            tick = int(line[1:])
        elif line.startswith("b"):
            binary, symbol = line[1:].split()
            for name in labels.get(symbol, ()):
                values[name] = int(binary, 2) if re.fullmatch("[01]+", binary) else None
        elif line and line[0] in "01xXzZ":
            for name in labels.get(line[1:], ()):
                values[name] = int(line[0]) if line[0] in "01" else None
    if tick is not None:
        yield tick, values


def trace(lock, args):
    selected = next(c for c in lock["configurations"] if c["id"] == args.case)
    reg_type = selected["parameters"]["REG_TYPE"]
    path = args.upstream / args.case
    inputs = json.loads((args.upstream / "upstream-results.json").read_text())["cases"][args.case]["artifacts"]
    if any(digest(path / name) != sha for name, sha in inputs.items()):
        raise ValueError("trace input digest differs from upstream test result")
    converted = args.out.parent / "wave.vcd"
    with converted.open("xb") as vcd:
        subprocess.run([str(args.fst2vcd), "-f", str(path / "axis_register.fst")], stdout=vcd, check=True, timeout=30)
    _, inner = cases_in(path / "cocotb.xml")
    criteria = lock["acceptance"]["transaction"]
    tests = [test for test in inner if test.get("name") in (criteria["unpaused"], criteria["backpressure"])]
    if [t.get("name") for t in tests] != [criteria["unpaused"], criteria["backpressure"]]:
        raise ValueError("unexpected order of upstream directed tests")
    first_end = int(Decimal(tests[0].attrib["sim_time_ns"]) * 1000)
    second_end = first_end + int(Decimal(tests[1].attrib["sim_time_ns"]) * 1000)
    top = lock["top"]
    wanted = {"clk", "rst"} | {f"{axis}_{field}" for axis in ("s_axis", "m_axis") for field in (*PAYLOAD, "tvalid", "tready")}
    temp = "genblk1.temp_m_axis_tvalid_reg"
    if reg_type == 2:
        wanted.add(temp)
    state_names = state_wave_names(reg_type) if args.replay_samples else {}
    wanted.update(state_names.values())
    prefix = top + "."
    previous, first_edges, second_edges, transitions = {}, [], [], []
    with converted.open(encoding="utf-8") as vcd:
        header = []
        for line in vcd:
            header.append(line)
            if "$timescale" in line:
                header.extend((next(vcd), next(vcd)))
                break
        if not re.search(r"\$timescale\s+1ps\s+\$end", "".join(header)):
            raise ValueError("expected upstream 1 ps VCD time unit")
        for tick, raw in wave_changes(vcd, {prefix + name for name in wanted}):
            if tick >= second_end:
                break
            current = {key[len(prefix):]: value for key, value in raw.items()}
            if tick < first_end:
                transitions.append((tick, current))
            if previous.get("clk") == 0 and current.get("clk") == 1:
                edge = {"ps": tick, "pre": previous, "post": current}
                (first_edges if tick < first_end else second_edges).append(edge)
            previous = current

    def ready_valid(sample, side, ready=1):
        return sample[f"{side}_tvalid"] == 1 and sample[f"{side}_tready"] == ready and sample["rst"] == 0

    def payload(sample, side):
        values = {field: sample[f"{side}_{field}"] for field in PAYLOAD}
        if None in values.values():
            raise ValueError("unknown payload or sideband on a sampled valid beat")
        return values

    accepted = next(e for e in first_edges if ready_valid(e["pre"], "s_axis"))
    consumed = next(e for e in first_edges if ready_valid(e["pre"], "m_axis"))
    beat = payload(accepted["pre"], "s_axis")
    received = payload(consumed["pre"], "m_axis")
    if beat != received or received != {"tdata": 0, "tkeep": 1, "tlast": 1, "tid": 1, "tdest": 1, "tuser": 0}:
        raise ValueError(f"unexpected first upstream beat: {beat} -> {received}")
    visible = next(tick for tick, sample in transitions if tick <= consumed["ps"] and sample["rst"] == 0
                   and sample["m_axis_tvalid"] == 1 and payload(sample, "m_axis") == received)
    latency_ps = consumed["ps"] - accepted["ps"]
    if latency_ps != criteria["acceptToConsumeCycles"][reg_type] * 10000:
        raise ValueError(f"unexpected unpaused accept-to-consume latency: {latency_ps} ps")
    if visible > consumed["ps"] or (reg_type == 0 and visible >= accepted["ps"]) or (reg_type != 0 and visible != accepted["ps"]):
        raise ValueError(f"unexpected first output visibility at {visible} ps")

    blocked_at = next(i for i, e in enumerate(second_edges) if ready_valid(e["pre"], "m_axis", ready=0))
    released_at = next(i for i, e in enumerate(second_edges) if i > blocked_at and ready_valid(e["pre"], "m_axis"))
    stall = second_edges[blocked_at:released_at + 1]
    blocked = payload(stall[0]["pre"], "m_axis")
    if criteria["requireOutputHoldUntilConsumed"] and any(
        e["pre"]["m_axis_tvalid"] != 1 or e["pre"]["rst"] != 0 or payload(e["pre"], "m_axis") != blocked for e in stall
    ):
        raise ValueError("stalled beat did not remain valid and stable until consumed")
    temp_at = next((e for e in second_edges if e["pre"]["rst"] == 0 and e["post"].get(temp) == 1), None)
    if reg_type == 2 and criteria["requireSkidTempOccupied"] and temp_at is None:
        raise ValueError("skid temporary slot was never occupied during the upstream backpressure test")

    native = []
    if args.replay_samples:
        for tag, test, edges in zip(("unpaused", "backpressure"), tests, (first_edges, second_edges)):
            # Pre-reset startup is excluded for registered transaction identities. The retained prefix is continuous.
            start = next(i for i, e in enumerate(edges) if e["pre"]["rst"] == 1) if reg_type else 0
            sampled = []
            for edge in edges[start:]:
                sampled.append({phase: {**{k: v for k, v in edge[phase].items() if "." not in k},
                                        **{name: edge[phase][pin] for name, pin in state_names.items()}}
                                for phase in ("pre", "post")})
            if any(b["ps"] - a["ps"] != 10000 for a, b in zip(edges[start:], edges[start + 1:])):
                raise ValueError(f"non-continuous sample edges for {tag}")
            sample_file = args.out.with_name(f"{tag}.samples.json")
            write_json(sample_file, replay_samples(sampled))
            native.append({"name": tag, "test": test.get("name"), "file": sample_file.name,
                           "omittedPreResetEdges": start, "firstPs": edges[start]["ps"], "lastPs": edges[-1]["ps"],
                           "edges": len(sampled), "sha256": digest(sample_file)})

    write_json(args.out, {
        "status": "PASS",
        "case": args.case,
        "basis": "original_upstream_icarus_fst",
        "inputSha256": inputs,
        "sampling": "pre/post are stable VCD values immediately before/after the timestamp of a rising edge",
        "nativeScenarios": native,
        "unpaused": {"test": criteria["unpaused"], "accepted": accepted, "firstVisiblePs": visible,
                     "consumed": consumed, "acceptToConsumeCycles": latency_ps // 10000, "beat": received},
        "backpressure": {"test": criteria["backpressure"], "stalledThenConsumed": stall, "beat": blocked,
                         "firstTempOccupied": temp_at},
    })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    probe = commands.add_parser("upstream")
    probe.add_argument("--icarus-bin", required=True, type=Path)
    probe.add_argument("--out", required=True, type=Path)
    probe.add_argument("--fault", action="store_true")
    evidence = commands.add_parser("trace")
    evidence.add_argument("--fst2vcd", required=True, type=Path)
    evidence.add_argument("--case", required=True)
    evidence.add_argument("--upstream", required=True, type=Path)
    evidence.add_argument("--out", required=True, type=Path)
    evidence.add_argument("--replay-samples", action="store_true")
    args = parser.parse_args()
    lock = json.loads(Path("baseline.json").read_text())
    if args.command == "upstream":
        upstream(lock, args)
    else:
        trace(lock, args)


if __name__ == "__main__":
    main()
