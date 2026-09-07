# COCA Rank Integration

## Behavior

- Lookup keeps its existing definition, vocabulary detail and work-context prompt. Local candidates are appended to the same request. Ordinary questions do not load the dataset or receive candidate context.
- Exact phrase lookup precedes word lookup. Regular third-person, plural, past/participle, `-ing`, comparative and superlative forms provide possible lemmas with compatible POS. Contextual POS/sense selection belongs to the AI; the candidate list itself does not claim to resolve sentence grammar.
- Rules handle final-e removal (including `agreed`, `freed`, `guaranteed`, `freer/freest`), y/i changes, doubled consonants (including `quizzes`), inserted k (`panicked/panicking`, `picnicked/picnicking`) and `lying -> lie`. Irregular past/participle exception dictionaries are not used. An exact `saw/v` entry describes the verb meaning to cut, not the past tense of `see`. The candidate usage and prompt make this restriction explicit; the renderer does not infer word sense from the position of Chinese explanation text.
- One-step WordNet derivational/pertainym links provide reference candidates only when the source POS has no exact or regular rank. Sources with more than one ranked target for that POS are discarded. No synonym, edit-distance, recursive root or blind suffix-based derivation is used.
- AI emits `[[COCA:request-namespace:candidate-id]]`. The local renderer substitutes word/POS/rank, labels lemmas and references, suppresses duplicates, allows at most one reference, and removes unknown, stale and incomplete markers before Markdown rendering. This same path handles streaming, stop, error and retry. Exact candidates override regular candidates for the same surface/POS; a referenced exact/regular candidate overrides a reference for that surface.
- Lookup retries reuse their candidate IDs. Subsequent ordinary replies discard old markers; the server conversation API remains unchanged. Before inserting local labels, lookup rendering removes model-written COCA clauses and explicit Chinese rank claims (including partial streamed numbers, grouped digits, full-width digits and Chinese numerals). This also applies when local data fails and on stop/error/retry. Ordinary AI questions retain their existing text rendering. The prompt requires ID-only citations; the text filter recognizes rank expressions, not arbitrary paraphrases. Grammatical/sense correctness still depends on the model following the prompt.
- Selection limit: 500 characters, 32 distinct English tokens, 160 candidates. Overlong selections omit rank enrichment. Cache is lazy and shared; a rejected load is retryable. Native `DecompressionStream('gzip')` is required for ranks; its absence leaves lookup usable without rank enrichment.

## Data Provenance

Source: the user's `COCA Frequency 60000.mdx`, compiled 2016-02-12 by Fuxy526 based on onlyXXenglish. This is the supplied historical dictionary, not a live/current COCA endpoint. The original MDX remains untouched.

- Source bytes: 2,079,808.
- Source SHA-256: `5f72e6e01c6e449ed2e4a0d76fe64d592070bf92925256738ce5cf8bb7213cb1`.
- Words: 53,967. Word/POS rows: 60,022.
- Original ranks: 1 through 60,024, excluding 30,509 and 34,540. No renumbering.
- Canonical rank SHA-256: `3e4f837801332a7e416366dc2a1c8195f51fd31d75b663a32dde737a1c6eb07d`. Canonical JSON is the sorted word list with each word's `[pos, rank]` rows sorted by rank, compact UTF-8 JSON without ASCII escaping.
- Known rows: `run/v = 202`, `running/j = 3273`, `running/n = 4719`, `apple/n = 2711`.
- Lexical relations: WordNet 3.0, 7,184 source words / 7,210 source-POS relations. WordNet ZIP SHA-256: `cbda5ea6eef7f36a97a43d4a75f85e07fccbb4f23657d27b4ccbc93e2646ab59`.
- WordNet package URL: <https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/wordnet.zip>. Its license is preserved in `assets/WORDNET-LICENSE.md` and in the generated JS, including single HTML builds.

The extractor reads POS and rank fields; frequencies, genre counts, percentages and entry HTML are not included in the player. The WordNet license applies to the lexical relations, independently of the user-supplied COCA data.

## Encoding and Size

`js/coca_data.js` contains two Base64 gzip strings. Rank binary v2 contains a JSON header terminated by LF, UTF-8 suffix strings separated by LF, a prefix-length byte column, a per-word POS-count byte column, low and high rank-byte columns, then a POS-index byte column. Prefix lengths count BMP characters; decoding validates length, ordering, row counts, POS indexes and unique ranks. Relations are compact JSON in their own gzip stream.

Measured on 2026-09-07:

