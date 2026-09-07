(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SvpCocaRank = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    var pending;
    var sequence = 0;
    var posNames = { a: '冠词', c: '连词', d: '限定词', e: '存在词', i: '介词', j: '形容词', m: '数词', n: '名词', p: '代词', r: '副词', t: '不定式标记', u: '感叹词', v: '动词', x: '否定词' };

    async function inflate(base64) {
        var bytes = Uint8Array.from(atob(base64), function (c) { return c.charCodeAt(0); });
        var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    function decodeRanks(bytes) {
        var newline = bytes.indexOf(10);
        if (newline < 0) throw new Error('Missing COCA header');
        var decoder = new TextDecoder('utf-8', { fatal: true });
        var header = JSON.parse(decoder.decode(bytes.subarray(0, newline)));
        if (header.version !== 2 || !Number.isInteger(header.words) || header.words < 1 ||
            !Number.isInteger(header.records) || header.records < header.words ||
            !Number.isInteger(header.suffixBytes) || header.suffixBytes < 1 ||
            !Array.isArray(header.positions) || header.positions.some(function (p) { return !posNames[p]; })) {
            throw new Error('Invalid COCA header');
        }
        var offset = newline + 1;
        var end = offset + header.suffixBytes;
        if (end + 2 * header.words + 3 * header.records !== bytes.length) throw new Error('Invalid COCA length');
        var suffixes = decoder.decode(bytes.subarray(offset, end)).split('\n');
        if (suffixes.length !== header.words) throw new Error('Invalid COCA words');
        var prefixes = end;
        var counts = prefixes + header.words;
        var low = counts + header.words;
        var high = low + header.records;
        var positions = high + header.records;
        var words = new Map();
        var previous = '';
        var record = 0;
        var ranks = new Set();
        suffixes.forEach(function (suffix, index) {
            if (bytes[prefixes + index] > previous.length) throw new Error('Invalid COCA prefix');
            var word = previous.slice(0, bytes[prefixes + index]) + suffix;
            if (!word || (index && word <= previous) || !bytes[counts + index]) throw new Error('Invalid COCA ordering');
            var rows = [];
            var seenPos = new Set();
            for (var i = 0; i < bytes[counts + index]; i++, record++) {
                var rank = bytes[low + record] + 256 * bytes[high + record];
                var pos = header.positions[bytes[positions + record]];
                if (record >= header.records || !pos || !rank || ranks.has(rank) || seenPos.has(pos)) throw new Error('Invalid COCA record');
                ranks.add(rank);
                seenPos.add(pos);
                rows.push([pos, rank]);
            }
            words.set(word, rows);
            previous = word;
        });
        if (record !== header.records) throw new Error('Invalid COCA count');
        return words;
    }

    async function decode(data) {
        var words = decodeRanks(await inflate(data.ranks));
        var relations = JSON.parse(new TextDecoder().decode(await inflate(data.relations)));
        Object.keys(relations).forEach(function (word) {
            relations[word].forEach(function (row) {
                if (row.length !== 3 || !posNames[row[0]] || !(words.get(row[1]) || []).some(function (entry) { return entry[0] === row[2]; })) {
                    throw new Error('Invalid COCA relation');
                }
            });
        });
        return { words: words, relations: relations };
    }

    function load() {
        if (!pending) {
            pending = Promise.resolve().then(function () { return decode(globalThis.SvpCocaData); }).catch(function (err) {
                pending = null;
                throw err;
            });
        }
        return pending;
    }

    function normalize(text) {
        return String(text || '').toLowerCase().replace(/[\u2018\u2019]/g, "'").trim().replace(/\s+/g, ' ');
    }

    function regularForms(surface) {
        var results = [];
        function add(word, pos, match) {
            if (word.length > 1 && word !== surface) results.push({ word: word, pos: pos, match: match });
        }
        function suffix(suffix, pos, match) {
            if (!surface.endsWith(suffix)) return;
            var stem = surface.slice(0, -suffix.length);
            if (stem.length < 2) return;
            var needsDoubling = /^[^aeiou]*[aeiou][b-df-hj-np-tv-z]$/.test(stem) && !/[wxy]$/.test(stem);
            var changesY = /[^aeiou]y$/.test(stem) && suffix !== 'ing';
            var keepsE = suffix === 'ing' && (/[eo]e$/.test(stem) || /^(be|dye|singe|tinge)$/.test(stem));
            if (!needsDoubling && !changesY && (!stem.endsWith('e') || keepsE)) add(stem, pos, match);
            // -ed/-er/-est also remove one e from -ee words: agreed, freer, freest.
            if ((suffix !== 'ing' || !stem.endsWith('e')) && !(suffix === 'ing' && stem.endsWith('y'))) add(stem + 'e', pos, match);
            if (/([b-df-hj-np-tv-z])\1$/.test(stem) && !/[wxy]$/.test(stem)) add(stem.slice(0, -1), pos, match);
            if ((suffix === 'ed' || suffix === 'ing') && stem.endsWith('ick')) add(stem.slice(0, -1), pos, match);
            if (stem.endsWith('i') && suffix !== 'ing') add(stem.slice(0, -1) + 'y', pos, match);
            if (suffix === 'ing' && stem.endsWith('y')) add(stem.slice(0, -1) + 'ie', pos, match);
        }
        if (/s$/.test(surface) && !/(ss|us|is)$/.test(surface)) {
            ['v', 'n'].forEach(function (pos) {
                var match = pos === 'v' ? 'regular_third_person' : 'regular_plural';
                if (!/(s|x|z|ch|sh|[^aeiou]y)$/.test(surface.slice(0, -1))) add(surface.slice(0, -1), pos, match);
                if (/(s|x|z|ch|sh|o)es$/.test(surface)) add(surface.slice(0, -2), pos, match);
                if (/zzes$/.test(surface)) add(surface.slice(0, -3), pos, match);
                if (/[^aeiou]ies$/.test(surface)) add(surface.slice(0, -3) + 'y', pos, match);
            });
        }
        suffix('ed', 'v', 'regular_ed_form');
        suffix('ing', 'v', 'regular_ing_form');
        suffix('er', 'j', 'regular_comparative');
        suffix('est', 'j', 'regular_superlative');
        return results;
    }

    function candidates(text, data) {
        var full = normalize(text);
        if (full.length > 500) return [];
        var tokens = Array.from(new Set(full.match(/[a-z]+(?:['-][a-z]+)*/g) || []));
        if (tokens.length > 32) return [];
        var surfaces = Array.from(new Set([full].concat(tokens)));
        var result = [];
        var seen = new Set();
        function add(surface, word, pos, rank, match, sourcePos) {
            var key = [surface, word, pos, match, sourcePos || pos].join('|');
            if (seen.has(key)) return;
            seen.add(key);
            result.push({ candidate_id: 'c' + (result.length + 1), surface: surface, word: word, pos: pos, rank: rank,
                match: match, source_pos: sourcePos || pos, scope: surface === full && full.includes(' ') ? 'phrase' : 'word' });
            if (word === 'saw' && pos === 'v') result[result.length - 1].usage = '仅指用锯切割；see的过去式禁止引用此候选';
        }
        surfaces.forEach(function (surface) {
            (data.words.get(surface) || []).forEach(function (row) { add(surface, surface, row[0], row[1], 'exact_word_pos'); });
            if (!/^[a-z]+$/.test(surface)) return;
            regularForms(surface).forEach(function (form) {
                (data.words.get(form.word) || []).forEach(function (row) {
                    if (row[0] === form.pos) add(surface, form.word, row[0], row[1], form.match);
                });
            });
            (data.relations[surface] || []).forEach(function (relation) {
                var sourcePos = relation[0];
                if (result.some(function (c) { return c.surface === surface && c.source_pos === sourcePos; })) return;
                var target = (data.words.get(relation[1]) || []).find(function (row) { return row[0] === relation[2]; });
                if (target) add(surface, relation[1], target[0], target[1], surface === relation[1] ? 'same_word_reference' : 'derivational_reference', sourcePos);
            });
        });
        return result.slice(0, 160);
    }

    function createContext(text, data) {
        return { namespace: 'r' + Date.now().toString(36) + (++sequence).toString(36), candidates: candidates(text, data) };
    }

    function prompt(context) {
        if (!context.candidates.length) return '';
        return '\n\n【本轮本地 COCA 候选，仅用于词汇详解中的可选括注】\n' +
            '保持原有释义、词源、搭配、语气和作品语境要求。先依据本句判断核心词及词性，再选择候选；有歧义就省略排名。' +
            '在第2部分首次详细介绍相应核心词及词性的句子中，插入 [[COCA:' + context.namespace + ':候选ID]]，播放器会替换为真实排名括注。' +
            '只能用本轮候选ID引用排名，不自行输出排名数字、freq或百分比，不解释内部标记。每个核心词最多引用一次；虚词仅在它就是学习对象时引用。' +
            '词组可解释多个核心词，但word作用域候选必须紧贴对应单词，绝不能称为整个词组的排名。' +
            'exact_word_pos仅在本句词性一致时优先；动词屈折变化可使用regular候选。running作形容词或名词时优先对应直接词条。' +
            '直接词条还必须符合本句词义；saw作为see的过去式时不引用saw/v。不还原不规则过去式或过去分词。' +
            'reference仅在source_pos符合本句、同词族语义明确且没有准确或规则候选时使用，全篇最多一个；有多个不确定选择就省略。' +
            '所有候选只是可选证据，未找到排名时直接继续解释，不提示未收录。历史轮次的标记不得复用。' +
            '选择和排除候选的过程不要写进回答；不要为了说明排名去讲其他义项、其他词性或解释为何省略。' +
            '排名信息不扩大解释范围：搭配只选当前义项；作品语境只依据给定字幕，不补造具体画面或后续剧情。\n' +
            '词性编码：' + JSON.stringify(posNames) + '\n' +
            JSON.stringify(context.candidates);
    }

    function label(candidate) {
        if (candidate.match === 'exact_word_pos') return '（' + candidate.word + '·' + posNames[candidate.pos] + '，COCA 排名第 **' + candidate.rank + '** 位）';
        if (candidate.match.indexOf('regular_') === 0) return '（原形 ' + candidate.word + '·' + posNames[candidate.pos] + '，COCA 排名第 **' + candidate.rank + '** 位）';
        return '（参考 ' + candidate.word + ' 的' + posNames[candidate.pos] + '，COCA 排名第 **' + candidate.rank + '** 位）';
    }

    function cleanRankClaims(text) {
        // Keep ID markers intact. Remove model-written COCA clauses (including partial
        // streamed numbers) before inserting trusted local labels. Ordinary AI replies
        // do not use this filter. Commas/decimal points within numbers are not boundaries.
        var cleaned = text.split(/(\[\[COCA:[\s\S]*?(?:\]\]|$))/gi).map(function (part) {
            if (/^\[\[COCA:/i.test(part)) return part;
            return part.replace(/[*_`]*(?:\bCOCA\b|(?:词频)?排名(?=\s*(?:第|为|是|[:：]|[0-9０-９一二三四五六七八九十百千万])))(?:[,，.](?=[0-9０-９])|[^\n，,。.;；!?！？()（）\[\]])*/gi, '');
        }).join('');
        if (cleaned === text) return text;
        return cleaned.replace(/（\s*）|\(\s*\)/g, '')
            .replace(/[,，]\s*(?=[,，。；;！？!?])/g, '').replace(/(^|\n)[ \t]*[,，][ \t]*/g, '$1');
    }

    function render(text, context) {
        if (context) text = cleanRankClaims(text);
        var prefix = '[[COCA:';
        var list = context ? context.candidates : [];
        var byId = new Map(list.map(function (c) { return [c.candidate_id, c]; }));
        var pattern = /\[\[COCA:[\s\S]*?(?:\]\]|$)/gi;
        var valid = [];
        text.replace(pattern, function (mark) {
            var match = /^\[\[COCA:([a-z0-9]+):(c\d+)\]\]$/.exec(mark);
            var candidate = match && context && match[1] === context.namespace && byId.get(match[2]);
            if (candidate) valid.push(candidate);
            return '';
        });
        var used = new Set();
        var fallbackUsed = false;
        var output = text.replace(pattern, function (mark) {
            var match = /^\[\[COCA:([a-z0-9]+):(c\d+)\]\]$/.exec(mark);
            var candidate = match && context && match[1] === context.namespace && byId.get(match[2]);
            if (!candidate || used.has(candidate.surface)) return '';
            if (candidate.match.indexOf('regular_') === 0 && list.some(function (c) {
                return c.surface === candidate.surface && c.pos === candidate.pos && c.match === 'exact_word_pos';
            })) return '';
            var fallback = candidate.match.endsWith('_reference');
            if (fallback && (fallbackUsed || list.some(function (c) {
                return c.surface === candidate.surface && c.source_pos === candidate.source_pos && !c.match.endsWith('_reference');
            }) || valid.some(function (c) { return c.surface === candidate.surface && !c.match.endsWith('_reference'); }))) return '';
            used.add(candidate.surface);
            if (fallback) fallbackUsed = true;
            return label(candidate);
        });
        // Hold any incomplete opening delimiter, including on stop/error/final renders.
        for (var length = prefix.length - 1; length >= (context ? 1 : 3); length--) {
            if (output.toUpperCase().endsWith(prefix.slice(0, length))) return output.slice(0, -length);
        }
        return output;
    }

    return { load: load, decode: decode, decodeRanks: decodeRanks, candidates: candidates,
        createContext: createContext, prompt: prompt, render: render };
});
