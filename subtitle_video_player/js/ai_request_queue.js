(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.SvpAiRequestQueue = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function create(options) {
        var pending = [], active = null, paused = '', editingId = null, failedId = null, serial = 0;

        function snapshot() {
            return { pending: pending.slice(), active: active, paused: paused, editingId: editingId, failedId: failedId };
        }

        function changed() {
            if (options.onChange) options.onChange(snapshot());
        }

        function start(entry) {
            active = entry;
            changed();
            options.onStart(entry);
        }

        function pump() {
            if (active || paused || !pending.length || pending[0].id === editingId) return;
            start(pending.shift());
        }

        function enqueue(value) {
            var entry = { id: ++serial, value: value };
            pending.push(entry);
            changed();
            pump();
            return entry;
        }

        function complete(id, status) {
            if (!active || active.id !== id) return false;
            var entry = active;
            active = null;
            if (paused === 'stopped') {
                paused = pending.length ? 'stopped' : '';
                failedId = null;
            } else if (status === 'error') {
                paused = pending.length ? 'error' : '';
                failedId = id;
            } else if (status === 'stopped') {
                paused = pending.length ? 'stopped' : '';
                failedId = null;
            } else if (entry.recoveryOf === failedId && paused === 'error') {
                paused = '';
                failedId = null;
            }
            if (!pending.length) { paused = ''; failedId = null; }
            changed();
            pump();
            return true;
        }

        function retry(value, id) {
            if (!active && paused === 'error' && failedId === id) {
                var entry = { id: ++serial, value: value, recoveryOf: id };
                start(entry);
                return entry;
            }
            return enqueue(value);
        }

        function pause() {
            paused = 'stopped';
            failedId = null;
            changed();
        }

        function resume() {
            paused = '';
            failedId = null;
            changed();
            pump();
        }

        function beginEdit(id) {
            if (editingId !== null || !pending.some(function (entry) { return entry.id === id; })) return false;
            editingId = id;
            changed();
            return true;
        }

        function saveEdit(id, value) {
            var entry = pending.find(function (item) { return item.id === id; });
            if (!entry || editingId !== id) return false;
            entry.value = value;
            editingId = null;
            changed();
            pump();
            return true;
        }

        function cancelEdit() {
            editingId = null;
            changed();
            pump();
        }

        function remove(id) {
            var index = pending.findIndex(function (entry) { return entry.id === id; });
            if (index < 0) return false;
            pending.splice(index, 1);
            if (editingId === id) editingId = null;
            if (!pending.length && !active) { paused = ''; failedId = null; }
            changed();
            pump();
            return true;
        }

        function move(id, direction) {
            if (editingId !== null) return false;
            var index = pending.findIndex(function (entry) { return entry.id === id; });
            var next = index + direction;
            if (index < 0 || next < 0 || next >= pending.length) return false;
            var entry = pending.splice(index, 1)[0];
            pending.splice(next, 0, entry);
            changed();
            pump();
            return true;
        }

        function clear() {
            pending = [];
            editingId = null;
            paused = '';
            failedId = null;
            changed();
        }

        function reset() {
            active = null;
            clear();
        }

        return { snapshot: snapshot, enqueue: enqueue, complete: complete, retry: retry, pause: pause, resume: resume,
            beginEdit: beginEdit, saveEdit: saveEdit, cancelEdit: cancelEdit, remove: remove, move: move, clear: clear, reset: reset };
    }

    return { create: create };
});
