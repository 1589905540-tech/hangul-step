"""Make an audio-only uniCloud patch from a validated full static export."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
release = root / 'release'
names = {'app.js', 'index.html', 'styles.css', 'pronunciation.js',
         'recorded-audio.js', 'word-audio.js', 'service-worker.js'}
with zipfile.ZipFile(release / '春-uniCloud静态托管.zip') as full:
    assert full.testzip() is None
    files = {name: full.read(name) for name in names}
    # Refresh the familiar full upload directory too, so it cannot retain the
    # deferred vocabulary version from the previous work session.
    upload = release / 'unicloud-upload'
    for name in full.namelist():
        destination = upload / name
        assert destination.resolve().is_relative_to(upload.resolve())
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(full.read(name))
target = release / '发音专用更新-20261010'
target.mkdir(exist_ok=True)
for name, data in files.items():
    (target / name).write_bytes(data)
archive = release / '春-仅发音更新-20261010.zip'
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as output:
    for name, data in sorted(files.items()):
        info = zipfile.ZipInfo(name, date_time=(2026, 10, 10, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        output.writestr(info, data)
with zipfile.ZipFile(archive) as check:
    assert check.testzip() is None and set(check.namelist()) == names
    assert all(check.read(name) == data for name, data in files.items())
instructions = '''本次只更新发音，不更新词典、教材词库、学习算法或个人数据。

1. 下载并解压「春-仅发音更新-20261010.zip」，根目录有7个文件。
2. 在uniCloud前端网页托管根目录覆盖这7个同名文件，保持原名。
   不要上传成 app(1).js、styles..css 或 service-worker(1).js。
   推荐其他6个文件上传成功后，最后上传 service-worker.js。
3. 这次不要上传之前的六级词汇更新包，也不需要删除其他文件。
4. 在iPad联网打开原来的国内网址，等「备份」中显示「已可离线使用」，
   完全关闭春后重新打开。不要删除主屏幕入口或清除Safari网站数据。
5. 点「备份 → 发音 → 试听韩语」。若无声，请在系统设置的
   「辅助功能 → 朗读内容／阅读与朗读 → 声音」下载韩语声音，
   然后重新打开春。设备有可用韩语声音后可离线朗读，无需VPN。

默认自动朗读：新词出现读一次，选择认识／模糊／不认识或答题后再读一次；
记错了／模糊的更正也重读当前词。可在「备份 → 发音」关闭自动朗读。
原始词典录音只作为手动备选，3.5秒未启动就提示失败，不无限等待。

本包已完成代码与模拟播放/数据保存检查；尚未在你的实际iPad、
国内无VPN网络或已上传的生产网页上验证，不保证所有设备即刻出声。
管理员和云同步未启用。教材词库暂不修改。
'''
(release / '仅发音更新-20261010-上传说明.txt').write_text(instructions, encoding='utf-8-sig')
report = {'archive': str(archive), 'bytes': archive.stat().st_size,
          'sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
          'files': sorted(names), 'contains_vocabulary_or_backend': False,
          'preserves_existing_database_schema': True,
          'production_uploaded': False, 'physical_ipad_verified': False,
          'mainland_without_vpn_verified': False,
          'file_sha256': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())}}
evidence = root / 'artifacts' / 'audio-only-update-20261010.json'
evidence.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False, indent=2))
