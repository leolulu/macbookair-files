const reduced = require('./sentence_analysis');
const reference = require('./readfrog-1.52.1.json');

function testCase(id, cues, selection, expect, forbidden = []) {
    return { id, cues, source: cues.join(' '), selection, expect, forbidden };
}

const reducedFearing = 'fearing that the plan, if implemented hastily, would undermine public trust';
const reducedObjectClause = 'that the plan, if implemented hastily, would undermine public trust';
const referenceCiting = 'citing concerns that the proposal, if implemented hastily, could undermine public trust';
const referenceAppositive = 'that the proposal, if implemented hastily, could undermine public trust';

module.exports = [
    testCase('reduced-clause', [
        'The committee rejected the proposal submitted yesterday,',
        'fearing that the plan, if implemented hastily, would undermine public trust.'
    ], 'submitted', [
        { text: 'submitted yesterday', type: 'attributive', form: 'past-participle', head: 'proposal' },
        { text: reducedFearing, type: 'adverbial', form: 'present-participle', sense: 'cause' },
        { text: reducedObjectClause, type: 'object', form: 'clause', head: 'fearing' },
        { text: 'if implemented hastily', type: 'adverbial', form: 'clause', sense: 'condition', obstacle: 'ellipsis', restoreIncludes: 'the plan' },
        { text: 'if', type: 'connector' },
        { text: 'implemented', type: 'predicate', obstacle: 'passive' },
        { text: 'would undermine', type: 'predicate' },
        { text: 'public trust', type: 'object' }
    ]),
    testCase('nested-relatives', [
        'The report that the committee published last week, which surprised many readers, was never discussed in public.'
    ], 'report', [
        { text: 'that the committee published last week', type: 'attributive', form: 'clause', head: 'report' },
        { text: 'that', type: 'connector' },
        { text: 'published', type: 'predicate' },
        { text: 'which surprised many readers', type: 'attributive', form: 'clause', head: 'report', obstacle: 'parenthesis' },
        { text: 'which', type: 'connector' },
        { text: 'surprised', type: 'predicate' },
        { text: 'was never discussed', type: 'predicate', obstacle: 'passive' }
    ]),
    testCase('nonfinite-and-time', [
        'Exhausted by the long journey, the travelers decided to rest as soon as they arrived.'
    ], 'Exhausted', [
        { text: 'Exhausted by the long journey', type: 'adverbial', form: 'past-participle', sense: 'cause' },
        { text: 'the travelers', type: 'subject' },
        { text: 'decided', type: 'predicate' },
        { text: 'to rest', type: 'object', form: 'infinitive' },
        { text: 'as soon as they arrived', type: 'adverbial', form: 'clause', sense: 'time' },
        { text: 'as soon as', type: 'connector' },
        { text: 'arrived', type: 'predicate' }
    ]),
    testCase('inversion-and-split', [
        'Only then did she turn the offer down, fearing it was a trap.'
    ], 'Only', [
        { text: 'Only then', type: 'adverbial', obstacle: 'fronting' },
        { text: 'did', type: 'predicate', obstacle: 'inversion' },
        { text: 'she', type: 'subject' },
        { text: 'turn', type: 'predicate', obstacle: 'split' },
        { text: 'down', type: 'predicate', obstacle: 'split' },
        { text: 'fearing it was a trap', type: 'adverbial', form: 'present-participle', sense: 'cause' },
        { text: 'it was a trap', type: 'object', form: 'clause', head: 'fearing', obstacle: 'ellipsis' },
        { text: 'was', type: 'predicate' },
        { text: 'a trap', type: 'complement' }
    ]),
    testCase('readfrog-reference', [reference.source], 'citing', [
        { text: 'which was expected last week', type: 'attributive', form: 'clause', head: 'decision' },
        { text: 'was expected', type: 'predicate', obstacle: 'passive' },
        { text: referenceCiting, type: 'adverbial', form: 'present-participle', sense: 'cause' },
        { anyOf: [
            { text: 'concerns', type: 'object' },
            { text: 'concerns ' + referenceAppositive, type: 'object' }
        ] },
        { text: referenceAppositive, type: 'appositive', form: 'clause', head: 'concerns' },
        { text: 'if implemented hastily', type: 'adverbial', form: 'clause', sense: 'condition', obstacle: 'ellipsis', restoreIncludes: 'the proposal' },
        { text: 'if', type: 'connector' },
        { text: 'implemented', type: 'predicate', obstacle: 'passive' },
        { text: 'could undermine', type: 'predicate' },
        { text: 'public trust', type: 'object' }
    ]),
    testCase('question-split-predicate', [
        'Why would you try to hole up in a forward position?'
    ], 'try', [
        { text: 'Why', type: 'adverbial' },
        { text: 'would', type: 'predicate', obstacle: 'inversion' },
        { text: 'you', type: 'subject' },
        { text: 'try', type: 'predicate', obstacle: 'split' },
        {
            anyOf: [
                { text: 'to hole up', type: 'object', form: 'infinitive' },
                { text: 'to hole up in a forward position', type: 'object', form: 'infinitive' }
            ]
        },
        { text: 'in a forward position', type: 'adverbial' }
    ]),
    testCase('phrasal-verb', [
        'She knocked it out of the sky?'
    ], 'knocked', [
        { text: 'She', type: 'subject' },
        { text: 'knocked', type: 'predicate' },
        { text: 'it', type: 'object' },
        { anyOf: [
            { text: 'out', type: 'predicate', obstacle: 'split' },
            { text: 'out of the sky', type: 'adverbial', sense: 'place' }
        ] }
    ]),
    testCase('gerund-subject', [
        'Reading long sentences every day improves your comprehension.'
    ], 'Reading', [
        { text: 'Reading long sentences every day', type: 'subject', form: 'gerund' },
        { text: 'improves', type: 'predicate' },
        { text: 'your comprehension', type: 'object' }
    ]),
    testCase('concession-place-purpose', [
        'Although the library was crowded, the students stayed where it was quietest so that they could finish their research.'
    ], 'Although', [
        { text: 'Although the library was crowded', type: 'adverbial', form: 'clause', sense: 'concession' },
        { text: 'Although', type: 'connector' },
        { text: 'the library', type: 'subject' },
        { anyOf: [
            { text: 'was', type: 'predicate' },
            { text: 'was crowded', type: 'predicate' }
        ] },
        { anyOf: [
            { text: 'crowded', type: 'complement' },
            { text: 'was crowded', type: 'predicate' }
        ] },
        { text: 'the students', type: 'subject' },
        { text: 'stayed', type: 'predicate' },
        { text: 'where it was quietest', type: 'adverbial', form: 'clause', sense: 'place' },
        { text: 'where', type: 'connector' },
        { text: 'so that they could finish their research', type: 'adverbial', form: 'clause', sense: 'purpose' },
        { text: 'so that', type: 'connector' },
        { text: 'could finish', type: 'predicate' },
        { text: 'their research', type: 'object' }
    ]),
    testCase('result-manner', [
        'The guide explained the route so clearly that the hikers followed his instructions in single file.'
    ], 'clearly', [
        { text: 'The guide', type: 'subject' },
        { text: 'explained', type: 'predicate' },
        { text: 'the route', type: 'object' },
        { text: 'that the hikers followed his instructions in single file', type: 'adverbial', form: 'clause', sense: 'result' },
        { text: 'that', type: 'connector' },
        { text: 'the hikers', type: 'subject' },
        { text: 'followed', type: 'predicate' },
        { text: 'his instructions', type: 'object' },
        { text: 'in single file', type: 'adverbial', sense: 'manner' }
    ]),
    testCase('comparison', [
        'She is taller than her brother.'
    ], 'taller', [
        { text: 'She', type: 'subject' },
        { text: 'is', type: 'predicate' },
        { anyOf: [
            { text: 'taller', type: 'complement', obstacle: 'comparison' },
            { text: 'taller than her brother', type: 'complement', obstacle: 'comparison' }
        ] },
        { text: 'than her brother', type: 'adverbial', sense: 'comparison' }
    ]),
    testCase('subjunctive', [
        'If I were you, I would take the offer.'
    ], 'were', [
        { text: 'If I were you', type: 'adverbial', form: 'clause', sense: 'condition' },
        { text: 'If', type: 'connector' },
        { text: 'were', type: 'predicate', obstacle: 'subjunctive' },
        { text: 'would take', type: 'predicate' },
        { text: 'the offer', type: 'object' }
    ]),
    testCase('dummy-postponed-subject', [
        'It is believed that the scheme will work.'
    ], 'It', [
        { text: 'It', type: 'subject', obstacle: 'dummy-it' },
        { text: 'is believed', type: 'predicate', obstacle: 'passive' },
        { text: 'that the scheme will work', type: 'subject', form: 'clause', obstacle: 'postponed-subject' },
        { text: 'that', type: 'connector' },
        { text: 'the scheme', type: 'subject' },
        { text: 'will work', type: 'predicate' }
    ]),
    testCase('cleft-negation', [
        'It was the committee that did not approve the plan.'
    ], 'committee', [
        { text: 'the committee', type: 'subject', obstacle: 'cleft', restoreIncludes: 'committee' },
        { text: 'did not approve', type: 'predicate', obstacle: 'negation' },
        { text: 'the plan', type: 'object' }
    ], [
        { text: 'It was' },
        { text: 'that', type: 'connector' }
    ]),
    testCase('idiom', [
        'The project is a piece of cake.'
    ], 'piece', [
        { text: 'The project', type: 'subject' },
        { text: 'is', type: 'predicate' },
        { text: 'a piece of cake', type: 'complement', obstacle: 'idiom' }
    ])
];

if (module.exports[0].source !== reduced.source) throw Error('Reduced-clause acceptance source drifted from the browser fixture.');
