"""Build offline rank assets: uv run --with mdict-utils --with nltk==3.9.1 this_file MDX --wordnet-dir DIR."""

import argparse
import base64
import gzip
import hashlib
import json
import xml.etree.ElementTree as ET
from pathlib import Path

import nltk
from mdict_utils.reader import MDX
from nltk.corpus.reader import WordNetCorpusReader
from nltk.data import ZipFilePathPointer


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()


def pack(value):
    return base64.b64encode(gzip.compress(value, compresslevel=9, mtime=0)).decode()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("mdx", type=Path)
    parser.add_argument("--wordnet-dir", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    dictionary = MDX(str(args.mdx))
    records = {}
    ranks = set()
    for key, body in dictionary.items():
        word = key.decode()
        html = body.decode()
        entry = ET.fromstring(html[html.index('<div class="coca">'):html.index('<script')])
        children = list(entry)
        rows = []
        for index, child in enumerate(children):
            if child.get("class") == "pos":
                rank = children[index + 1]
                assert rank.get("class") == "rank"
                value = int(rank.text)
                assert value not in ranks
                ranks.add(value)
                rows.append([child.text, value])
        assert rows and word not in records
        records[word] = rows
    assert len(records) == 53967 and len(ranks) == 60022
    assert set(range(1, 60025)) - ranks == {30509, 34540}
    words = sorted(records)
    positions = sorted({pos for rows in records.values() for pos, _ in rows})
    prefixes, suffixes, counts, flat = [], [], [], []
    previous = ""
    for word in words:
        assert all(ord(character) <= 0xFFFF for character in word) and "\n" not in word
        shared = 0
        while shared < min(len(word), len(previous)) and word[shared] == previous[shared]:
            shared += 1
        assert shared < 256 and len(records[word]) < 256
        prefixes.append(shared)
        suffixes.append(word[shared:])
        counts.append(len(records[word]))
        flat.extend(records[word])
        previous = word
    suffix_bytes = "\n".join(suffixes).encode()
    header = compact(dict(version=2, words=len(words), records=len(flat), suffixBytes=len(suffix_bytes), positions=positions))
    raw = b"\n".join([header, suffix_bytes]) + bytes(prefixes) + bytes(counts)
    raw += bytes(rank & 255 for _, rank in flat)
    raw += bytes(rank >> 8 for _, rank in flat)
    raw += bytes(positions.index(pos) for pos, _ in flat)

    zip_path = args.wordnet_dir / "corpora" / "wordnet.zip"
    if not zip_path.exists():
        nltk.download("wordnet", download_dir=str(args.wordnet_dir), raise_on_error=True)
    nltk.data.path.insert(0, str(args.wordnet_dir))
    wordnet = WordNetCorpusReader(ZipFilePathPointer(str(zip_path), "wordnet/"), None)
    pos_map = {"a": "j", "s": "j", "r": "r", "n": "n", "v": "v"}
    available = {(word, pos) for word, rows in records.items() for pos, _ in rows}
    relations = {}
    for synset in wordnet.all_synsets():
        source_pos = pos_map[synset.pos()]
        for lemma in synset.lemmas():
            source = lemma.name().lower()
            if not source.isascii() or "_" in source or (source, source_pos) in available:
                continue
            # Pertainyms include adverb -> adjective; '+' alone misses that relation.
            for target in lemma.derivationally_related_forms() + lemma.pertainyms():
                target_word = target.name().lower()
                target_pos = pos_map[target.synset().pos()]
                if source_pos == target_pos or (target_word, target_pos) not in available:
                    continue
                relations.setdefault((source, source_pos), set()).add((target_word, target_pos))
    fallback = {}
    for (word, pos), targets in sorted(relations.items()):
        if len(targets) == 1:
            target_word, target_pos = next(iter(targets))
            fallback.setdefault(word, []).append([pos, target_word, target_pos])
    # Preserve same-word synset distinctions; no spelling-distance or exception-list inference.
    rank_payload, fallback_payload = pack(raw), pack(compact(fallback))
    canonical = compact([[word, sorted(records[word], key=lambda row: row[1])] for word in words])
    metadata = dict(source="COCA Frequency 60000 / MDX 2016-02-12", words=len(words), records=len(flat),
                    sourceSha256=hashlib.sha256(args.mdx.read_bytes()).hexdigest(),
                    ranksSha256=hashlib.sha256(canonical).hexdigest(),
                    wordnetVersion=wordnet.get_version(), wordnetSha256=hashlib.sha256(zip_path.read_bytes()).hexdigest(),
                    fallbackWords=len(fallback), fallbackRelations=sum(map(len, fallback.values())))
    payload = dict(metadata=metadata, ranks=rank_payload, relations=fallback_payload)
    license_text = wordnet.open("LICENSE").read()
    generated = "// Generated by scripts/build_coca_data.py; contains ranks and lexical relations only.\n"
    generated += "/* WordNet lexical relations license:\n" + license_text + "\n*/\n"
    generated += "(function (root) {\n    var data = " + compact(payload).decode() + ";\n"
    generated += "    if (typeof module === 'object' && module.exports) module.exports = data;\n"
    generated += "    if (root) root.SvpCocaData = data;\n})(typeof globalThis !== 'undefined' ? globalThis : this);\n"
    destination = root / "js" / "coca_data.js"
    destination.write_text(generated, encoding="utf-8")
    (root / "assets" / "WORDNET-LICENSE.md").write_text(license_text, encoding="utf-8")
    print(json.dumps(dict(**metadata, rankBase64Bytes=len(rank_payload), fallbackBase64Bytes=len(fallback_payload),
                          assetBytes=destination.stat().st_size), indent=2))


if __name__ == "__main__":
    main()
