"""Prepare and observe the scoped standard application inside its disposable guest."""

import hashlib
import json
import os
import pwd
import select
import subprocess
import sys
from pathlib import Path

if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from build_guest import (
    NODE, OUTPUT as BUILD_OUTPUT, SOURCE, TOOLS, WORK as BUILD_WORK, canonical,
    copy_writable, directory_fd, dispatch, install_dependencies, measured_tree,
    read_bytes, standard_env, verify_boundary, verify_identity,
)


RUNTIME_REQUEST = SOURCE.parent / "baseline-request.json"
WORK = Path("/var/lib/itervane-runtime-work")
GATE = Path("/var/lib/itervane-runtime-gate")
OUTPUT = Path("/var/lib/itervane-runtime-output")
PROBE_RESULT = Path("/var/lib/itervane-baseline-output/checks.json")
APP = "itervane-runtime-app.service"
PREP = "itervane-runtime-prep.service"
PROBE = "itervane-runtime-check.service"
CGROUP = Path("/sys/fs/cgroup/system.slice") / APP
PORT = 38171


def write_once(path, value, mode=0o440):
    with path.open("xb") as stream:
        stream.write(value)
        os.fchmod(stream.fileno(), mode)


def load_plan():
    return json.loads(read_bytes(GATE / "plan.json", 2048))


def materialize(request, profile):
    project = WORK / "project"
    project.mkdir(mode=0o2750)
    for name, field, limit in (("package.json", "packageSha256", 65_536),
                               ("package-lock.json", "lockSha256", 512 * 1024)):
        content = read_bytes(SOURCE / "project" / name, limit)
        if hashlib.sha256(content).hexdigest() != profile[field]:
            raise ValueError("runtime manifest binding")
        write_once(project / name, content)
    with directory_fd(SOURCE / "project/server") as server:
        backend = measured_tree(server, 5000, 32 * 1024 * 1024, 2 * 1024 * 1024, copy_into=project / "server")
    with (directory_fd(BUILD_WORK) as work, directory_fd("project", work) as previous,
          directory_fd("dist", previous) as dist):
        output = measured_tree(dist, 1024, 64 * 1024 * 1024, 8 * 1024 * 1024, artifact=True, copy_into=project / "dist")
    if output["sha256"] != request["distSha256"]:
        raise ValueError("dist no longer matches the build receipt")
    app = pwd.getpwnam("itervane-app")
    os.chown(project, app.pw_uid, app.pw_gid)
    os.chmod(project, 0o2750)
    inputs = {"subjectManifestSha256": request["subjectManifestSha256"], "lockSha256": profile["lockSha256"],
              "packageSha256": profile["packageSha256"], "backendSha256": backend["sha256"], "distSha256": output["sha256"]}
    if request.get("healthFollowup") is True:
        inputs["healthFollowup"] = True
    plan = {**inputs, "baselineSha256": request["baselineSha256"], "runtimeInputsSha256": hashlib.sha256(canonical(inputs)).hexdigest(),
            "port": PORT, "version": "candidate-" + request["subjectManifestSha256"][:16]}
    write_once(GATE / "plan.json", canonical(plan), 0o444)
    return plan


def install():
    verify_boundary("itervane-app", (TOOLS, GATE))
    plan = load_plan()
    project, cache, config = WORK / "project", WORK / "cache", WORK / "empty.npmrc"
    for name, field, limit in (("package.json", "packageSha256", 65_536),
                               ("package-lock.json", "lockSha256", 512 * 1024)):
        if hashlib.sha256(read_bytes(project / name, limit)).hexdigest() != plan[field]:
            raise ValueError("runtime manifest binding")
    copy_writable(TOOLS / "npm-cache", cache)
    config.touch(mode=0o600, exist_ok=False)
    return 0 if install_dependencies(project, cache, config, production=True) == 0 else 1


def loopback_boundary(account, readonly):
    verify_identity(account)
    if sorted(os.listdir("/sys/class/net")) != ["lo"]:
        raise ValueError("runtime network has an external interface")
    for path in readonly:
        if not os.statvfs(path).f_flag & os.ST_RDONLY:
            raise ValueError("mutable runtime input")


def application():
    loopback_boundary("itervane-app", (TOOLS, GATE, WORK))
    plan = load_plan()
    project = WORK / "project"
    env = {**standard_env(WORK), "HOST": "127.0.0.1", "PORT": str(PORT), "NODE_ENV": "production",
           "ITERVANE_FIXTURE_VERSION": plan["version"]}
    os.chdir(project)
    os.execve(NODE, [NODE, project / "server/index.mjs"], env)


def observe():
    loopback_boundary("itervane-baseline", (TOOLS, GATE))
    os.execve(NODE, [NODE, TOOLS / "baseline-probe.mjs"], standard_env(GATE))


def systemctl(*args, timeout, capture=False):
    return subprocess.run(
        ["/usr/bin/systemctl", "--no-pager", "--no-ask-password", *args],
        env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE if capture else subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        check=False, timeout=timeout, text=True,
    )


