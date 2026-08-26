import importlib.util
import json
import re
import tempfile
from pathlib import Path


EXTENSION_ROOT = Path(__file__).resolve().parent.parent
REPOSITORY_ROOT = EXTENSION_ROOT.parent.parent
SPEC = importlib.util.spec_from_file_location("workspace_db_plugin_policy", REPOSITORY_ROOT / "python" / "workspace_db.py")
workspace_db = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workspace_db)
RELOCATION_SPEC = importlib.util.spec_from_file_location("generic_progress_relocation_tests", REPOSITORY_ROOT / "scripts" / "test-progress-folder-relocation.py")
relocation_tests = importlib.util.module_from_spec(RELOCATION_SPEC)
RELOCATION_SPEC.loader.exec_module(relocation_tests)


def declared_project_folder_policy():
    manifest = json.loads((EXTENSION_ROOT / "component.template.json").read_text(encoding="utf-8"))
    declarations = manifest["componentHost"]["service"]["projectFolders"]
    assert len(declarations) == 1
    declaration = declarations[0]
    compatibility_source = (EXTENSION_ROOT / "compatibility" / "project-folder-policy.cjs").read_text(encoding="utf-8")
    assert re.search(rf"folderName:\s*['\"]{re.escape(declaration['name'])}['\"]", compatibility_source)
    assert re.search(rf"adoptionGrant:\s*['\"]{re.escape(declaration['legacyAdoptionGrant'])}['\"]", compatibility_source)
    assert declaration["protectFromGenericRename"] is True
    assert declaration["reserveProgressRelocationName"] is True
    assert declaration["legacyAdoptionGrant"] in manifest["componentHost"]["adoptionGrants"]
    return declaration["name"]


def test_declared_name_is_reserved_by_generic_relocation():
    reserved_name = declared_project_folder_policy()
    with tempfile.TemporaryDirectory(prefix="photoflow-component-progress-policy-") as temporary:
        root = Path(temporary) / "workspace"
        db, progress = relocation_tests.seed(root, Path(temporary) / "workspace.sqlite3")
        try:
            token = workspace_db.progress_update_tree_begin(db, {"projectName": "Project"})["mutationToken"]
            try:
                workspace_db.progress_folder_rename(str(root), db, {
                    "projectName": "Project",
                    "progressId": "progress",
                    "expectedFolderId": workspace_db.directory_identity(str(progress)),
                    "expectedRelativePath": progress.name,
                    "newName": reserved_name,
                    "reservedProjectFolderNames": [reserved_name],
                    "mutationToken": token,
                })
                raise AssertionError("component-declared folder name was accepted")
            except ValueError as error:
                assert "progress_folder_name_reserved" in str(error)
            finally:
                workspace_db.progress_update_tree_finish(db, {"projectName": "Project", "mutationToken": token})
        finally:
            db.close()


if __name__ == "__main__":
    test_declared_name_is_reserved_by_generic_relocation()
    print("team retouch project folder policy tests passed")
