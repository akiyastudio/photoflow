"""Optional bridge from the Windows component to PairDETR and SAM 2.1 in WSL."""

from __future__ import annotations

import base64
import json
import os
import shlex
import subprocess
from pathlib import Path


# Both names have been used by released and development setup flows. Try both
# automatically; PHOTOFLOW_WSL_DISTRO remains authoritative when explicitly set.
DEFAULT_DISTROS = ("PhotoFlowNative", "PhotoflowLab")
PAIR_PYTHON = "$HOME/miniforge3/envs/pairdetr/bin/python"
SAM2_PYTHON = "$HOME/miniforge3/envs/sam2/bin/python"


def component_directory():
    import sys
    return Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent


def script_path(name):
    candidates = [component_directory() / "advanced" / name]
    if hasattr(__import__("sys"), "_MEIPASS"):
        candidates.append(Path(__import__("sys")._MEIPASS) / "advanced" / name)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"高级人物检测脚本不存在：{name}")


def distro_candidates():
    configured = os.environ.get("PHOTOFLOW_WSL_DISTRO", "").strip()
    return (configured,) if configured else DEFAULT_DISTROS


def decode_process_output(value):
    if not value:
        return ""
    # wsl.exe emits UTF-16LE diagnostics on some Windows builds even when the
    # child command writes UTF-8. Detect that form so error codes stay readable.
    if b"\x00" in value:
        return value.decode("utf-16-le", errors="replace").strip()
    return value.decode("utf-8", errors="replace").strip()


