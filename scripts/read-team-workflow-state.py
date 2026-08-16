import argparse
import json
import os
import sqlite3
import urllib.parse


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--database', required=True)
    parser.add_argument('--team-database')
    parser.add_argument('--project-id', required=True)
    args = parser.parse_args()

    database_uri = 'file:' + urllib.parse.quote(args.database.replace('\\', '/'), safe='/:') + '?mode=ro&immutable=1'
    connection = sqlite3.connect(database_uri, uri=True)
    connection.row_factory = sqlite3.Row
    team_database = args.team_database or os.path.join(
        os.path.dirname(os.path.abspath(args.database)),
        os.path.splitext(os.path.basename(args.database))[0],
        'databases',
        'team-retouch.sqlite3',
    )
    team_uri = 'file:' + urllib.parse.quote(team_database.replace('\\', '/'), safe='/:') + '?mode=ro'
    connection.execute('ATTACH DATABASE ? AS team_retouch', (team_uri,))
    tasks = {
        row['id']: {
            'patchPath': row['patch_path'],
            'editedPatchPath': row['edited_patch_path'],
            'status': row['status'],
        }
        for row in connection.execute(
            '''
            SELECT task.id, task.patch_path, task.edited_patch_path, task.status
            FROM team_patch_tasks task
            JOIN photos photo ON photo.id = task.photo_id
            WHERE photo.project_id = ? AND COALESCE(task.is_deleted, 0) = 0
            ''',
            (args.project_id,),
        )
    }
    assignments = [
        {
            'photoId': row['photo_id'],
            'baseVersionId': row['base_version_id'],
            'personIndex': row['person_index'],
            'completed': bool(row['completed']),
            'completionKind': row['completion_kind'],
            'editedPatchPath': row['edited_patch_path'],
            'returnMissing': bool(row['return_missing']),
        }
        for row in connection.execute(
            '''
            SELECT photo_id, base_version_id, person_index, completed,
                   completion_kind, edited_patch_path, return_missing
            FROM team_person_assignments
            WHERE project_id = ?
            ''',
            (args.project_id,),
        )
    ]
    print(json.dumps({'tasks': tasks, 'assignments': assignments}, ensure_ascii=True))


if __name__ == '__main__':
    main()
