"""Export public NIKL pronunciation link metadata, without downloading audio."""

from collections import Counter
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit
import unicodedata
import zipfile


def sequence(value):
    return value if isinstance(value, list) else [value] if isinstance(value, dict) else []


def features(node):
    if not isinstance(node, dict):
        return {}
    return {item["att"]: item.get("val", "") for item in sequence(node.get("feat")) if "att" in item}


def save_json(path, value, pretty=False):
    serialized = json.dumps(value, ensure_ascii=False, indent=2 if pretty else None,
                            separators=None if pretty else (",", ":")) + "\n"
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(serialized.encode("utf-8"))
    temporary.replace(path)


def main():
    directory = Path(__file__).resolve().parent
    asset_directory = directory.parent
    dictionary_entries = json.loads((asset_directory / "dictionary.entries.json").read_text(encoding="utf-8"))
    # Idioms/proverbs can reuse their parent word's source ID. Match the
    # written headword and homonym too, so an idiom never receives its
    # parent word's recording or replaces the parent's Chinese senses.
    chinese_entries = {(entry["entryId"], entry["korean"], entry["homonym"]): entry for entry in dictionary_entries}
    source_metadata = json.loads((asset_directory / "source.json").read_text(encoding="utf-8"))
    links = {}
    counts = Counter()
    used_entry_ids = set()
    extensions = Counter()
    selected_types = set()
    source_zip = asset_directory / "source" / "krdict-json-20260919.zip"
    with zipfile.ZipFile(source_zip) as archive:
        for member in sorted(archive.namelist()):
            if not member.endswith(".json"):
                continue
            resource = json.load(archive.open(member))["LexicalResource"]
            for lexicon in sequence(resource.get("Lexicon")):
                for source_entry in sequence(lexicon.get("LexicalEntry")):
                    counts["sourceEntries"] += 1
                    entry_id = str(source_entry.get("val", "")) if source_entry.get("att") == "id" else ""
                    korean = next((unicodedata.normalize("NFC", str(features(lemma).get("writtenForm", "")).strip())
                                   for lemma in sequence(source_entry.get("Lemma"))
                                   if features(lemma).get("writtenForm")), "")
                    source_homonym = str(features(source_entry).get("homonym_number", "")).strip()
                    chinese_entry = chinese_entries.get((entry_id, korean, source_homonym))
                    if not chinese_entry:
                        counts["sourceEntriesWithoutUsableChineseEntry"] += 1
                        continue
                    korean = chinese_entry["korean"]
                    for word_form in sequence(source_entry.get("WordForm")):
                        info = features(word_form)
                        if info.get("type") != "발음":
                            if info.get("sound"):
                                counts["inflectionAudioLinksExcluded"] += 1
                            continue
                        url = str(info.get("sound", "")).strip()
                        if not url:
                            counts["headwordPronunciationsWithoutSound"] += 1
                            continue
                        address = urlsplit(url)
                        if address.scheme != "https" or address.hostname not in {"dicmedia.korean.go.kr", "krdicmedia.korean.go.kr"}:
                            counts["nonOfficialOrNonHttpsUrlsExcluded"] += 1
                            continue
                        pronunciation = str(info.get("pronunciation", "")).strip()
                        pronunciation_is_label_only = not pronunciation
                        if pronunciation_is_label_only:
                            pronunciation = korean
                            counts["headwordLabelsUsedForMissingPronunciation"] += 1
                        record = {
                            "entryId": entry_id,
                            "homonym": chinese_entry["homonym"],
                            "pronunciation": pronunciation,
                            "url": url,
                            "chineseSenses": chinese_entry["senses"],
                        }
                        if pronunciation_is_label_only:
                            record["pronunciationIsLabelOnly"] = True
                        candidates = links.setdefault(korean, [])
                        if record not in candidates:
                            candidates.append(record)
                            selected_types.add(info["type"])
                            used_entry_ids.add(entry_id)
                            counts["pronunciationLinkRecords"] += 1
                            extensions[address.path.rsplit(".", 1)[-1].lower()] += 1
    links = dict(sorted(links.items()))
    for candidates in links.values():
        candidates.sort(key=lambda item: (int(item["homonym"] or "0"), int(item["entryId"])))
    counts["headwordsWithPronunciationLinks"] = len(links)
    counts["sourceEntriesWithPronunciationLinks"] = len(used_entry_ids)
    counts["headwordsWithMultipleCandidates"] = sum(len(items) > 1 for items in links.values())
    output = directory / "pronunciation-links.json"
    raw = (json.dumps(links, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    checks = {
        "allLinksAreOriginalOfficialHttpsUrls": all(urlsplit(item["url"]).scheme == "https" and urlsplit(item["url"]).hostname in {"dicmedia.korean.go.kr", "krdicmedia.korean.go.kr"} for candidates in links.values() for item in candidates),
        "allRecordsMatchChineseSourceEntry": all((item["entryId"], korean, item["homonym"]) in chinese_entries and item["chineseSenses"] == chinese_entries[(item["entryId"], korean, item["homonym"])]["senses"] for korean, candidates in links.items() for item in candidates),
        "allCandidateListsAreNonempty": all(links.values()),
        "allRecordFieldsAreNonempty": all(item["entryId"] and item["pronunciation"] and item["url"] and item["chineseSenses"] for candidates in links.values() for item in candidates),
        "onlyHeadwordPronunciationTypesSelected": selected_types == {"발음"},
        "friendEntryAndPronunciationPresent": any(item["entryId"] == "29742" and item["pronunciation"] == "친구" for item in links.get("친구", [])),
        "appleEntryAndPronunciationPresent": any(item["entryId"] == "66371" and item["homonym"] == "1" and "苹果" in item["chineseSenses"] and item["pronunciation"] == "사과" for item in links.get("사과", [])),
        "apologyEntryAndPronunciationPresent": any(item["entryId"] == "15830" and item["homonym"] == "2" and "道歉" in item["chineseSenses"] and item["pronunciation"] == "사ː과" for item in links.get("사과", [])),
        "valueSystemEntryAndPronunciationPresent": any(item["entryId"] == "15035" and item["pronunciation"] == "가치관" and "价值观" in item["chineseSenses"] for item in links.get("가치관", [])),
        "eyeSourceEntryPresent": any(item["entryId"] == "72704" and item["homonym"] == "1" and "眼睛" in item["chineseSenses"] for item in links.get("눈", [])),
        "snowSourceEntryPresent": any(item["entryId"] == "20198" and item["homonym"] == "4" and "雪" in item["chineseSenses"] for item in links.get("눈", [])),
        "schoolHeadwordPronunciationPresent": any(item["pronunciation"] == "학꾜" and "学校" in item["chineseSenses"] for item in links.get("학교", [])),
        "springHeadwordPronunciationPresent": any(any("春" in sense for sense in item["chineseSenses"]) for item in links.get("봄", [])),
    }
    if not all(checks.values()):
        raise ValueError("Pronunciation link validation failed.")
    save_json(output, links)
    report = {
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "source": source_metadata["source"],
        "schema": "{korean:[{entryId,homonym,pronunciation,url,chineseSenses},...]}",
        "counts": dict(sorted(counts.items())),
        "extensions": dict(extensions),
        "officialHostsUsed": sorted({urlsplit(item["url"]).hostname for candidates in links.values() for item in candidates}),
        "coveragePercentOfChineseHeadwords": round(len(links) / source_metadata["counts"]["uniqueHeadwords"] * 100, 2),
        "output": {"file": output.name, "bytes": len(raw), "gzipBytes": len(gzip.compress(raw, mtime=0)), "sha256": hashlib.sha256(raw).hexdigest()},
        "checks": checks,
        "metadataAttribution": source_metadata["license"],
        "audioCopyrightPolicy": "https://krdict.korean.go.kr/kor/kboardPolicy/copyRightTermsInfo",
        "audioLicenseStatus": "Not individually established; do not describe recordings as CC BY-SA. This export contains URL and textual metadata only, not audio.",
        "officialLinkingEvidence": [
            "https://www.law.go.kr/LSW/precInfoP.do?precSeq=195427",
            "https://lx.scourt.go.kr/search/detail/precedent/0/3264758",
        ],
        "rules": [
            "Select only source WordForm type 발음, never 활용 or sentence recordings.",
            "Preserve original source HTTPS URL without changing the format or hostname.",
            "Match Chinese senses through source entryId + written headword + homonym; idioms can reuse their parent ID.",
            "If source pronunciation text is absent, retain the sound URL and use the headword only as a display label, marking pronunciationIsLabelOnly=true.",
            "Keep separate homonyms and alternative pronunciation records.",
            "Do not proxy, rehost, bundle, predownload, or alter linked audio in this exporter.",
        ],
        "samples": {word: links.get(word, []) for word in ["친구", "학교", "봄", "사과", "가치관", "눈", "말"]},
    }
    save_json(directory / "pronunciation-links.source.json", report, pretty=True)
    print(json.dumps({key: report[key] for key in ["counts", "coveragePercentOfChineseHeadwords", "output", "checks", "samples"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
