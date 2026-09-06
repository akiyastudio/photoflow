import json
import tempfile
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image
import team_retouch


def verify_work_tile_modes():
    people = [{'box': [20, 20, 70, 150]}, {'box': [75, 20, 125, 150]}]
    assert len(team_retouch.plan_work_tiles(people, 200, 180)) == 1
    for size, items in [(2, people), (24, [{'box': [i * 30, 0, i * 30 + 20, 100]} for i in range(24)])]:
        tiles = team_retouch.plan_work_tiles(items, 1000, 180, work_tile_mode='per-person')
        assert [tile['indices'] for tile in tiles] == [[i] for i in range(size)]
        assert all(tile['crop'][2] > 0 and tile['crop'][3] > 0 for tile in tiles)
    assert team_retouch.plan_work_tiles([], 200, 180, work_tile_mode='per-person') == []
    for policy in ('face-centered', 'expand'):
        tiles = team_retouch.plan_work_tiles([{'box': [0, 0, 10000, 16000]}], 10000, 16000,
                                           oversize_crop_mode=policy, work_tile_mode='per-person')
        assert tiles[0]['indices'] == [0] and np.prod(tiles[0]['outputSize']) <= 40_000_000
    try:
        team_retouch.plan_work_tiles(people, 200, 180, work_tile_mode='invalid')
        raise AssertionError('invalid work tile mode accepted')
    except ValueError:
        pass
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        rgb = np.full((180, 200, 3), 127, np.uint8)
        subjects = []
        for person in people:
            mask = np.zeros((180, 200), bool)
            x1, y1, x2, y2 = person['box']
            mask[y1:y2, x1:x2] = True
            subjects.append({**person, 'mask': mask, 'source': 'rtmdet'})
        _, tasks = team_retouch.generate_work_tasks(rgb, subjects, root, root, 'sample', 'test', work_tile_mode='per-person')
        assert len(tasks) == 2 and len({task['patchPath'] for task in tasks}) == 2
        for index, task in enumerate(tasks):
            assert [member['personIndex'] for member in task['members']] == [index + 1]
            assert task['generation']['workTileMode'] == 'per-person'
            with Image.open(task['maskPath']) as mask_image:
                mask = np.asarray(mask_image) > 0
                assert np.array_equal(mask, subjects[index]['mask']), 'a single-person task must not merge a neighbour mask'
            with Image.open(task['patchPath']) as image:
                assert image.size == (task['generation']['workWidth'], task['generation']['workHeight'])
        manifest = root / 'batch.json'
        manifest.write_text(json.dumps({'items': [{'input': str(root/'input.png'), 'outputDir': str(root), 'deliveryDir': str(root)}]}))
        with mock.patch.object(team_retouch, 'detect', return_value={'success': True, 'tasks': []}) as detect:
            result = team_retouch.detect_batch(str(manifest), advanced_mode='basic', session_bundle=object(), work_tile_mode='per-person')
            assert result['success'] and detect.call_args.kwargs['work_tile_mode'] == 'per-person'
    assert team_retouch.create_parser().parse_args(['detect', '--work-tile-mode', 'per-person']).work_tile_mode == 'per-person'
