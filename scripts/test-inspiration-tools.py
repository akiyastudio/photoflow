import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "python" / "inspiration_tools.py"


def invoke(*args: str) -> tuple[int, dict[str, object]]:
    completed = subprocess.run([sys.executable, str(SOURCE), *args], capture_output=True, text=True, encoding="utf-8")
    return completed.returncode, json.loads(completed.stdout)


code, missing = invoke()
assert code != 0 and missing["success"] is False and missing["error"]["code"] == "missing_tool", missing
assert missing["type"] == "error" and missing["message"], missing

code, unknown = invoke("not_a_tool")
assert code != 0 and unknown["success"] is False and unknown["error"]["code"] == "unknown_tool", unknown
assert unknown["type"] == "error" and unknown["message"], unknown

code, invalid = invoke("office_media_extract")
assert code != 0 and invalid["success"] is False and invalid["error"]["code"] == "invalid_arguments", invalid
assert invalid["type"] == "error" and invalid["message"], invalid

probe = subprocess.run(
    [sys.executable, "-c", (
        "import json,sys; sys.path.insert(0, r'%s'); import inspiration_tools as m; "
        "m.TOOLS['broken']='module_that_does_not_exist'; raise SystemExit(m.main(['broken']))"
    ) % str(ROOT / "python")],
    capture_output=True, text=True, encoding="utf-8",
)
payload = json.loads(probe.stdout)
assert probe.returncode != 0 and payload["error"]["code"] == "import_failed", payload

print("inspiration tools dispatcher tests passed")
