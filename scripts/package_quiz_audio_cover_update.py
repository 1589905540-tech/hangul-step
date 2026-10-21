"""Package the four-file quiz audio/iPad cover update without rebuilding assets."""
import argparse
import hashlib
import json
import re
import shutil
import zipfile
from pathlib import Path

from package_unicloud import local_path, validate_export


def digest(content):
    return hashlib.sha256(content).hexdigest()


def read_archive(path):
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None, path
        names = archive.namelist()
        assert len(names) == len(set(names)), 'Duplicate archive entries'
        assert all(not name.startswith('/') and '..' not in Path(name).parts for name in names)
        return {name: archive.read(name) for name in names}


def write_archive(path, files):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in sorted(files.items()):
            entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, content, compresslevel=9)
    assert read_archive(path) == files


def archive_report(path, files):
    return {'archive': str(path), 'bytes': path.stat().st_size,
            'sha256': digest(path.read_bytes()), 'files': sorted(files),
            'uncompressed_bytes': sum(map(len, files.values()))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    parser.add_argument('--test-exit-code', type=int, required=True,
                        help='Actual exit status of the already completed test command')
    args = parser.parse_args()
    assert args.test_exit_code == 0, 'Tests must finish successfully before packaging'
    root = Path(__file__).resolve().parents[1]
    release, artifacts = root / 'release', root / 'artifacts'
    baseline_path = release / '春-本地离线版-20261010.zip'
    full_source = release / '春-uniCloud静态托管.zip'
    baseline_evidence = artifacts / 'offline-local-update-20261010.json'
    preserved_paths = [baseline_path, baseline_evidence,
                       artifacts / 'offline-tests-20261010.json',
                       artifacts / 'offline-tests-20261010.tap',
                       release / '本地离线版-20261010-使用说明.txt']
    preserved = {str(path.relative_to(root)): digest(path.read_bytes()) for path in preserved_paths}
    old_report = json.loads(baseline_evidence.read_text(encoding='utf-8'))
    assert digest(baseline_path.read_bytes()) == old_report['sha256']
    assert baseline_path.stat().st_size == old_report['bytes']
    baseline, files = read_archive(baseline_path), read_archive(full_source)
    assert len(baseline) == 26 and len(files) == 27
    assert {name: digest(content) for name, content in baseline.items()} == old_report['file_sha256']
    changed = sorted(name for name in baseline.keys() & files.keys() if baseline[name] != files[name])
    added, removed = sorted(files.keys() - baseline.keys()), sorted(baseline.keys() - files.keys())
    assert changed == ['app.js', 'service-worker.js', 'styles.css'], changed
    assert added == ['spring-ipad-v1.svg'] and not removed, (added, removed)
    update_files = {name: files[name] for name in changed + added}
    assert len(update_files) == 4
    # Applying only the delta to the protected old release must reproduce the
    # validated new release byte-for-byte, including every dictionary module.
    assembled = {**baseline, **update_files}
    assert assembled == files
    validation = validate_export(assembled, args.node)
    assert validation['service_worker_asset_hashes_checked'] == 26
    unchanged = {name: digest(content) for name, content in sorted(files.items()) if name not in update_files}
    assert len(unchanged) == 23
    for name in ['dictionary.js', 'krdict-ko-zh-202609.json', 'krdict-lookup-priority.json',
                 'local-store.js', 'core.js', 'sync/protocol.js', 'pronunciation.js',
                 'recorded-audio.js', 'word-audio.js', 'offline-lookup.js', 'lookup-ranking.js']:
        assert name in unchanged and files[name] == baseline[name], name
    worker = files['service-worker.js'].decode('utf-8')
    hashes = json.loads(re.search(r'^const ASSET_HASHES = (\{[^\n]*\});$', worker, re.M)[1])
    offline_bytes = sum(len(files[local_path(path)]) for path in hashes)
    changed_resource_paths = sorted(path for path in hashes if local_path(path) in update_files)
    changed_resource_bytes = sum(len(files[local_path(path)]) for path in changed_resource_paths)

    tap_path = artifacts / 'quiz-audio-cover-tests-20261010.tap'
    tap_bytes = tap_path.read_bytes()
    tap = tap_bytes.decode('utf-8-sig')
    counters = {}
    for source_name, report_name in [('tests', 'tests'), ('pass', 'passed'), ('fail', 'failed'),
                                     ('cancelled', 'cancelled'), ('skipped', 'skipped'), ('todo', 'todo')]:
        match = re.search(r'^# ' + source_name + r' (\d+)\s*$', tap, re.M)
        assert match, f'Missing TAP counter: {source_name}'
        counters[report_name] = int(match[1])
    assert counters == {'tests': 143, 'passed': 143, 'failed': 0, 'cancelled': 0, 'skipped': 0, 'todo': 0}, counters
    assert not re.search(r'^not ok\b', tap, re.M)
    test_report = {'exit_code': args.test_exit_code, **counters,
                   'output': str(tap_path.relative_to(root)).replace('\\', '/'),
                   'output_sha256': digest(tap_bytes),
                   'environment': 'desktop Node simulations and localhost; not physical iPad/iPhone'}
    test_summary = artifacts / 'quiz-audio-cover-tests-20261010.json'
    test_summary.write_text(json.dumps(test_report, ensure_ascii=False, indent=2), encoding='utf-8')

    output = release / '春-作答后发音与iPad封面-20261010.zip'
    write_archive(output, update_files)
    directory = release / '作答后发音与iPad封面-20261010'
    directory.mkdir(exist_ok=True)
    for name, content in update_files.items():
        destination = directory / name
        assert destination.resolve().is_relative_to(directory.resolve())
        destination.write_bytes(content)
    actual_names = {path.relative_to(directory).as_posix() for path in directory.rglob('*') if path.is_file()}
    assert actual_names == set(update_files), (actual_names, set(update_files))
    full_output = release / '春-本地离线完整包-含作答后发音与iPad封面-20261010.zip'
    shutil.copyfile(full_source, full_output)
    assert read_archive(full_output) == files

    instructions = '''春 · 作答后发音与 iPad 封面更新（2026-10-10）

本包适用于已经完整上传“春-本地离线版-20261010.zip”的现有网站，只含4个更新文件。
第一种学习词卡的自动发音保持原样。练习和Review选择题在作答前不自动发音；
选择任一答案或“不认识”后朗读正确韩语一次。手动发音和评分纠正后的重读保留。
iPad主页使用简约“春日浅湾”矢量封面，约2.2KB，适配横竖屏；手机版封面保持原样。

上传步骤
1. 建议先在现有网站导出一份JSON备份。不要清除Safari网站数据，不要删除生词本。
2. 解压“春-作答后发音与iPad封面-20261010.zip”，把4个文件放在原托管根目录。
   先同名覆盖 app.js、styles.css、spring-ipad-v1.svg，确认全部上传成功。
3. 最后同名覆盖 service-worker.js。保留准确文件名，不要加(1)、多余点号或外层文件夹。
   无需删除其他正常的网站文件，也不应删除旧的生词与学习记录。
4. 联网打开同一个网址，在“备份”中点“检查更新”，等待离线准备完成。
   完全关闭旧页面后重新打开已有桌面入口，无需重新添加到桌面。
5. 检查选择题出现时不自动发音，选择答案或“不认识”后朗读一次；
   再断网测试查词、练习和发音。系统韩语声音仍需提前下载。

数据和流量
同一设备、同一网址正常覆盖更新会继续读取原生词本和进度；本次没有修改数据库、
词典、选词/判定或复习算法，也没有启用云同步。不要为了更新去清除网站数据。
已准备好的本地离线版会复用未变化的词典等资源，只下载变化或缺失的文件。
新封面约2.2KB，缓存保存后正常再次打开不会重新下载封面。
浏览器可能执行少量更新检查；缓存被清理、换设备时需要重新准备完整资源。

首次安装
尚未完整部署旧的本地离线版时，请使用单独的27文件完整包：
“春-本地离线完整包-含作答后发音与iPad封面-20261010.zip”。
解压后保持sync/protocol.js的目录结构，先上传其余26个文件，最后上传service-worker.js。
本4文件更新包不能独立作为新网站。

验证范围
143项自动检查通过，导出文件、引用和26个离线资源的SHA256已校验。
本次尚未上传生产网站，尚未在实际iPad、iPhone或国内无VPN网络中验证。
本次只调整自动发音时机，没有声称已修复iPhone系统试听有声而网页无声的问题。
'''
    readme = release / '作答后发音与iPad封面-20261010-上传说明.txt'
    readme.write_text(instructions, encoding='utf-8-sig')

    assert all(digest(path.read_bytes()) == preserved[str(path.relative_to(root))] for path in preserved_paths)
    report = {
        'update': archive_report(output, update_files),
        'full_release': archive_report(full_output, files),
        'baseline': {'archive': str(baseline_path), 'bytes': baseline_path.stat().st_size,
                     'sha256': digest(baseline_path.read_bytes()), 'unchanged': True},
        'changed_files': changed, 'added_files': added, 'removed_files': removed,
        'update_file_sha256': {name: digest(content) for name, content in sorted(update_files.items())},
        'unchanged_file_sha256': unchanged,
        'unchanged_scope': ['dictionary', 'personal_database', 'quiz_and_review_algorithm',
                            'sync_protocol', 'speech_engine', 'offline_lookup', 'phone_cover'],
        'extracted_update_directory': str(directory), 'readme': str(readme),
        'cover_bytes': len(files['spring-ipad-v1.svg']),
        'offline_resource_bytes': offline_bytes,
        'changed_precache_resources': changed_resource_paths,
        'changed_precache_resource_bytes': changed_resource_bytes,
        'cached_unchanged_resources_reused': True,
        'complete_release_reproduced_by_four_file_update': True,
        'service_worker_version': re.search(r"^const VERSION = '([^']+)';", worker, re.M)[1],
        'validation': validation, 'test_report': test_report,
        'preserved_historical_artifact_sha256': preserved,
        'production_uploaded': False, 'physical_ipad_verified': False,
        'physical_iphone_verified': False, 'mainland_without_vpn_verified': False,
        'iphone_silent_audio_fixed_or_verified': False,
    }
    evidence = artifacts / 'quiz-audio-cover-update-20261010.json'
    evidence.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: report[key] for key in ['update', 'full_release', 'baseline',
                     'cover_bytes', 'changed_precache_resource_bytes', 'service_worker_version',
                     'validation']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
