"""Optional bridge from the Windows component to PairDETR and SAM 2.1 in WSL."""

from __future__ import annotations

import base64
import json
import os
import shlex
import subprocess
import re
import queue
import threading
import time
import uuid
from collections import deque
from pathlib import Path


DISTRO_NAME = "PhotoFlowNative"
PAIR_PYTHON = "$HOME/miniforge3/envs/pairdetr/bin/python"
SAM2_PYTHON = "$HOME/miniforge3/envs/sam2/bin/python"


def _mask_sort_key(path):
    match = re.search(r"(\d+)(?=\.[^.]+$)", Path(path).name)
    return (int(match.group(1)) if match else 2 ** 31, Path(path).name)


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
    return (configured or DISTRO_NAME,)


def decode_process_output(value):
    if not value:
        return ""
    # wsl.exe emits UTF-16LE diagnostics on some Windows builds even when the
    # child command writes UTF-8. Detect that form so error codes stay readable.
    if b"\x00" in value:
        return value.decode("utf-16-le", errors="replace").strip()
    return value.decode("utf-8", errors="replace").strip()


def is_unavailable_distro_error(error):
    detail = str(error).upper()
    return any(marker in detail for marker in (
        "WSL_E_DISTRO_NOT_FOUND",
        "HCS/ERROR_PATH_NOT_FOUND",
        "HCS_E_PATH_NOT_FOUND",
        "Wsl/Service/CreateInstance/MountDisk/HCS/ERROR_PATH_NOT_FOUND".upper(),
    ))


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
            if not is_unavailable_distro_error(error):
                raise
            missing_errors.append(f"{candidate}: {error}")
    raise RuntimeError("；".join(missing_errors) or "没有可用的团片协作 WSL 发行版")