def observe_and_stop(plan):
    outcome = {"status": "blocked", "code": "runtime_start"}
    pidfd = None
    try:
        if systemctl("start", APP, timeout=5).returncode:
            raise ValueError("runtime start")
        process = systemctl("show", APP, "-p", "MainPID", "-p", "ControlGroup", timeout=3, capture=True)
        props = dict(line.split("=", 1) for line in process.stdout.splitlines() if "=" in line)
        if process.returncode or props.get("ControlGroup") != "/system.slice/" + APP:
            raise ValueError("runtime process scope")
        pid = int(props["MainPID"])
        if pid <= 1:
            raise ValueError("runtime process missing")
        pidfd = os.pidfd_open(pid)
        outcome = {"status": "blocked", "code": "baseline_unavailable"}
        if systemctl("start", PROBE, timeout=24).returncode:
            raise ValueError("baseline check")
        report = json.loads(read_bytes(PROBE_RESULT, 4096))
        if report["runtimeInputsSha256"] != plan["runtimeInputsSha256"] or report["status"] not in ("passed", "failed"):
            raise ValueError("baseline report binding")
        if ("healthFollowup" in report) != (plan.get("healthFollowup") is True):
            raise ValueError("health follow-up binding")
        outcome = {"status": report["status"], "runtimeInputsSha256": plan["runtimeInputsSha256"], "checks": report["checks"]}
        if "healthFollowup" in report:
            if not isinstance(report["healthFollowup"], dict) or report["healthFollowup"].get("status") not in ("passed", "unhealthy", "unavailable"):
                raise ValueError("invalid health follow-up outcome")
            outcome["healthFollowup"] = report["healthFollowup"]
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        pass
    stopped = False
    try:
        command = systemctl("stop", APP, timeout=8)
        empty = not CGROUP.exists() or "populated 0" in (CGROUP / "cgroup.events").read_text().splitlines()
        exited = pidfd is None or bool(select.select([pidfd], [], [], 1)[0])
        stopped = command.returncode == 0 and empty and exited
    except (OSError, subprocess.SubprocessError):
        pass
    finally:
        if pidfd is not None:
            os.close(pidfd)
    if not stopped:
        return {"status": "blocked", "code": "runtime_cleanup_unproven"}
    if outcome["status"] in ("passed", "failed"):
        outcome["appExited"] = True
    return outcome


def observe_image(plan, request, profile):
    binding = {"version": 1, "ociInputsSha256": request["ociInputsSha256"],
               "runtimeInputsSha256": plan["runtimeInputsSha256"]}
    code = "image_inputs"
    try:
        from oci_guest import OUTPUT as image_output, SERVICE as image_service, prepare_image

        if profile.get("ociInputsSha256") != request["ociInputsSha256"]:
            raise ValueError("formal image profile mismatch")
        code = "runtime_projection"
        prepare_image(WORK / "project", plan, request, profile)
        code = "image_compose"
        if systemctl("start", image_service, timeout=58).returncode:
            raise ValueError("image composition")
        report = json.loads(read_bytes(image_output / "receipt.json", 2 * 1024**2 - 8192))
        if not isinstance(report, dict) or any(report.get(key) != value for key, value in binding.items()):
            raise ValueError("image receipt binding")
        return report
    except (ImportError, OSError, KeyError, RecursionError, TypeError, ValueError, subprocess.SubprocessError):
        return {**binding, "status": "blocked", "code": code}


def supervise():
    if os.getuid() != 0:
        raise ValueError("invalid runtime controller")
    launch = json.loads(read_bytes(RUNTIME_REQUEST, 2048))
    build = json.loads(read_bytes(BUILD_OUTPUT / "receipt.json", 2048))
    frozen = dispatch()
    binding = {name: frozen[name] for name in ("runId", "verificationInputSha256", "subjectManifestSha256",
                                                "buildProfileSha256", "baselineSha256", "projectionSha256")}
    if build.get("status") != "built" or any(build.get(key) != value for key, value in binding.items()):
        raise ValueError("runtime build binding")
    request = {**binding, "distSha256": build["dist"]["sha256"]}
    if launch.get("healthFollowup") is True:
        request["healthFollowup"] = True
    if "ociInputsSha256" in launch:
        request.update({name: launch[name] for name in ("ociInputsSha256", "scannerInputsSha256")})
        if launch.get("retainStandardImage") is True:
            request["retainStandardImage"] = True
    if launch != request:
        raise ValueError("runtime request binding")
    outcome = {"status": "blocked", "code": "runtime_preparation"}
    try:
        raw = read_bytes(TOOLS / "profile.json", 4096)
        profile = json.loads(raw)
        probe_sha = hashlib.sha256(read_bytes(TOOLS / "baseline-probe.mjs", 65_536)).hexdigest()
        if (hashlib.sha256(raw).hexdigest() == request["buildProfileSha256"]
            and profile["baselineSha256"] == request["baselineSha256"] and probe_sha == profile.get("baselineProbeSha256")):
            plan = materialize(request, profile)
            if systemctl("start", PREP, timeout=32).returncode == 0:
                outcome = observe_and_stop(plan)
                followup = outcome.get("healthFollowup")
                if outcome["status"] == "passed" and "ociInputsSha256" in request and (not followup or followup["status"] == "passed"):
                    outcome["image"] = observe_image(plan, request, profile)
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        pass
    result = {"version": 1, "baselineSha256": request["baselineSha256"], "distSha256": request["distSha256"], **outcome}
    pending = OUTPUT / "receipt.pending"
    write_once(pending, canonical({"request": request, "result": result}))
    pending.rename(OUTPUT / "receipt.json")
    return 0


if __name__ == "__main__":
    commands = {"install": install, "application": application, "observe": observe, "supervise": supervise}
    try:
        if len(sys.argv) == 2 and sys.argv[1] in commands:
            raise SystemExit(commands[sys.argv[1]]())
    except (OSError, TypeError, ValueError, KeyError, subprocess.SubprocessError):
        pass
    raise SystemExit(1)
