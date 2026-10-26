const source = 'The committee rejected the proposal submitted yesterday, fearing that the plan, if implemented hastily, would undermine public trust.';
const annotations = [
    { text: 'The committee', type: 'subject' },
    { text: 'rejected', type: 'predicate', tense: '一般过去时' },
    { text: 'the proposal submitted yesterday', type: 'object' },
    { text: 'submitted yesterday', type: 'attributive', form: 'past-participle', head: 'proposal', uncertain: false, restore: 'that was submitted yesterday', note: '说明是哪份提案；提案是被提交的对象。' },
    { text: 'fearing that the plan, if implemented hastily, would undermine public trust', type: 'adverbial', form: 'present-participle', sense: 'cause', head: 'committee', uncertain: false, note: '担忧的主体是委员会，说明否决的原因。' },
    { text: 'that the plan, if implemented hastily, would undermine public trust', type: 'object', form: 'clause', head: 'fearing', uncertain: false },
    { text: 'that', type: 'connector' },
    { text: 'the plan', type: 'subject' },
    { text: 'if implemented hastily', type: 'adverbial', form: 'clause', sense: 'condition', obstacle: 'ellipsis', restore: 'if the plan was implemented hastily' },
    { text: 'if', type: 'connector' },
    { text: 'implemented', type: 'predicate', obstacle: 'passive' },
    { text: 'would undermine', type: 'predicate' },
    { text: 'public trust', type: 'object' }
];
module.exports = { source, annotations, translation: '委员会否决了昨天提交的提案，担心该计划如果仓促实施，会损害公众信任。', issues: [] };