class _WslJsonService:
    def __init__(self, python_path, script):
        self.process = None
        self.stdout_lines = None
        self.stderr_tail = None
        self.reader_threads = []
        self.request_lock = threading.Lock()
        errors = []
        command = f"{python_path} {shlex.quote(wsl_path(script))} --serve"
        for candidate in distro_candidates():
            output_chunks = []
            process = subprocess.Popen(
                ["wsl.exe", "-d", candidate, "--", "bash", "-lc", command],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            self._start_readers(process)
            while True:
                try:
                    line = self._readline(120)
                except TimeoutError:
                    self._close_process(process, force=True)
                    errors.append(f"{candidate}: WSL inference service startup timed out")
                    break
                if not line:
                    # EOF is a failed startup too. Fully reap this candidate
                    # before deciding whether another distro may be attempted.
                    self._close_process(process, force=True)
                    detail = decode_process_output((b"".join(output_chunks) + b"".join(self.stderr_tail))[-8000:]) or f"退出代码 {process.poll()}"
                    errors.append(f"{candidate}: {detail}")
                    break
                try:
                    message = json.loads(line.decode("utf-8", errors="replace"))
                except json.JSONDecodeError:
                    output_chunks.append(line)
                    continue
                if message.get("type") == "ready" and message.get("protocolVersion") == 1:
                    self.process = process
                    self.distro = candidate
                    return
            if not is_unavailable_distro_error(errors[-1]):
                break
        raise RuntimeError("；".join(errors))

    def _start_readers(self, process):
        # The producer must never wait for the JSON consumer.  PairDETR and
        # SAM can emit large diagnostics bursts before the caller resumes.
        self.stdout_lines = queue.SimpleQueue()
        self.stderr_tail = deque(maxlen=128)
        def read_stdout():
            for line in iter(process.stdout.readline, b""):
                self.stdout_lines.put(line)
            self.stdout_lines.put(None)
        def read_stderr():
            for chunk in iter(lambda: process.stderr.read(1024), b""):
                self.stderr_tail.append(chunk)
        self.reader_threads = [
            threading.Thread(target=read_stdout, daemon=True, name="photoflow-wsl-stdout"),
            threading.Thread(target=read_stderr, daemon=True, name="photoflow-wsl-stderr"),
        ]
        for worker in self.reader_threads:
            worker.start()

    def _readline(self, timeout):
        try:
            return self.stdout_lines.get(timeout=max(0.001, timeout))
        except queue.Empty as error:
            raise TimeoutError(f"WSL inference service did not respond within {timeout:.1f} seconds") from error

    def _close_process(self, process=None, force=False):
        process = process or self.process
        if process is None:
            return
        if process.poll() is None:
            (process.kill if force else process.terminate)()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
        for stream in (getattr(process, "stdin", None), getattr(process, "stdout", None), getattr(process, "stderr", None)):
            try:
                stream.close()
            except Exception:
                pass
        for worker in self.reader_threads:
            if worker is not threading.current_thread():
                worker.join(timeout=2)

    def request(self, payload, timeout=20 * 60):
        with self.request_lock:
            if self.process is None or self.process.poll() is not None:
                raise RuntimeError("WSL 推理服务已经退出")
            request_id = uuid.uuid4().hex
            request_payload = {**payload, "requestId": request_id, "protocolVersion": 1}
            encoded = base64.b64encode(json.dumps(request_payload, ensure_ascii=False).encode("utf-8")).decode("ascii")
            self.process.stdin.write((json.dumps({"payload_b64": encoded}) + "\n").encode("ascii"))
            self.process.stdin.flush()
            deadline = time.monotonic() + timeout
            stale_count = 0
            while True:
                try:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise TimeoutError(f"WSL inference service did not respond within {timeout} seconds")
                    line = self._readline(remaining)
                except TimeoutError:
                    self._close_process(force=True)
                    raise
                if not line:
                    detail = decode_process_output(b"".join(self.stderr_tail)[-8000:])
                    raise RuntimeError(detail or "WSL 推理服务未返回结果")
                try: message = json.loads(line.decode("utf-8", errors="replace"))
                except json.JSONDecodeError: continue
                if "success" not in message: continue
                if message.get("protocolVersion") != 1 or message.get("requestId") != request_id:
                    stale_count += 1
                    if stale_count > 32: raise RuntimeError("WSL 推理服务返回过多不匹配响应")
                    continue
                if not message["success"]: raise RuntimeError(message.get("error") or "WSL 推理失败")
                return message

    def close(self):
        if self.process is None:
            return
        try:
            if self.process.poll() is None:
                self.request({"action": "shutdown"}, timeout=20)
        except Exception:
            self._close_process()
        finally:
            self._close_process()
            self.process = None
            self.stdout_lines = None
            self.stderr_tail = None
            self.reader_threads = []


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
        errors = []
        for service in (self.sam, self.pair):
            if service:
                try: service.close()
                except Exception as error: errors.append(error)
        if errors and _value is None: raise errors[0]

    def run_pairdetr(self, input_path, output_root, threshold):
        payload, output_path = _prepare_pair_request(input_path, output_root, threshold)
        self.pair.request(payload)
        return _parse_pair_output(output_path)

    def run_sam2(self, input_path, fused, output_root):
        payload, sam_root = _prepare_sam_request(input_path, fused, output_root)
        self.sam.request(payload)
        return _parse_sam_masks(sam_root)


def _prepare_pair_request(input_path, output_root, threshold):
    output_path = Path(output_root) / "pairdetr-boxes.json"
    return {"image": wsl_path(input_path), "boxes_output": wsl_path(output_path), "pair_threshold": float(threshold)}, output_path


def _parse_pair_output(output_path):
    payload = json.loads(Path(output_path).read_text(encoding="utf-8"))
    return payload.get("boxes", [])


def _prepare_sam_request(input_path, fused, output_root):
    boxes_path = Path(output_root) / "fused-boxes.json"
    boxes_path.write_text(json.dumps({"image": str(input_path), "boxes": [{"box_xyxy": item["box"], "pair_score": item["score"]} for item in fused]}, ensure_ascii=False, indent=2), encoding="utf-8")
    sam_root = Path(output_root) / "sam2"; sam_root.mkdir(parents=True, exist_ok=True)
    for stale in sam_root.glob("mask-*.png"): stale.unlink(missing_ok=True)
    for stale_name in ("report.json", "overlay.jpg"): (sam_root / stale_name).unlink(missing_ok=True)
    return {"image": wsl_path(input_path), "boxes": wsl_path(boxes_path), "output_dir": wsl_path(sam_root), "max_image_edge": 4096}, sam_root


def _parse_sam_masks(sam_root):
    return sorted(Path(sam_root).glob("mask-*.png"), key=_mask_sort_key)


def probe_advanced(timeout=12, retry_timeout=12):
    try:
        pair_script = wsl_path(script_path("pairdetr_service.py"))
        sam_script = wsl_path(script_path("sam2_service.py"))
        command = " && ".join([
            f"test -x {PAIR_PYTHON}", f"test -x {SAM2_PYTHON}",
            "test -s $HOME/model-lab/checkpoints/pairdetr/pytorch_model.bin",
            "test -s $HOME/model-lab/checkpoints/sam2/sam2.1_hiera_large.pt",
            f"test -r {shlex.quote(pair_script)}", f"test -r {shlex.quote(sam_script)}",
        ])
        try:
            run_shell(command, timeout)
        except subprocess.TimeoutExpired:
            # A stopped WSL 2 distribution can take longer than the original
            # eight-second probe budget to cold-start. The timed-out wsl.exe is
            # terminated, but the distribution commonly finishes starting in
            # the background, so one bounded retry avoids reporting a healthy
            # installation as incomplete. Other errors remain authoritative.
            run_shell(command, retry_timeout)
        return True, ""
    except Exception as error:
        return False, str(error)


def run_pairdetr(input_path, output_root, threshold):
    script = wsl_path(script_path("pairdetr_service.py"))
    _payload, output_path = _prepare_pair_request(input_path, output_root, threshold)
    image = wsl_path(input_path); output = wsl_path(output_path)
    command = " ".join([
        PAIR_PYTHON, shlex.quote(script), "--image", shlex.quote(image),
        "--pair-threshold", shlex.quote(str(threshold)),
        "--boxes-output", shlex.quote(output),
    ])
    run_shell(command, 15 * 60)
    return _parse_pair_output(output_path)


def run_sam2(input_path, fused, output_root):
    script = wsl_path(script_path("sam2_service.py"))
    _payload, sam_root = _prepare_sam_request(input_path, fused, output_root)
    image = wsl_path(input_path); boxes = wsl_path(Path(output_root) / "fused-boxes.json")
    output = wsl_path(sam_root)
    command = " ".join([
        SAM2_PYTHON, shlex.quote(script), "--image", shlex.quote(image),
        "--boxes", shlex.quote(boxes), "--output-dir", shlex.quote(output),
        "--max-image-edge", "4096",
    ])
    run_shell(command, 20 * 60)
    return _parse_sam_masks(sam_root)
