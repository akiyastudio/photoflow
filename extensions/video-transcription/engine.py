#!/usr/bin/env python3
"""Private JSONL transcription engine for the PhotoFlow component.

Paths are accepted only over the service-private pipe and are never emitted.
The engine and its models are owned by this plugin directory.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable


@dataclass(frozen=True)
class Segment:
    seq: int
    start: float
    end: float
    text: str


PROMPT_ARTIFACT_RE = re.compile(r"^(?:请?使用简体中文)+$")


CURRENT_REQUEST_ID = ""
SUPPORTED_MODELS = frozenset({
    "tiny", "tiny.en", "base", "base.en", "small", "small.en", "medium", "medium.en",
    "large-v1", "large-v2", "large-v3", "large-v3-turbo", "distil-large-v2",
    "distil-large-v3", "distil-medium.en", "distil-small.en",
})


def emit(value: dict) -> None:
    if CURRENT_REQUEST_ID and "requestId" not in value:
        value = {**value, "requestId": CURRENT_REQUEST_ID}
    sys.stdout.write(json.dumps(value, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def format_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def simplify(text: str) -> str:
    try:
        from opencc import OpenCC
    except ImportError as exc:
        raise RuntimeError("缺少 opencc-python-reimplemented；请安装插件算法依赖") from exc
    if not hasattr(simplify, "converter"):
        simplify.converter = OpenCC("tw2sp")  # type: ignore[attr-defined]
    return simplify.converter.convert(text)  # type: ignore[attr-defined]


def normalize_text(text: str, simplify_chinese: bool) -> str:
    normalized = " ".join(str(text).replace("\r", " ").replace("\n", " ").split())
    if simplify_chinese and normalized:
        normalized = simplify(normalized)
    artifact_key = re.sub(r"[\s,，.。!！?？;；:：\"'“”‘’]+", "", normalized)
    return "" if PROMPT_ARTIFACT_RE.fullmatch(artifact_key) else normalized


def normalize_segments(values: Iterable[object], simplify_chinese: bool) -> list[Segment]:
    result: list[Segment] = []
    for value in values:
        text = normalize_text(str(getattr(value, "text")), simplify_chinese)
        if text:
            result.append(Segment(len(result) + 1, float(getattr(value, "start")), float(getattr(value, "end")), text))
    return result


def write_srt(output_path: Path, segments: list[Segment]) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    blocks = [f"{index}\n{format_timestamp(item.start)} --> {format_timestamp(item.end)}\n{item.text}\n" for index, item in enumerate(segments, 1)]
    pending = output_path.with_name(output_path.name + ".tmp")
    pending.write_text("\n".join(blocks), encoding="utf-8-sig")
    pending.replace(output_path)


def model_source(model: str) -> str:
    if model not in SUPPORTED_MODELS:
        raise RuntimeError("不支持的语音识别模型")
    component_root = Path(__file__).resolve().parent
    try:
        root = (component_root / "models").resolve(strict=True)
        root.relative_to(component_root)
    except (FileNotFoundError, OSError, ValueError) as exc:
        raise RuntimeError("插件模型根目录缺失或不安全") from exc
    candidate = root / model
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root)
    except (FileNotFoundError, OSError, ValueError) as exc:
        raise RuntimeError(f"模型 {model} 未安装；请将完整模型放入插件 models/{model} 目录") from exc
    required = ("config.json", "model.bin", "tokenizer.json")
    try:
        valid_files = all((resolved / name).is_file() and (resolved / name).resolve(strict=True).is_relative_to(resolved) for name in required)
    except (FileNotFoundError, OSError):
        valid_files = False
    if not resolved.is_dir() or not valid_files:
        raise RuntimeError(f"模型 {model} 不完整；需要 config.json、model.bin 和 tokenizer.json")
    return str(resolved)


def configure_windows_cuda() -> None:
    if sys.platform != "win32":
        return
    candidates = []
    if os.environ.get("CUDA_PATH"):
        candidates.append(Path(os.environ["CUDA_PATH"]) / "bin")
    candidates.append(Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Blackmagic Design" / "DaVinci Resolve")
    for directory in candidates:
        if directory.is_dir():
            os.environ["PATH"] = f"{directory}{os.pathsep}{os.environ.get('PATH', '')}"
            try:
                os.add_dll_directory(str(directory))
            except (AttributeError, FileNotFoundError, OSError):
                pass


def fake_transcribe(request: dict) -> tuple[list[Segment], str, bool]:
    data = Path(request["inputPath"]).read_text(encoding="utf-8", errors="replace")
    if "FAIL_TRANSCRIPTION" in data:
        raise RuntimeError("测试转录失败")
    delay = float(os.environ.get("PHOTOFLOW_TRANSCRIPTION_FAKE_DELAY", "0"))
    lines = [line.strip() for line in data.splitlines() if line.strip() and line.strip() != "SLOW_TRANSCRIPTION"] or ["测试字幕"]
    result = []
    for index, line in enumerate(lines):
        if delay:
            time.sleep(delay)
        result.append(Segment(index + 1, index * 1.5, (index + 1) * 1.5, line))
        emit({"type": "progress", "progress": round((index + 1) * 100 / len(lines), 2), "segments": index + 1})
    return result, "zh", False


class ModelSession:
    def __init__(self) -> None:
        self.model = None
        self.signature: tuple[str, str, str, bool] | None = None
        self.cpu_fallback = False

    def get(self, options: dict):
        from faster_whisper import WhisperModel
        device = str(options.get("device") or "cuda")
        compute_type = str(options.get("computeType") or ("int8" if device == "cpu" else "float16"))
        model_name = str(options.get("model") or "large-v3")
        signature = (model_name, device, compute_type, bool(options.get("cpuFallback", True)))
        if self.model is not None and self.signature == signature:
            return self.model, self.cpu_fallback
        try:
            self.model = WhisperModel(model_source(model_name), device=device, compute_type=compute_type)
            self.cpu_fallback = False
        except Exception as first_error:
            if device == "cpu" or not options.get("cpuFallback", True):
                raise RuntimeError(f"模型加载失败：{first_error}") from first_error
            emit({"type": "diagnostic", "code": "CPU_FALLBACK", "message": "GPU 不可用，已回退到 CPU int8"})
            self.model = WhisperModel(model_source(model_name), device="cpu", compute_type="int8")
            self.cpu_fallback = True
        self.signature = signature
        return self.model, self.cpu_fallback


def transcribe(request: dict, session: ModelSession) -> dict:
    options = request.get("options") or {}
    fallback = False
    if os.environ.get("PHOTOFLOW_TRANSCRIPTION_FAKE") == "1":
        segments, language, fallback = fake_transcribe(request)
    else:
        configure_windows_cuda()
        try:
            __import__("faster_whisper")
        except ImportError as exc:
            raise RuntimeError("缺少 faster-whisper；请先在插件目录运行 npm run setup") from exc
        model, fallback = session.get(options)
        iterator, info = model.transcribe(
            request["inputPath"], language=options.get("language"), task="transcribe",
            beam_size=int(options.get("beamSize") or 5), vad_filter=options.get("vadFilter", True),
        )
        raw = []
        for item in iterator:
            raw.append(item)
            duration = float(getattr(info, "duration", 0) or 0)
            emit({"type": "progress", "progress": min(99.0, float(item.end) * 100 / duration) if duration else 0, "segments": len(raw)})
        language = str(getattr(info, "language", options.get("language") or ""))
        segments = normalize_segments(raw, bool(options.get("simplifyChinese", True) and language == "zh"))
    write_srt(Path(request["outputPath"]), segments)
    return {"type": "result", "language": language, "segments": [asdict(item) for item in segments], "cpuFallback": fallback}


def diagnose() -> int:
    missing = []
    for module in ("faster_whisper", "opencc"):
        try:
            __import__(module)
        except Exception:
            missing.append(module)
    emit({"type": "diagnostic-result", "ready": not missing, "missing": missing, "packaged": getattr(sys, "frozen", False)})
    return 0


def main() -> int:
    if "--diagnose" in sys.argv:
        return diagnose()
    session = ModelSession()
    received = False
    for line in sys.stdin:
        if not line.strip():
            continue
        received = True
        try:
            request = json.loads(line)
            if request.get("type") == "shutdown":
                return 0
            if request.get("type") != "transcribe":
                raise ValueError("未知算法请求")
            global CURRENT_REQUEST_ID
            CURRENT_REQUEST_ID = str(request.get("requestId") or "")
            emit(transcribe(request, session))
        except Exception as exc:
            emit({"type": "error", "message": str(exc)})
        finally:
            CURRENT_REQUEST_ID = ""
    if not received:
        emit({"type": "error", "message": "算法运行时未收到请求"})
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
