import json
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
output = root / 'release' / '春-免GPT登录独立版.zip'
output.parent.mkdir(exist_ok=True)
files = [root / name for name in [
    'dist/server/index.js', 'scripts/serve.mjs', 'scripts/sqlite.mjs',
    'scripts/baidu.mjs', 'Dockerfile', '.env.example',
    '启动独立版.cmd', '国内部署说明.md', 'README.md',
    'src/data/KRDICT-LICENSE.md', 'src/data/krdict-source.json',
    'src/data/krdict-pronunciation-source.json',
]] + sorted((root / 'drizzle').glob('*.sql'))
package = {'name': 'hangul-step-standalone', 'private': True, 'type': 'module',
           'engines': {'node': '>=24'}, 'scripts': {'start': 'node scripts/serve.mjs'}}
with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('hangul-step/package.json', json.dumps(package, indent=2) + '\n')
    for file in files:
        archive.write(file, 'hangul-step/' + file.relative_to(root).as_posix())
with zipfile.ZipFile(output) as archive:
    assert archive.testzip() is None
    assert not any(n.startswith('hangul-step/data/') or '/.git/' in n or n.endswith('/.env') for n in archive.namelist())
print(json.dumps({'archive': str(output), 'files': len(files) + 1, 'contains_private_data': False}, ensure_ascii=False))
