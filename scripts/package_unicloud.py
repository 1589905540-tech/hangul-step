"""Export public assets with conventional .js/.html names for static hosting.

Only dist/public is read; source files and the original build are never changed.
The service worker receives a cache version derived from the exported content.
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit


class AssetReferences(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        for name, value in attrs:
            if value and (name == "src" or (name == "href" and tag in {"a", "link"})):
                self.paths.append(value)


def local_path(reference, base="/index.html"):
    parts = urlsplit(reference)
    if parts.scheme or parts.netloc or not parts.path:
        return None
    return urlsplit(urljoin(base, reference)).path.lstrip("/") or "index.html"


def validate_export(exported, node):
    def require(reference, base="/index.html"):
        path = local_path(reference, base)
        if path is not None and path not in exported:
            raise SystemExit(f"Missing static reference {reference!r} from {base}")

    parser = AssetReferences()
    parser.feed(exported["index.html"].decode("utf-8"))
    for reference in parser.paths:
        require(reference)
    if "/app.js" not in parser.paths or "/dictionary-license.html" not in parser.paths:
        raise SystemExit("The HTML does not reference the compatible module and license page")
    checked_modules = 0
    imports = 0
    for name, content in sorted(exported.items()):
        if not name.endswith(".js"):
            continue
        text = content.decode("utf-8")
        if ".mjs" in text or re.search(r"/dictionary-license(?!\.html)", text):
            raise SystemExit(f"An old static asset name remains in {name}")
        references = re.findall(r"(?m)^\s*(?:import|export)\s+[^;\n]*?\sfrom\s*['\"]([^'\"]+)['\"]", text)
        references += re.findall(r"(?m)^\s*import\s*['\"]([^'\"]+)['\"]", text)
        references += re.findall(r"\bimport\s*\(\s*['\"]([^'\"]+)['\"]", text)
        for reference in references:
            require(reference, "/" + name)
            imports += 1
        syntax = subprocess.run(
            [node, "--input-type=module", "--check"], input=text,
            text=True, encoding="utf-8", capture_output=True, check=False,
        )
        if syntax.returncode:
            raise SystemExit(f"JavaScript syntax failed in {name}: {syntax.stderr}")
        checked_modules += 1
    for reference in re.findall(r"url\(\s*['\"]?([^)'\"\s]+)", exported["styles.css"].decode("utf-8")):
        require(reference, "/styles.css")
    manifest = json.loads(exported["manifest.webmanifest"])
    require(manifest["start_url"])
    for icon in manifest.get("icons", []):
        require(icon["src"])
    worker = exported["service-worker.js"].decode("utf-8")
    paths_block = re.search(r"const STATIC_PATHS\s*=\s*\[([\s\S]*?)\];", worker)
    if paths_block is None:
        raise SystemExit("The service worker static resource list was not found")
    static_paths = re.findall(r"['\"]([^'\"]+)['\"]", paths_block[1])
    hashes_block = re.search(r"(?m)^const ASSET_HASHES = (\{[^\n]*\});$", worker)
    if hashes_block is None or "__ASSET_HASHES__" in worker or "__ASSET_VERSION__" in worker or "__UNICLOUD_EXPORT_VERSION__" in worker:
        raise SystemExit("The service worker asset hashes or version have not been built")
    asset_hashes = json.loads(hashes_block[1])
    if set(asset_hashes) != set(static_paths):
        raise SystemExit("Service worker hash inventory differs from its static paths")
    for reference in static_paths:
        require(reference)
        content = exported[local_path(reference)]
        if asset_hashes[reference] != hashlib.sha256(content).hexdigest():
            raise SystemExit(f"Service worker hash differs from exported bytes: {reference}")
    app = exported["app.js"].decode("utf-8")
    if "register('/service-worker.js',{scope:'/'" not in app:
        raise SystemExit("The service worker must be registered at the hosting root")
    if any(name.endswith(".mjs") for name in exported) or "dictionary-license" in exported:
        raise SystemExit("The exported inventory contains incompatible old filenames")
    if "krdict-pronunciation-links.json" in exported or "/krdict-pronunciation-links.json" in static_paths:
        raise SystemExit("The local edition must not download the old online recording index")
    return {"javascript_files_parsed": checked_modules, "local_module_imports_checked": imports,
            "html_references_checked": len(parser.paths), "service_worker_static_paths_checked": len(static_paths),
            "service_worker_asset_hashes_checked": len(asset_hashes)}


def main():
    arguments = argparse.ArgumentParser(description=__doc__)
    arguments.add_argument("--node", default=shutil.which("node"), help="Node executable for JavaScript syntax checks")
    args = arguments.parse_args()
    if not args.node:
        raise SystemExit("Node is required for validation; pass --node /path/to/node")
    root = Path(__file__).resolve().parents[1]
    public = root / "dist" / "public"
    expected = {
        "index.html", "styles.css", "app.mjs", "core.mjs", "dictionary.mjs",
        "examples.mjs", "pronunciation.mjs", "recorded-audio.mjs", "word-audio.mjs",
        "local-store.mjs", "sync/protocol.mjs", "offline-lookup.mjs", "lookup-ranking.mjs",
        "service-worker.js", "icon.svg", "dictionary-license", "app-config.json",
        "manifest.webmanifest", "krdict-ko-zh-202609.json", "krdict-lookup-priority.json",
        "krdict-source.json",
        "krdict-pronunciation-source.json", "coast-v1.webp", "coast-ipad-v2.webp", "chun-icon-180.png",
        "chun-icon-192.png", "chun-icon-512.png",
    }
    if not public.is_dir():
        raise SystemExit("Build dist/public first: node scripts/build.mjs")
    files = {}
    for path in public.rglob("*"):
        if path.is_symlink():
            raise SystemExit(f"Refusing a symlink in the public directory: {path}")
        if path.is_file():
            files[path.relative_to(public).as_posix()] = path
    if set(files) != expected:
        raise SystemExit(json.dumps({
            "error": "Public file inventory differs from the expected static build",
            "missing": sorted(expected - set(files)),
            "unexpected": sorted(set(files) - expected),
        }, ensure_ascii=False))
    config = json.loads(files["app-config.json"].read_text(encoding="utf-8"))
    if config != {"mode": "local", "legacyImport": False}:
        raise SystemExit("This package must use the local edition, without a legacy server import")
    manifest = json.loads(files["manifest.webmanifest"].read_text(encoding="utf-8"))
    if manifest.get("start_url") != "/":
        raise SystemExit("The manifest must launch at the hosting root")
    worker = files["service-worker.js"].read_text(encoding="utf-8")
    if "__ASSET_VERSION__" in worker:
        raise SystemExit("The service worker has not been built")

    exported = {}
    for name, file in files.items():
        destination = name[:-4] + ".js" if name.endswith(".mjs") else name
        if name == "dictionary-license":
            destination = "dictionary-license.html"
        content = file.read_bytes()
        if destination.endswith((".js", ".html")):
            text = content.decode("utf-8").replace(".mjs", ".js").replace("/dictionary-license", "/dictionary-license.html")
            if destination == "service-worker.js":
                text, count = re.subn(r"(?m)^const VERSION = '[^']+';", "const VERSION = '__UNICLOUD_EXPORT_VERSION__';", text)
                if count != 1:
                    raise SystemExit("Expected exactly one service worker cache version")
            content = text.encode("utf-8")
        exported[destination] = content
    # Module/HTML names and their imports changed above, so their original
    # hashes cannot be reused. Hash the exact bytes uploaded to this host.
    worker_text = exported["service-worker.js"].decode("utf-8")
    paths_block = re.search(r"const STATIC_PATHS\s*=\s*\[([\s\S]*?)\];", worker_text)
    if paths_block is None:
        raise SystemExit("The service worker static resource list was not found")
    static_paths = re.findall(r"['\"]([^'\"]+)['\"]", paths_block[1])
    asset_hashes = {}
    for reference in static_paths:
        name = local_path(reference)
        if name not in exported:
            raise SystemExit(f"Missing exported service worker resource: {reference}")
        asset_hashes[reference] = hashlib.sha256(exported[name]).hexdigest()
    hashes_source = "const ASSET_HASHES = " + json.dumps(asset_hashes, ensure_ascii=False, separators=(",", ":")) + ";"
    worker_text, count = re.subn(r"(?m)^const ASSET_HASHES = [^\n]+;$", lambda _: hashes_source, worker_text)
    if count != 1:
        raise SystemExit("Expected exactly one service worker asset hash map")
    exported["service-worker.js"] = worker_text.encode("utf-8")
    fingerprint = hashlib.sha256(b"unicloud-static-export-v1\0")
    for name, content in sorted(exported.items()):
        fingerprint.update(name.encode("utf-8") + b"\0")
        fingerprint.update(len(content).to_bytes(8, "big"))
        fingerprint.update(content)
    cache_version = "unicloud-static-v1-" + fingerprint.hexdigest()[:20]
    exported["service-worker.js"] = exported["service-worker.js"].replace(
        b"__UNICLOUD_EXPORT_VERSION__", cache_version.encode("ascii"),
    )
    checks = validate_export(exported, args.node)

    output = root / "release" / "春-uniCloud静态托管.zip"
    output.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in sorted(exported.items()):
            entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, content, compresslevel=9)
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None or set(archive.namelist()) != set(exported):
            raise SystemExit("The static archive failed validation")
        for name, content in exported.items():
            if archive.read(name) != content:
                raise SystemExit(f"Archive content differs from the compatible export: {name}")
    print(json.dumps({
        "archive": str(output),
        "bytes": output.stat().st_size,
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "files": len(files),
        "index_at_archive_root": True,
        "contains_server_or_database": False,
        "contains_credentials_or_personal_records": False,
        "required_hosting_root": "/",
        "compatible_module_extension": ".js",
        "license_page": "/dictionary-license.html",
        "service_worker_cache_version": cache_version,
        "validation": checks,
        "actual_hosting_https_and_mainland_network_verified": False,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
