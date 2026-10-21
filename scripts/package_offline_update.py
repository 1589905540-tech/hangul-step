"""Prepare a validated local-only release, instructions and migration evidence."""
import argparse
import hashlib
import json
import re
import shutil
import zipfile
from pathlib import Path
from package_unicloud import validate_export


def digest(content):
    return hashlib.sha256(content).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    release = root / 'release'
    source = release / '春-uniCloud静态托管.zip'
    with zipfile.ZipFile(source) as archive:
        assert archive.testzip() is None
        files = {name: archive.read(name) for name in archive.namelist()}
    checks = validate_export(files, args.node)
    assert len(files) == 26 and 'sync/protocol.js' in files
    assert 'krdict-pronunciation-links.json' not in files
    sw = files['service-worker.js'].decode('utf-8')
    hashes = json.loads(re.search(r'^const ASSET_HASHES = (\{[^\n]*\});$', sw, re.M)[1])
    offline_bytes = sum(len(files['index.html' if path == '/' else path.lstrip('/')]) for path in hashes)
    baseline = json.loads((root / 'artifacts/audio-only-update-20261010.json').read_text(encoding='utf-8'))
    protected = {}
    for name in ['src/dictionary.mjs', 'src/local-store.mjs', 'src/core.mjs',
                 'sync/protocol.mjs', 'src/data/krdict-ko-zh-202609.json',
                 'src/data/krdict-lookup-priority.json', 'src/data/krdict-pronunciation-links.json']:
        content = (root / name).read_bytes()
        # The earlier evidence records JSON verbatim and code with LF endings.
        actual = digest(content if name.endswith('.json') else content.replace(b'\r\n', b'\n'))
        assert actual == baseline['protected_files_unchanged'][name], name
        protected[name] = actual
    for directory in [release / 'unicloud-upload', release / '本地离线版-20261010']:
        directory.mkdir(exist_ok=True)
        for name, content in files.items():
            target = directory / name
            assert target.resolve().is_relative_to(directory.resolve())
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
        # This single known generated file is obsolete; never delete other files.
        (directory / 'krdict-pronunciation-links.json').unlink(missing_ok=True)
        actual_names = {path.relative_to(directory).as_posix() for path in directory.rglob('*') if path.is_file()}
        assert actual_names == set(files), (directory, actual_names ^ set(files))
    output = release / '春-本地离线版-20261010.zip'
    shutil.copyfile(source, output)
    instructions = '''春 · 本地离线版（2026-10-10）

首次准备后，本地词典查词、添加生词、练习、评分、复习和进度保存均不依赖网络。
词典仍是原来的韩汉词典，未更换教材，选词、判断和复习间隔保持不变。
仅能查询本地词典收录的词；未收录的可以手动填写，不会请求在线翻译。
网站代码约3.6MB（未压缩），不再下载约10MB的联网录音网址索引。

上传和更新
1. 在现有“春”的备份中导出一份JSON，作为额外保障。不要清除Safari网站数据。
2. 解压“春-本地离线版-20261010.zip”，在原uniCloud托管目录覆盖同名文件。
   包内26个文件，其中protocol.js必须放在sync目录中。不要增加(1)或多余点号，
   不要把解压出的外层文件夹作为新网站目录。无需删除原来的网站文件。
3. 先上传其余25个文件，确认成功后最后覆盖service-worker.js。
4. 联网打开原来的国内网址，等待更新完成。旧页面完全关闭后再打开。
   在“备份”中看到“词典与页面已保存到本机，可断网查词和练习”。
   若显示尚未确认，点“联网准备”或“检查更新”。
5. 在iPad/iPhone“设置 → 辅助功能 → 朗读内容（或阅读与朗读）→ 声音”
   下载韩语声音。回到“备份 → 发音 → 试听韩语”。本版只接受本机声音，
   不会自动尝试海外录音或网络合成；浏览器未暴露本地声音时会提示安装。
6. 关闭Wi-Fi和蜂窝网络，再从已有主屏幕入口打开；查询一个此前未加入的词、
   添加并练习、听发音、做复习，再关闭重开检查生词和进度。

后续更新与流量
日常操作只读本机。只有首次准备、更新版本或主动修复缺失资源才下载文件；
更新按每个文件的SHA256校验，未变更的词典和页面直接复用，不再全量重下。
下载中断后重试只补缺失或不匹配的文件，新版不完整时继续使用旧版。
浏览器自身可能进行小量service-worker.js更新检查；不承诺在线状态绝对零请求。
旧录音索引即使仍放在托管目录中，也不会被本版本自动下载。

数据
本次不改变个人数据库名称、schema或学习数据。同一设备同一网址正常覆盖更新
会继续读取原生词与进度。更换网址或设备需导出/导入JSON，不会自动同步。
浏览器缓存可能被系统清理，个人数据需定期备份。不要删除主屏幕入口或清除网站数据。

验证范围
代码、缓存、更新失败/恢复、数据保存和模拟发音已通过自动检查。
尚未上传生产网站，尚未在你的实际iPad和国内无VPN环境中实测。
'''
    readme = release / '本地离线版-20261010-使用说明.txt'
    readme.write_text(instructions, encoding='utf-8-sig')
    test_report = json.loads((root / 'artifacts/offline-tests-20261010.json').read_text(encoding='utf-8'))
    assert test_report['exit_code'] == 0 and test_report['failed'] == 0
    report = {
        'archive': str(output), 'bytes': output.stat().st_size, 'sha256': digest(output.read_bytes()),
        'files': sorted(files), 'uncompressed_bytes': sum(map(len, files.values())),
        'offline_resource_bytes': offline_bytes, 'validation': checks,
        'dictionary_and_personal_database_unchanged': protected,
        'daily_app_requests_cache_only': True, 'system_korean_voice_required': True,
        'online_recording_index_included': False, 'cloud_accounts_enabled': False,
        'test_report': test_report, 'production_uploaded': False,
        'physical_ipad_verified': False, 'mainland_without_vpn_verified': False,
        'service_worker_version': re.search(r"^const VERSION = '([^']+)';", sw, re.M)[1],
        'file_sha256': {name: digest(content) for name, content in sorted(files.items())},
    }
    (root / 'artifacts/offline-local-update-20261010.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: report[key] for key in ['archive', 'bytes', 'sha256', 'uncompressed_bytes', 'offline_resource_bytes', 'service_worker_version', 'validation']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
