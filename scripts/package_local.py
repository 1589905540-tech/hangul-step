import json
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
folder = root / 'dist' / 'public'
output = root / 'release' / '春-iPad本地网页版.zip'
output.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for file in sorted(folder.rglob('*')):
        if file.is_file():
            archive.write(file, 'dist/public/' + file.relative_to(folder).as_posix())
    archive.write(root / 'iPad本地版说明.md', 'iPad本地版说明.md')
    archive.write(root / 'scripts' / 'preview-local.mjs', 'scripts/preview-local.mjs')
    archive.writestr('package.json', json.dumps({'private': True, 'type': 'module', 'scripts': {'preview': 'node scripts/preview-local.mjs'}}, indent=2))
    archive.write(root / 'src' / 'data' / 'KRDICT-LICENSE.md', 'KRDICT-LICENSE.md')
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    assert not any('/.git/' in name or name.endswith(('.sqlite', '.env')) for name in archive.namelist())
print(json.dumps({'archive': str(output), 'contains_personal_data': False}, ensure_ascii=False))
