"""Export licensed Korean-Chinese text data from the public NIKL JSON ZIP.

No remote API, account, key, media, or example sentence is used by this script.
The source archive must already have been downloaded from the official site.
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import unicodedata
import zipfile


SOURCE_URL = "https://krdict.korean.go.kr/dicBatchDownload?seq=217"
DOWNLOAD_PAGE = "https://krdict.korean.go.kr/download/downloadPopup"
COPYRIGHT_URL = "https://krdict.korean.go.kr/kor/kboardPolicy/copyRightTermsInfo"
LICENSE_URL = "https://creativecommons.org/licenses/by-sa/2.0/kr/"
ATTRIBUTION = "National Institute of Korean Language (국립국어원), Basic Korean Dictionary (한국어기초사전), Korean-Chinese translations."
PLACEHOLDERS = {"(无对应词汇)", "（无对应词汇）", "无对应词汇", "(无对应词语)", "（无对应词语）", "无对应词语"}
MAX_GLOSS_LENGTH = 120


def sequence(value):
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        return [value]
    return []


def features(node):
    if not isinstance(node, dict):
        return {}
    return {
        str(feature["att"]): feature.get("val", "")
        for feature in sequence(node.get("feat"))
        if isinstance(feature, dict) and "att" in feature
    }


def text(value):
    return unicodedata.normalize("NFC", str(value or "")).strip()


def sha256(path):
    result = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def write_json(path, value, pretty=False):
    serialized = json.dumps(
        value, ensure_ascii=False, indent=2 if pretty else None,
        separators=None if pretty else (",", ":"), sort_keys=pretty,
    )
    path.write_text(serialized + "\n", encoding="utf-8")


def export(source_path, output_dir):
    counts = Counter()
    index = {}
    detailed_entries = []
    entry_feature_names = set()
    source_labels = set()
    source_dates = set()
    filenames = []

    with zipfile.ZipFile(source_path) as archive:
        json_members = sorted(
            (item for item in archive.infolist() if item.filename.endswith(".json")),
            key=lambda item: item.filename,
        )
        if not json_members:
            raise ValueError("The official ZIP contains no JSON dictionary files.")
        if sum(item.file_size for item in json_members) > 2 * 1024**3:
            raise ValueError("Unexpected source size: more than 2 GiB uncompressed.")

        for member in json_members:
            filenames.append(member.filename)
            with archive.open(member) as file:
                payload = json.load(file)
            resource = payload["LexicalResource"]
            information = features(resource.get("GlobalInformation"))
            source_labels.add(text(information.get("label")))
            source_dates.add(text(information.get("creationDate")))

            for lexicon in sequence(resource.get("Lexicon")):
                for entry in sequence(lexicon.get("LexicalEntry")):
                    counts["sourceEntries"] += 1
                    # A source entry may contain one primary lemma and an
                    # additional lemma object describing spelling variants.
                    korean = next((
                        text(features(lemma).get("writtenForm"))
                        for lemma in sequence(entry.get("Lemma"))
                        if text(features(lemma).get("writtenForm"))
                    ), "")
                    entry_features = features(entry)
                    entry_feature_names.update(entry_features)
                    if not korean:
                        counts["entriesWithoutHeadword"] += 1
                        continue

                    chinese_senses = []
                    for sense in sequence(entry.get("Sense")):
                        for equivalent in sequence(sense.get("Equivalent")):
                            translated = features(equivalent)
                            if text(translated.get("language")) != "중국어":
                                continue
                            counts["chineseEquivalentRecords"] += 1
                            # Prefer the source's concise translation lemma.
                            # Do not invent or truncate a meaning when it is absent.
                            chinese = text(translated.get("lemma"))
                            if not chinese:
                                counts["chineseEquivalentsWithoutLemma"] += 1
                                continue
                            if chinese in PLACEHOLDERS:
                                counts["chinesePlaceholderEquivalentsExcluded"] += 1
                                continue
                            if len(chinese) > MAX_GLOSS_LENGTH:
                                counts["chineseLongEquivalentsExcluded"] += 1
                                continue
                            if chinese not in chinese_senses:
                                chinese_senses.append(chinese)

                    if not chinese_senses:
                        counts["entriesWithoutChineseLemma"] += 1
                        continue

                    counts["entriesWithChinese"] += 1
                    counts["sensesInDetailedEntries"] += len(chinese_senses)
                    compact_senses = index.setdefault(korean, [])
                    for chinese in chinese_senses:
                        if chinese not in compact_senses:
                            compact_senses.append(chinese)
                    detailed_entries.append({
                        "korean": korean,
                        "senses": chinese_senses,
                        "partOfSpeech": text(entry_features.get("partOfSpeech")),
                        "homonym": text(entry_features.get("homonym_number")),
                        "entryId": text(entry.get("val")) if entry.get("att") == "id" else text(entry.get("id")),
                    })

    if not index:
        raise ValueError("No official Chinese translation lemmas were found.")
    index = dict(sorted(index.items()))
    detailed_entries.sort(key=lambda entry: (entry["korean"], entry["homonym"], entry["entryId"]))
    output_dir.mkdir(parents=True, exist_ok=True)
    compact_path = output_dir / "dictionary.zh-ko.json"
    detailed_path = output_dir / "dictionary.entries.json"
    write_json(compact_path, index)
    write_json(detailed_path, detailed_entries)

    headword_counts = Counter(entry["korean"] for entry in detailed_entries)
    counts["jsonFiles"] = len(filenames)
    counts["uniqueHeadwords"] = len(index)
    counts["uniqueIndexedSenses"] = sum(map(len, index.values()))
    counts["headwordsWithMultipleEntries"] = sum(amount > 1 for amount in headword_counts.values())
    counts["headwordsWithMultipleSenses"] = sum(len(senses) > 1 for senses in index.values())
    samples = {
        word: index.get(word, [])
        for word in (
            "봄", "학교", "사과", "공부하다", "가다", "안경",
            "가치관", "정체성", "책임감", "소통", "자존감", "헷갈리다", "낯설다",
        )
    }
    report = {
        "schemaVersion": 1,
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "source": {
            "downloadUrl": SOURCE_URL,
            "downloadPage": DOWNLOAD_PAGE,
            "publisher": "National Institute of Korean Language (국립국어원)",
            "snapshot": "2026-09-19",
            "archiveFile": source_path.name,
            "archiveBytes": source_path.stat().st_size,
            "archiveSha256": sha256(source_path),
            "sourceLabels": sorted(source_labels),
            "sourceCreationDates": sorted(source_dates),
            "jsonMembers": filenames,
        },
        "license": {
            "identifier": "CC-BY-SA-2.0-KR",
            "url": LICENSE_URL,
            "publisherCopyrightPolicy": COPYRIGHT_URL,
            "attribution": ATTRIBUTION,
            "scope": "Exported dictionary text data; multimedia and example sentences are excluded.",
        },
        "transformations": [
            "Select Sense.Equivalent records whose language is 중국어.",
            "Use the source's Chinese lemma verbatim except surrounding whitespace and NFC normalization.",
            "Skip equivalents with an empty Chinese lemma; no generated or truncated meanings.",
            "Exclude publisher placeholders such as (无对应词汇), which are not usable translations.",
            "Skip Chinese lemmas longer than 120 characters without truncating them.",
            "Group concise Chinese senses by Korean writtenForm and deduplicate exact same strings.",
            "Keep separate source entries in dictionary.entries.json for homonyms and parts of speech.",
            "Do not export examples, translations in other languages, audio, images, or other media.",
        ],
        "counts": dict(sorted(counts.items())),
        "entryFeatureNames": sorted(entry_feature_names),
        "outputs": {
            compact_path.name: {"bytes": compact_path.stat().st_size, "sha256": sha256(compact_path)},
            detailed_path.name: {"bytes": detailed_path.stat().st_size, "sha256": sha256(detailed_path)},
        },
        "samples": samples,
        "limitations": [
            "A learning dictionary does not cover every spelling, proper noun, inflected form, or new term.",
            "Chinese reverse lookup should keep candidates separate where a Chinese gloss maps to multiple Korean entries.",
            "The compact index keeps all available source senses, not a guaranteed single contextual translation.",
        ],
    }
    write_json(output_dir / "source.json", report, pretty=True)
    print(json.dumps({"counts": report["counts"], "outputs": report["outputs"], "samples": samples}, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    asset_dir = Path(__file__).resolve().parent
    parser.add_argument("--source", type=Path, default=asset_dir / "source" / "krdict-json-20260919.zip")
    parser.add_argument("--output-dir", type=Path, default=asset_dir)
    args = parser.parse_args()
    export(args.source.resolve(), args.output_dir.resolve())


if __name__ == "__main__":
    main()