| Component | Bytes | Approximate Size |
| --- | ---: | ---: |
| Rank gzip | 269,980 | 263.7 KiB |
| Rank Base64 | 359,976 | 351.5 KiB |
| Relation gzip | 51,925 | 50.7 KiB |
| Relation Base64 | 69,236 | 67.6 KiB |
| Generated data JS, metadata and license | 431,651 | 421.5 KiB |
| Rank logic | 14,536 | 14.2 KiB |
| Source HTML (loads the local JS assets) | 403,168 | 393.7 KiB |
| Single HTML including the player | 1,444,775 | 1.38 MiB |

The previous single HTML was 996,187 bytes; the complete feature adds about 438 KiB, including data, explicit lexical relations, loader, rendering and prompt integration. Final-build Chrome MCP first-use decode plus both Maps/relations construction measured 71.6 ms for the source HTML and 65.5 ms for the single HTML; cached calls measured 0 ms in those runs. Earlier runs in the same session measured 105.9-154.8 ms. Timings vary by hardware and browser. The source HTML loads two local JS files; the single HTML embeds them and does not fetch rank assets.

## Rebuild and Verify

Normal changes need no Python or WordNet installation. Run:

```powershell
pnpm.cmd test
pnpm.cmd run build:single-html
```

To regenerate only when the dictionary/encoding/relations change, supply the user's MDX and a project-local WordNet download directory:

```powershell
uv run --python 3.13 --with mdict-utils --with nltk==3.9.1 scripts/build_coca_data.py "C:\path\COCA Frequency 60000.mdx" --wordnet-dir .cache/coca-wordnet
```

The builder downloads WordNet if absent; an existing ZIP at `<wordnet-dir>/corpora/wordnet.zip` is also accepted. Outputs are `js/coca_data.js` and `assets/WORDNET-LICENSE.md`. Generated metadata records input hashes and relation counts. The test suite compares the entire decoded canonical dataset to the source-extraction hash, not just the sample entries.

`scripts/test_coca_browser.js` uses Playwright with a local Chrome installation. Make the `playwright` module available, or set `SVP_PLAYWRIGHT` to its module directory, then run `node scripts/test_coca_browser.js`. It opens isolated `file://` source/single pages and mocks `/models` and SSE `/stream` in those pages; no real model is called. It checks one request per lookup, contextual noun/adjective/verb selections, phrase labeling, lexical references, partial stream suppression, stop, error, retry, ordinary follow-up, data failure, conversation reset during loading, desktop/mobile wrapping, and browser errors. Screenshots and timing reports are written to a printed temporary directory.

Automated browser checks verify the integration contract and display. Real-model linguistic choices remain a separate manual acceptance check.

## Real Browser Acceptance (2026-09-07)

Chrome MCP connected to the user's already-open source and single HTML tabs, preserving the configured `kimi / kimi-for-coding-highspeed` model. There were 15 real requests: 14 completed and one was intentionally stopped after visible streaming text. No unexpected incomplete real response occurred.

- Correct real-model references: `agreed -> agree/v 514`, `quizzes -> quiz/n 8958`, `freer/freest -> free/j 473`, cutting-sense `saw/v 14302`, `running -> run/v 202`, `running/n 4719`, `running costs -> running/j 3273`, `algebraically -> reference algebraic/j 33119`, and `panicked -> panic/v 6956`.
- The real answer for `I saw him leave the building` omitted rank. Ordinary follow-up received no candidate context. With an injected local data-load rejection, the real `apples` answer completed without rank.
- A separate synthetic SSE fault included a valid ID, a fabricated numeric rank, an incomplete marker, and an error carrying another marker/number. The source page kept the local rank, removed the fabricated claims and incomplete/error markers, and displayed retry. Retry used the same candidate payload and completed against the real model.
- A real single-HTML `panicked` stream was stopped through the page's stop button; another lookup completed successfully afterward. Both final-build pages also checked all eight new inflection cases, every marker split boundary, natural-position `saw` brackets, and untrusted numeric-claim removal in the browser.
- Actual Chrome copy (`Control+C`) was checked against the Windows clipboard. Text matched the selected rendered answer after CRLF normalization, retained the local rank, and contained no internal markers.
- No internal marker/numeric fault leaks were observed in message DOM mutations, and no console errors were reported. Expected data-load failure and existing sanitizer warnings were present. Temporary fetch/load instrumentation was removed after testing; model settings were preserved.

`pnpm.cmd test` passed all 41 tests. `pnpm.cmd run build:single-html` succeeded; both source inline scripts and all 14 single-HTML inline scripts parsed successfully. These checks validate the tested rank integration and sample model choices; they do not certify arbitrary model prose or all possible paraphrases of rank claims.
