"""Package the cumulative iPad photograph update and verify both offline baselines."""
import argparse
import hashlib
import io
import json
import re
from pathlib import Path

from PIL import Image

from package_quiz_audio_cover_update import archive_report, read_archive, write_archive
from package_unicloud import local_path, validate_export


def digest(content):
    return hashlib.sha256(content).hexdigest()


def differences(before, after):
    return {
        'changed': sorted(name for name in before.keys() & after.keys() if before[name] != after[name]),
        'added': sorted(after.keys() - before.keys()),
        'removed': sorted(before.keys() - after.keys()),
    }


def runtime(worker):
    text = worker.decode('utf-8')
    text = re.sub(r"(?m)^const VERSION = '[^']+';", "const VERSION = '<version>';", text)
    text = re.sub(r'(?m)^const ASSET_HASHES = [^\n]+;$', 'const ASSET_HASHES = {};', text)
    return re.sub(r'const STATIC_PATHS\s*=\s*\[[\s\S]*?\];', 'const STATIC_PATHS = [];', text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    parser.add_argument('--test-tap', required=True, help='Completed TAP output, relative to project root or absolute')
    parser.add_argument('--test-exit-code', required=True, type=int)
    args = parser.parse_args()
    assert args.test_exit_code == 0, 'Tests must finish successfully before packaging'
    root = Path(__file__).resolve().parents[1]
    release, artifacts = root / 'release', root / 'artifacts'
    baseline_path = release / '春-本地离线版-20261010.zip'
    previous_path = release / '春-本地离线完整包-含作答后发音与iPad封面-20261010.zip'
    source = release / '春-uniCloud静态托管.zip'
    baseline_evidence = artifacts / 'offline-local-update-20261010.json'
    previous_evidence = artifacts / 'quiz-audio-cover-update-20261010.json'
    # Every historical named archive, evidence and instruction below remains intact.
    preserved_paths = [baseline_path, previous_path, baseline_evidence, previous_evidence,
                       artifacts / 'offline-tests-20261010.json', artifacts / 'offline-tests-20261010.tap',
                       artifacts / 'quiz-audio-cover-tests-20261010.json',
                       artifacts / 'quiz-audio-cover-tests-20261010.tap',
                       release / '春-作答后发音与iPad封面-20261010.zip',
                       release / '本地离线版-20261010-使用说明.txt',
                       release / '作答后发音与iPad封面-20261010-上传说明.txt']
    preserved = {str(path.relative_to(root)): digest(path.read_bytes()) for path in preserved_paths}
    baseline_report = json.loads(baseline_evidence.read_text(encoding='utf-8'))
    previous_report = json.loads(previous_evidence.read_text(encoding='utf-8'))
    assert digest(baseline_path.read_bytes()) == baseline_report['sha256']
    assert digest(previous_path.read_bytes()) == previous_report['full_release']['sha256']
    baseline, previous, files = read_archive(baseline_path), read_archive(previous_path), read_archive(source)
    assert len(baseline) == 26 and len(previous) == 27 and len(files) == 27
    assert {name: digest(content) for name, content in baseline.items()} == baseline_report['file_sha256']
    old_delta = differences(baseline, files)
    recent_delta = differences(previous, files)
    assert old_delta == {'changed': ['app.js', 'service-worker.js', 'styles.css'],
                         'added': ['coast-ipad-v2.webp'], 'removed': []}, old_delta
    assert recent_delta == {'changed': ['service-worker.js', 'styles.css'],
                            'added': ['coast-ipad-v2.webp'], 'removed': ['spring-ipad-v1.svg']}, recent_delta
    assert files['app.js'] == previous['app.js'], 'The previous answer-after-selection behavior must remain intact'
    assert runtime(files['service-worker.js']) == runtime(previous['service-worker.js']), 'Cache runtime changed'
    old_styles, new_styles = previous['styles.css'].decode('utf-8'), files['styles.css'].decode('utf-8')
    old_prefix = old_styles.split('/* The tablet cover is a small local vector, with room around the home controls. */', 1)
    new_prefix = new_styles.split('/* Keep the portrait photograph for portrait screens; compose tablets separately. */', 1)
    assert len(old_prefix) == len(new_prefix) == 2 and old_prefix[0] == new_prefix[0], 'Styles outside iPad home changed'
    assert 'spring-ipad-v1.svg' not in new_styles
    update_names = ['app.js', 'styles.css', 'coast-ipad-v2.webp', 'service-worker.js']
    update_files = {name: files[name] for name in update_names}
    assembled_old = {**baseline, **update_files}
    assert assembled_old == files, 'The four-file update does not reproduce the full release from the old baseline'
    assembled_recent = {**previous, **update_files}
    assert {name: content for name, content in assembled_recent.items() if name != 'spring-ipad-v1.svg'} == files
    validation = validate_export(files, args.node)
    assert validation['service_worker_asset_hashes_checked'] == 26
    # A leftover SVG at the host is harmless and is not requested by the new CSS/SW.
    retained_svg_validation = validate_export(assembled_recent, args.node)
    worker = files['service-worker.js'].decode('utf-8')
    assert 'spring-ipad-v1.svg' not in worker
    hashes = json.loads(re.search(r'^const ASSET_HASHES = (\{[^\n]*\});$', worker, re.M)[1])
    assert '/coast-ipad-v2.webp' in hashes
    offline_bytes = sum(len(files[local_path(path)]) for path in hashes)
    changed_precache = sorted(path for path in hashes if local_path(path) in update_files)
    changed_from_recent = sorted(path for path in hashes if local_path(path) in recent_delta['changed'] + recent_delta['added'])
    unchanged = {name: digest(content) for name, content in sorted(files.items())
                 if name not in recent_delta['changed'] + recent_delta['added']}
    assert len(unchanged) == 24
    protected_names = ['app.js', 'app-config.json', 'dictionary.js', 'krdict-ko-zh-202609.json',
                       'krdict-lookup-priority.json', 'local-store.js', 'core.js', 'sync/protocol.js',
                       'pronunciation.js', 'recorded-audio.js', 'word-audio.js', 'offline-lookup.js',
                       'lookup-ranking.js', 'coast-v1.webp', 'index.html']
    assert all(files[name] == previous[name] for name in protected_names)
    asset_evidence_path = artifacts / 'cover-photo-restore-20261010/asset-evidence.json'
    asset_evidence = json.loads(asset_evidence_path.read_text(encoding='utf-8'))
    cover, original = files['coast-ipad-v2.webp'], files['coast-v1.webp']
    assert cover == (root / 'src/assets/coast-ipad-v2.webp').read_bytes()
    assert original == (root / 'src/assets/coast-v1.webp').read_bytes() == baseline['coast-v1.webp']
    assert len(cover) == asset_evidence['final']['bytes'] == 256402
    assert digest(cover) == asset_evidence['final']['sha256']
    assert digest(original) == asset_evidence['original']['sha256']
    with Image.open(io.BytesIO(cover)) as image:
        cover_pixels = list(image.size)
    with Image.open(io.BytesIO(original)) as image:
        original_pixels = list(image.size)
    assert cover_pixels == asset_evidence['final']['pixels'] == [1448, 1086]
    assert original_pixels == asset_evidence['original']['pixels'] == [1024, 1536]
    prompt = root / asset_evidence['prompt'].replace('\\', '/')
    assert prompt.is_file()
    layout_path = artifacts / 'cover-photo-restore-20261010/layout-verification.json'
    layout_bytes = layout_path.read_bytes()
    layout = json.loads(layout_bytes)
    assert layout['passed'] is True and len(layout['checks']) == 6
    assert layout['pageErrors'] == [] and layout['coverBytes'] == len(cover)
    assert all(check['overflow'] is False for check in layout['checks'])
    assert {(check['viewport']['width'], check['viewport']['height']) for check in layout['checks']} == {
        (1194, 834), (1366, 1024), (1024, 768), (834, 1194), (768, 1024), (390, 844)}
    layout_report = {'artifact': layout_path.relative_to(root).as_posix(), 'sha256': digest(layout_bytes),
                     'passed': True, 'viewport_checks': len(layout['checks']), 'page_errors': [],
                     'overflow_detected': False, 'environment': layout['environment'],
                     'physical_device_verified': False}

    tap_path = Path(args.test_tap)
    if not tap_path.is_absolute():
        tap_path = root / tap_path
    assert tap_path.resolve().is_relative_to(artifacts.resolve()), 'Use saved project test evidence'
    tap_bytes = tap_path.read_bytes()
    tap = tap_bytes.decode('utf-8-sig')
    counters = {}
    for source_name, report_name in [('tests', 'tests'), ('pass', 'passed'), ('fail', 'failed'),
                                     ('cancelled', 'cancelled'), ('skipped', 'skipped'), ('todo', 'todo')]:
        match = re.search(r'^# ' + source_name + r' (\d+)\s*$', tap, re.M)
        assert match, f'Missing TAP counter: {source_name}'
        counters[report_name] = int(match[1])
    assert counters['tests'] == counters['passed'] > 0
    assert all(counters[name] == 0 for name in ['failed', 'cancelled', 'skipped', 'todo'])
    assert not re.search(r'^not ok\b', tap, re.M)
    test_report = {'exit_code': args.test_exit_code, **counters,
                   'output': tap_path.relative_to(root).as_posix(), 'output_sha256': digest(tap_bytes),
                   'environment': 'desktop Node simulations; not physical iPad/iPhone'}
    test_summary = artifacts / 'ipad-photo-update-v2-tests.json'
    test_summary.write_text(json.dumps(test_report, ensure_ascii=False, indent=2), encoding='utf-8')

    output = release / '春-iPad原封面适配-v2.zip'
    full_output = release / '春-iPad原封面适配-v2-完整包.zip'
    write_archive(output, update_files)
    write_archive(full_output, files)
    directory = release / '春-iPad原封面适配-v2'
    directory.mkdir(exist_ok=True)
    for name, content in update_files.items():
        destination = directory / name
        assert destination.resolve().is_relative_to(directory.resolve())
        destination.write_bytes(content)
    assert {path.relative_to(directory).as_posix() for path in directory.rglob('*') if path.is_file()} == set(update_files)
    readme = release / '春-iPad原封面适配-v2-上传说明.txt'
    instructions = f'''春 · iPad 原封面适配 v2

恢复原来照片的春日海岸风格，iPad 横屏使用独立横向照片构图，竖屏和手机保留原竖图。
新横图为 1448×1086（4:3），文件 {len(cover):,} 字节，约 {len(cover)/1000:.1f} KB；不是4K原图。
新图首次更新后会缓存到本机，缓存正常保留时，之后打开封面不会反复下载。
仅调整 iPad 主页封面和主页布局，学习、选词、判断、复习、数据库与语音引擎保持原样。
本包已包含上一轮“选择题作答后再自动发音”的 app.js，不需叠加旧的矢量封面更新包。

适用范围
已完整上传“春-本地离线版-20261010.zip”的26文件网站，或已更新上轮27文件封面的旧站，
都可使用这个4文件累计更新包。新站或旧站缺少其他资源时，请使用另附的27文件完整包。

上传步骤
1. 建议先在当前网站导出JSON备份。不要清除Safari网站数据，不要删除生词本。
2. 解压“春-iPad原封面适配-v2.zip”，在原网站托管根目录同名覆盖：
   app.js、styles.css、coast-ipad-v2.webp。等这三个文件都上传成功。
3. 最后同名覆盖 service-worker.js。不要增加(1)、多余点号，也不要上传外层文件夹。
   原网站中未使用的 spring-ipad-v1.svg 可暂时保留，新版不会请求它，无需先删除。
4. 联网打开同一个国内网址，在“备份”中点击“检查更新”，等待离线资源准备完成。
   完全关闭旧页面后，再打开原来的主屏幕入口，无需重新添加到桌面。
5. 查看 iPad 横屏、竖屏封面，再断网测试查词、练习和系统韩语发音。

数据和流量
同设备、同网址正常覆盖更新会继续读取已有生词和学习进度。本次不改变本机数据库。
完整缓存正常时无需重新下载词典，只下载发生变化或缺失的资源。
四个更新文件未压缩合计 {sum(map(len, update_files.values())):,} 字节，约 {sum(map(len, update_files.values()))/1000:.1f} KB。
这表示上传文件/资源体积，实际CDN下载计费会受压缩、缓存命中、重试等影响。
上轮已更新过 app.js 的设备会复用它，实际需要下载的变更资源还会更少。
浏览器自身可能执行少量版本检查；清理缓存或换设备后需要重新准备完整资源。

完整包
“春-iPad原封面适配-v2-完整包.zip”含27个文件。首次安装时保持 sync/protocol.js
的目录结构，先上传其余26个文件，最后上传 service-worker.js。
4文件更新包不能单独作为一个新网站。

验证范围
{counters['passed']}项自动检查通过；导出文件、引用和26个离线资源SHA256已校验。
桌面浏览器模拟6种横竖屏尺寸通过，非实际iPad测试。
对比两个历史完整包确认，原手机图片、字典、个人数据库、学习算法和语音引擎字节未变。
本轮仅封面和iPad主页样式改变，app.js与上一轮相同。
尚未上传生产网站，尚未在实际iPad、iPhone或国内无VPN网络中验证。
本次没有声称修复iPhone系统试听有声而网页无声的问题。
'''
    readme.write_text(instructions, encoding='utf-8-sig')
    assert all(digest(path.read_bytes()) == preserved[str(path.relative_to(root))] for path in preserved_paths)
    report = {
        'update': archive_report(output, update_files), 'full_release': archive_report(full_output, files),
        'baselines': {
            'original_offline_26_files': {**archive_report(baseline_path, baseline), 'unchanged': True, **old_delta},
            'previous_audio_and_vector_27_files': {**archive_report(previous_path, previous), 'unchanged': True, **recent_delta},
        },
        'extracted_update_directory': str(directory), 'readme': str(readme),
        'update_file_sha256': {name: digest(content) for name, content in sorted(update_files.items())},
        'unchanged_since_previous_file_sha256': unchanged,
        'unchanged_scope': ['app_logic_since_previous', 'dictionary', 'personal_database',
                            'quiz_and_review_algorithm', 'sync_protocol', 'speech_engine', 'offline_lookup', 'phone_cover'],
        'cover': {'path': 'coast-ipad-v2.webp', 'bytes': len(cover), 'sha256': digest(cover),
                  'pixels': cover_pixels, 'aspect_ratio': '4:3', 'is_4k': False,
                  'prompt': prompt.relative_to(root).as_posix(), 'prompt_sha256': digest(prompt.read_bytes()),
                  'asset_evidence': asset_evidence_path.relative_to(root).as_posix()},
        'original_phone_and_portrait_cover': {'path': 'coast-v1.webp', 'bytes': len(original),
                                              'sha256': digest(original), 'pixels': original_pixels, 'unchanged': True},
        'styles_outside_ipad_home_unchanged': True, 'service_worker_runtime_unchanged': True,
        'offline_resource_bytes': offline_bytes, 'cached_unchanged_resources_reused': True,
        'changed_precache_resources_from_original': changed_precache,
        'changed_precache_resource_bytes_from_original': sum(len(files[local_path(path)]) for path in changed_precache),
        'changed_precache_resources_since_previous': changed_from_recent,
        'changed_precache_resource_bytes_since_previous': sum(len(files[local_path(path)]) for path in changed_from_recent),
        'estimated_changed_download_including_worker_from_original': sum(map(len, update_files.values())),
        'estimated_changed_download_including_worker_since_previous': sum(len(files[name]) for name in recent_delta['changed'] + recent_delta['added']),
        'traffic_measurement': 'uncompressed resource byte estimate; not measured CDN billing',
        'complete_release_reproduced_by_four_file_update_from_original': True,
        'previous_release_plus_update_is_valid_with_unused_svg_retained': True,
        'unused_svg_can_remain_on_host': True, 'retained_svg_validation': retained_svg_validation,
        'service_worker_version': re.search(r"^const VERSION = '([^']+)';", worker, re.M)[1],
        'validation': validation, 'test_report': test_report,
        'test_summary': str(test_summary),
        'layout_verification': layout_report,
        'layout_verification_included_in_test_count': False,
        'preserved_historical_artifact_sha256': preserved,
        'production_uploaded': False, 'physical_ipad_verified': False, 'physical_iphone_verified': False,
        'mainland_without_vpn_verified': False, 'iphone_silent_audio_fixed_or_verified': False,
    }
    evidence = artifacts / 'ipad-photo-update-v2.json'
    evidence.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({key: report[key] for key in ['update', 'full_release', 'cover',
                     'estimated_changed_download_including_worker_from_original',
                     'estimated_changed_download_including_worker_since_previous',
                     'service_worker_version', 'validation', 'test_report']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
