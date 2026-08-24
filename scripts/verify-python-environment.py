"""Verify installed Python packages and repository dependency declarations."""

from __future__ import annotations

import ast
import importlib.metadata as metadata
import os
from pathlib import Path
import subprocess
import sys

try:
    from packaging.requirements import Requirement
except ImportError:
    raise SystemExit("缺少依赖校验器 packaging；请先运行 npm run setup:python") from None


ROOT = Path(__file__).resolve().parent.parent
IMPORT_DISTRIBUTIONS = {
    "PIL": "Pillow",
    "cv2": "opencv-python-headless",
    "onnxruntime": "onnxruntime-directml",
    "pi_heif": "pi-heif",
    "send2trash": "Send2Trash",
}
ADVANCED_EXTERNAL_IMPORTS = {
    "PIL",
    "cv2",
    "hf_utils",  # PairDETR checkpoint payload, verified by the advanced setup.
    "numpy",
    "sam2",  # Pinned facebookresearch/sam2 checkout.
    "torch",
    "torchvision",
    "transformers",
}


def normalized(name: str) -> str:
    return name.lower().replace("_", "-").replace(".", "-")


def read_requirements(path: Path) -> dict[str, Requirement]:
    requirements: dict[str, Requirement] = {}
    for number, raw_line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw_line.split("#", 1)[0].strip()
        if not line or line.startswith("--"):
            continue
        if line.startswith("-r "):
            included = (path.parent / line[3:].strip()).resolve()
            requirements.update(read_requirements(included))
            continue
        try:
            requirement = Requirement(line)
        except ValueError as error:
            raise SystemExit(f"{path.relative_to(ROOT)}:{number}: 无效依赖声明：{error}") from None
        requirements[normalized(requirement.name)] = requirement
    return requirements


def imported_roots(paths: list[Path]) -> set[str]:
    roots: set[str] = set()
    for path in paths:
        tree = ast.parse(path.read_text(encoding="utf-8-sig"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                roots.update(alias.name.split(".", 1)[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                roots.add(node.module.split(".", 1)[0])
    return roots


def third_party_imports(paths: list[Path], local_modules: set[str]) -> set[str]:
    return {
        name for name in imported_roots(paths)
        if name not in sys.stdlib_module_names and name not in local_modules
    }


def audit_scope(
    label: str,
    paths: list[Path],
    declared: dict[str, Requirement],
    allowed: set[str] | None = None,
    local_paths: list[Path] | None = None,
) -> list[str]:
    local_modules = {path.stem for path in (local_paths or paths)}
    failures = []
    for import_name in sorted(third_party_imports(paths, local_modules)):
        distribution = IMPORT_DISTRIBUTIONS.get(import_name, import_name)
        if normalized(distribution) not in declared and import_name not in (allowed or set()):
            failures.append(f"{label}: 导入 {import_name}，但对应依赖 {distribution} 未声明")
    return failures


def verify_installed(requirements: dict[str, Requirement]) -> list[str]:
    failures = []
    for requirement in requirements.values():
        if requirement.marker and not requirement.marker.evaluate():
            continue
        try:
            version = metadata.version(requirement.name)
        except metadata.PackageNotFoundError:
            failures.append(f"未安装 {requirement.name}{requirement.specifier}")
            continue
        if requirement.specifier and version not in requirement.specifier:
            failures.append(f"{requirement.name} 版本为 {version}，要求 {requirement.specifier}")
    return failures


def verify_worker_imports() -> list[str]:
    python_root = ROOT / "python"
    modules = [
        "catch", "classify", "cut_video", "ffmpeg_transcode", "png_to_jpg",
        "raw_decoder", "rename", "thumbnail_db", "thumbnail_image", "video_preview",
        "workspace_db", "operations_db", "team_retouch_db", "backup_db", "research",
        "office_media_extract", "screenshot_main_image",
    ]
    failures = []
    environment = os.environ.copy()
    environment["PYTHONPATH"] = str(python_root)
    for module in modules:
        result = subprocess.run(
            [sys.executable, "-c", f"import {module}"],
            cwd=ROOT,
            env=environment,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if result.returncode:
            detail = (result.stderr or result.stdout).strip().splitlines()
            failures.append(f"Python worker {module} 无法导入：{detail[-1] if detail else '未知错误'}")
    return failures


def main() -> None:
    quick = "--quick" in sys.argv[1:]
    root_requirements = read_requirements(ROOT / "requirements.txt")
    failures = verify_installed(root_requirements)
    if not quick:
        component_requirements = read_requirements(ROOT / "extensions" / "team-retouch" / "requirements.txt")
        export_requirements = read_requirements(ROOT / "requirements-model-export.txt")

        python_paths = sorted((ROOT / "python").glob("*.py"))
        script_paths = sorted((ROOT / "scripts").glob("*.py"))
        component_root = ROOT / "extensions" / "team-retouch"
        component_paths = sorted(component_root.glob("*.py"))
        advanced_paths = sorted((component_root / "advanced").glob("*.py"))
        export_paths = sorted((ROOT / "scripts").glob("export-team-retouch-*.py"))
        all_local_paths = [*python_paths, *script_paths, *component_paths, *advanced_paths]

        failures += audit_scope("主 Python worker", python_paths, root_requirements)
        failures += audit_scope("团片组件", component_paths, component_requirements)
        failures += audit_scope("模型导出工具", export_paths, export_requirements)
        failures += audit_scope("高级 WSL 后端", advanced_paths, {}, ADVANCED_EXTERNAL_IMPORTS)
        failures += audit_scope(
            "开发与测试脚本",
            script_paths,
            root_requirements | component_requirements | export_requirements,
            local_paths=all_local_paths,
        )
        failures += verify_worker_imports()

        pip_check = subprocess.run(
            [sys.executable, "-m", "pip", "check"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if pip_check.returncode:
            failures.append((pip_check.stdout or pip_check.stderr).strip())

    if failures:
        print("Python 环境或依赖声明不完整：", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        print("请运行 npm run setup:python 后重试。", file=sys.stderr)
        raise SystemExit(1)
    print("Python dependency versions are valid." if quick else "Python dependencies and worker imports are valid.")


if __name__ == "__main__":
    main()
