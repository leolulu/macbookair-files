const test = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('../js/ai_request_queue');

function fixture() {
    const starts = [];
    const queue = create({ onStart: entry => starts.push(entry) });
    return { queue, starts };
}

test('runs FIFO with only one active request', () => {
    const { queue, starts } = fixture();
    const a = queue.enqueue('a'), b = queue.enqueue('b'), c = queue.enqueue('c');
    assert.deepEqual(starts.map(item => item.value), ['a']);
    queue.complete(a.id, 'success'); queue.complete(b.id, 'success'); queue.complete(c.id, 'success');
    assert.deepEqual(starts.map(item => item.value), ['a', 'b', 'c']);
    assert.equal(queue.snapshot().active, null);
});

test('failure preserves waiting work and only retry of that failure resumes it', () => {
    const { queue, starts } = fixture();
    const a = queue.enqueue('a'); queue.enqueue('b');
    queue.complete(a.id, 'error');
    assert.equal(queue.snapshot().paused, 'error');
    queue.retry('unrelated retry', -1);
    assert.equal(starts.length, 1);
    const retry = queue.retry('retry a', a.id);
    queue.complete(retry.id, 'success');
    assert.deepEqual(starts.map(item => item.value), ['a', 'retry a', 'b']);
    assert.equal(queue.snapshot().paused, '');
});

test('failed recovery remains paused and a second recovery can continue', () => {
    const { queue, starts } = fixture();
    const a = queue.enqueue('a'); queue.enqueue('b'); queue.complete(a.id, 'error');
    const retry = queue.retry('retry', a.id); queue.complete(retry.id, 'error');
    assert.equal(queue.snapshot().paused, 'error');
    const next = queue.retry('retry again', retry.id); queue.complete(next.id, 'success');
    assert.equal(starts.at(-1).value, 'b');
});

test('manual stop wins over a success racing with abort and requires explicit resume', () => {
    const { queue, starts } = fixture();
    const a = queue.enqueue('a'); queue.enqueue('b'); queue.pause(); queue.complete(a.id, 'success');
    queue.enqueue('c'); assert.equal(starts.length, 1);
    assert.equal(queue.snapshot().paused, 'stopped');
    queue.resume(); assert.equal(starts.at(-1).value, 'b');
});

test('manual stop wins over a racing failure and its retry cannot auto-resume the queue', () => {
    const { queue, starts } = fixture();
    const a = queue.enqueue('a'); queue.enqueue('b'); queue.pause(); queue.complete(a.id, 'error');
    assert.equal(queue.snapshot().paused, 'stopped');
    queue.retry('retry a', a.id); assert.equal(starts.length, 1);
    queue.resume(); assert.equal(starts.at(-1).value, 'b');
});

test('editing head waits for save without skipping order; editing later items permits earlier work', () => {
    const { queue, starts } = fixture();
    const a = queue.enqueue('a'), b = queue.enqueue('b'), c = queue.enqueue('c');
    assert.equal(queue.beginEdit(c.id), true); queue.complete(a.id, 'success');
    assert.equal(starts.at(-1).id, b.id); queue.complete(b.id, 'success');
    assert.equal(queue.snapshot().active, null);
    assert.equal(queue.beginEdit(b.id), false);
    queue.saveEdit(c.id, 'edited c'); assert.equal(starts.at(-1).value, 'edited c');
});

test('cancel edit restores delivery and removing edited item starts the next one', () => {
    const { queue, starts } = fixture();
    const a = queue.enqueue('a'), b = queue.enqueue('b'), c = queue.enqueue('c');
    queue.beginEdit(b.id); queue.complete(a.id, 'success'); queue.cancelEdit();
    assert.equal(starts.at(-1).id, b.id);
    queue.beginEdit(c.id); queue.complete(b.id, 'success'); queue.remove(c.id);
    const d = queue.enqueue('d'); assert.equal(starts.at(-1).id, d.id);
});

test('reordering and cancelling affect only pending requests; clearing never stops active work', () => {
    const { queue, starts } = fixture();
    const a = queue.enqueue('a'), b = queue.enqueue('b'), c = queue.enqueue('c');
    assert.equal(queue.move(a.id, 1), false); queue.move(c.id, -1); queue.remove(b.id);
    assert.deepEqual(queue.snapshot().pending.map(item => item.value), ['c']);
    queue.clear(); assert.equal(queue.snapshot().active.id, a.id);
    queue.complete(a.id, 'success'); assert.equal(starts.length, 1);
});

test('reset rejects stale completions and keeps request IDs unique', () => {
    const { queue, starts } = fixture();
    const old = queue.enqueue('old'); queue.enqueue('old pending'); queue.reset();
    const current = queue.enqueue('current');
    assert.notEqual(current.id, old.id); assert.equal(queue.complete(old.id, 'error'), false);
    assert.equal(queue.snapshot().active.id, current.id); assert.equal(queue.snapshot().paused, '');
    assert.equal(starts.length, 2);
});

test('stopping or failing with no waiting work does not strand future submissions', () => {
    for (const status of ['error', 'stopped']) {
        const { queue, starts } = fixture();
        const a = queue.enqueue('a'); queue.pause(); queue.complete(a.id, status);
        queue.enqueue('b'); assert.equal(starts.at(-1).value, 'b');
    }
});