def run_process(args, timeout=900):
    result = subprocess.run(
        args, check=False, capture_output=True, timeout=timeout,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    stdout = decode_process_output(result.stdout)
    stderr = decode_process_output(result.stderr)
    if result.returncode != 0:
        detail = stderr or stdout or f"退出代码 {result.returncode}"
        raise RuntimeError(detail[-4000:])
    return stdout


def wsl_path(path):
    resolved = str(Path(path).resolve())
    drive, tail = os.path.splitdrive(resolved)
    if drive and len(drive) == 2 and drive[1] == ":":
        return f"/mnt/{drive[0].lower()}/{tail.lstrip('\\/').replace(os.sep, '/')}"
    raise ValueError(f"高级后端暂不支持此路径：{resolved}")


def run_shell(command, timeout=900):
    missing_errors = []
    for candidate in distro_candidates():
        try:
            return run_process(["wsl.exe", "-d", candidate, "--", "bash", "-lc", command], timeout)
        except RuntimeError as error:
            if "WSL_E_DISTRO_NOT_FOUND" not in str(error):
                raise
            missing_errors.append(f"{candidate}: {error}")
    raise RuntimeError("；".join(missing_errors) or "没有可用的多人修脸 WSL 发行版")


class _WslJsonService:
    def __init__(self, python_path, script):
        self.process = None
        errors = []
        command = f"{python_path} {shlex.quote(wsl_path(script))} --serve"
        for candidate in distro_candidates():
            output_chunks = []
            process = subprocess.Popen(
                ["wsl.exe", "-d", candidate, "--", "bash", "-lc", command],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            while True:
                line = process.stdout.readline()
                if not line:
                    detail = decode_process_output(b"".join(output_chunks) + process.stderr.read()) or f"退出代码 {process.poll()}"
                    errors.append(f"{candidate}: {detail}")
                    break
                try:
                    message = json.loads(line.decode("utf-8", errors="replace"))
                except json.JSONDecodeError:
                    output_chunks.append(line)
                    continue
                if message.get("type") == "ready":
                    self.process = process
                    self.distro = candidate
                    return
            if "WSL_E_DISTRO_NOT_FOUND" not in errors[-1]:
                break
        raise RuntimeError("；".join(errors))

    def request(self, payload):
        if self.process is None or self.process.poll() is not None:
            raise RuntimeError("WSL 推理服务已经退出")
        encoded = base64.b64encode(json.dumps(payload, ensure_ascii=False).encode("utf-8")).decode("ascii")
        self.process.stdin.write((json.dumps({"payload_b64": encoded}) + "\n").encode("ascii"))
        self.process.stdin.flush()
        while True:
            line = self.process.stdout.readline()
            if not line:
                detail = decode_process_output(self.process.stderr.read())
                raise RuntimeError(detail or "WSL 推理服务未返回结果")
            try:
                message = json.loads(line.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                continue
            if "success" not in message:
                continue
            if not message["success"]:
                raise RuntimeError(message.get("error") or "WSL 推理失败")
            return message

    def close(self):
        if self.process is None:
            return
        try:
            if self.process.poll() is None:
                self.process.stdin.write(b'{"action":"shutdown"}\n')
                self.process.stdin.flush()
                self.process.wait(timeout=20)
        except Exception:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
        finally:
            self.process = None


class AdvancedBatchSession:
    """Keep PairDETR and SAM 2.1 resident only for the lifetime of one batch."""

    def __init__(self):
        self.pair = None
        self.sam = None

    def __enter__(self):
        try:
            self.pair = _WslJsonService(PAIR_PYTHON, script_path("pairdetr_service.py"))
            self.sam = _WslJsonService(SAM2_PYTHON, script_path("sam2_service.py"))
            return self
        except Exception:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, _type, _value, _traceback):
        if self.sam:
            self.sam.close()
        if self.pair:
            self.pair.close()

    def run_pairdetr(self, input_path, output_root, threshold):
        output_path = Path(output_root) / "pairdetr-boxes.json"
        self.pair.request({
            "image": wsl_path(input_path), "boxes_output": wsl_path(output_path),
            "pair_threshold": float(threshold),
        })
        payload = json.loads(output_path.read_text(encoding="utf-8"))
        return payload.get("boxes", [])

    def run_sam2(self, input_path, fused, output_root):
        boxes_path = Path(output_root) / "fused-boxes.json"
        boxes_path.write_text(json.dumps({
            "image": str(input_path),
            "boxes": [{"box_xyxy": item["box"], "pair_score": item["score"]} for item in fused],
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        sam_root = Path(output_root) / "sam2"
        sam_root.mkdir(parents=True, exist_ok=True)
        for stale in sam_root.glob("mask-*.png"):
            stale.unlink(missing_ok=True)
        for stale_name in ("report.json", "overlay.jpg"):
            (sam_root / stale_name).unlink(missing_ok=True)
        self.sam.request({
            "image": wsl_path(input_path), "boxes": wsl_path(boxes_path),
            "output_dir": wsl_path(sam_root), "max_image_edge": 4096,
        })
        return sorted(sam_root.glob("mask-*.png"))


def probe_advanced():
    try:
        pair_script = wsl_path(script_path("pairdetr_service.py"))
        sam_script = wsl_path(script_path("sam2_service.py"))
        command = " && ".join([
            f"test -x {PAIR_PYTHON}", f"test -x {SAM2_PYTHON}",
            "test -s $HOME/model-lab/checkpoints/pairdetr/pytorch_model.bin",
            "test -s $HOME/model-lab/checkpoints/sam2/sam2.1_hiera_large.pt",
            f"test -r {shlex.quote(pair_script)}", f"test -r {shlex.quote(sam_script)}",
        ])
        run_shell(command, 60)
        return True, ""
    except Exception as error:
        return False, str(error)


def run_pairdetr(input_path, output_root, threshold):
    script = wsl_path(script_path("pairdetr_service.py"))
    image = wsl_path(input_path)
    output_path = Path(output_root) / "pairdetr-boxes.json"
    output = wsl_path(output_path)
    command = " ".join([
        PAIR_PYTHON, shlex.quote(script), "--image", shlex.quote(image),
        "--pair-threshold", shlex.quote(str(threshold)),
        "--boxes-output", shlex.quote(output),
    ])
    run_shell(command, 15 * 60)
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    return payload.get("boxes", [])


def run_sam2(input_path, fused, output_root):
    script = wsl_path(script_path("sam2_service.py"))
    image = wsl_path(input_path)
    boxes_path = Path(output_root) / "fused-boxes.json"
    boxes_path.write_text(json.dumps({
        "image": str(input_path),
        "boxes": [{"box_xyxy": item["box"], "pair_score": item["score"]} for item in fused],
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    boxes = wsl_path(boxes_path)
    sam_root = Path(output_root) / "sam2"
    sam_root.mkdir(parents=True, exist_ok=True)
    for stale in sam_root.glob("mask-*.png"):
        stale.unlink(missing_ok=True)
    for stale_name in ("report.json", "overlay.jpg"):
        (sam_root / stale_name).unlink(missing_ok=True)
    output = wsl_path(sam_root)
    command = " ".join([
        SAM2_PYTHON, shlex.quote(script), "--image", shlex.quote(image),
        "--boxes", shlex.quote(boxes), "--output-dir", shlex.quote(output),
        "--max-image-edge", "4096",
    ])
    run_shell(command, 20 * 60)
    masks = sorted(sam_root.glob("mask-*.png"))
    return masks
