"""Export lookup priorities from the official Korean-Chinese dictionary ZIP.

The ranks describe the source's vocabulary level and original sense position;
they are not word-frequency measurements. Meanings, examples and media are not
copied or changed. Every rank remains aligned with the existing compact index.
"""

from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import unicodedata
import zipfile


EXPECTED_SOURCE_SHA256 = "f9c1b9309afe66429a92cca1b2c426db25ec809d04103aca74c3a23859280df6"
LEVEL_RANKS = {"초급": 0, "중급": 1, "고급": 2, "ungraded": 3}
ATTRIBUTION = (
    "National Institute of Korean Language (국립국어원), Basic Korean Dictionary "
    "(한국어기초사전), Korean-Chinese data snapshot 2026-09-19. "
    "CC-BY-SA-2.0-KR, https://creativecommons.org/licenses/by-sa/2.0/kr/. "
    "Priorities use source vocabulary levels and original sense order, "
    "not measured word frequency."
)


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


def export(source_path, dictionary_path, output_path):
    if output_path in (source_path, dictionary_path):
        raise ValueError("The priority output must not overwrite the source or compact dictionary.")
    source_hash = sha256(source_path)
    if source_hash != EXPECTED_SOURCE_SHA256:
        raise ValueError(
            "The source ZIP does not match the documented 2026-09-19 snapshot. "
            "Verify a new source before updating EXPECTED_SOURCE_SHA256."
        )

    with dictionary_path.open(encoding="utf-8") as file:
        dictionary = json.load(file)
    if not isinstance(dictionary, dict) or not dictionary:
        raise ValueError("The compact dictionary must be a nonempty object.")
    for korean, senses in dictionary.items():
        if not isinstance(korean, str) or not isinstance(senses, list):
            raise ValueError("The compact dictionary must map headwords to sense arrays.")
        if not all(isinstance(sense, str) for sense in senses):
            raise ValueError("Every compact dictionary sense must be a string.")

    priorities = {}
    counts = Counter()
    with zipfile.ZipFile(source_path) as archive:
        members = sorted(
            (member for member in archive.infolist() if member.filename.endswith(".json")),
            key=lambda member: member.filename,
        )
        if not members or sum(member.file_size for member in members) > 2 * 1024**3:
            raise ValueError("Unexpected official ZIP contents or uncompressed size.")
        for member in members:
            with archive.open(member) as file:
                payload = json.load(file)
            for lexicon in sequence(payload["LexicalResource"].get("Lexicon")):
                for entry in sequence(lexicon.get("LexicalEntry")):
                    counts["sourceEntries"] += 1
                    korean = next((
                        text(features(lemma).get("writtenForm"))
                        for lemma in sequence(entry.get("Lemma"))
                        if text(features(lemma).get("writtenForm"))
                    ), "")
                    if korean not in dictionary:
                        continue
                    level = text(features(entry).get("vocabularyLevel"))
                    level_rank = LEVEL_RANKS.get(level, LEVEL_RANKS["ungraded"])
                    for sense_order, sense in enumerate(sequence(entry.get("Sense")), start=1):
                        for equivalent in sequence(sense.get("Equivalent")):
                            translated = features(equivalent)
                            if text(translated.get("language")) != "중국어":
                                continue
                            chinese = text(translated.get("lemma"))
                            if chinese not in dictionary[korean]:
                                continue
                            key = (korean, chinese)
                            rank = (level_rank, sense_order)
                            if key not in priorities or rank < priorities[key]:
                                priorities[key] = rank
                            counts["matchingSourceEquivalents"] += 1

    entries = {}
    unmapped = []
    for korean, senses in dictionary.items():
        ranks = []
        for index, chinese in enumerate(senses):
            rank = priorities.get((korean, chinese))
            if rank is None:
                rank = (LEVEL_RANKS["ungraded"], index + 1)
                unmapped.append({"korean": korean, "senseIndex": index, "chinese": chinese})
            else:
                counts["mappedSenses"] += 1
            ranks.append(list(rank))
            counts["senseRanks"] += 1
        entries[korean] = ranks
    counts["headwords"] = len(entries)
    counts["unmappedSenses"] = len(unmapped)
    result = {
        "schemaVersion": 1,
        "dictionarySha256": sha256(dictionary_path),
        "attribution": ATTRIBUTION,
        "levelRanks": LEVEL_RANKS,
        "entries": entries,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n"
    output_path.write_text(serialized, encoding="utf-8")
    report = {
        "sourceSha256": source_hash,
        "dictionarySha256": result["dictionarySha256"],
        "outputSha256": sha256(output_path),
        "outputBytes": output_path.stat().st_size,
        "counts": dict(sorted(counts.items())),
        "unmapped": unmapped,
        "samples": {
            korean + " · " + chinese: entries[korean][dictionary[korean].index(chinese)]
            for korean, chinese in (
                ("날", "白天"), ("낮", "白天，白日，日间"),
                ("하루", "一天"), ("일간", "一天"),
            )
            if korean in dictionary and chinese in dictionary[korean]
        },
    }
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    project_dir = Path(__file__).resolve().parent.parent
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--dictionary", type=Path, default=project_dir / "src/data/krdict-ko-zh-202609.json")
    parser.add_argument("--output", type=Path, default=project_dir / "src/data/krdict-lookup-priority.json")
    args = parser.parse_args()
    report = export(args.source.resolve(), args.dictionary.resolve(), args.output.resolve())
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
