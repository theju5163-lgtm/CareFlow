import test from 'node:test';
import assert from 'node:assert/strict';
import { mapExotelStatus, normalizeIndiaNumber } from './services/exotel.js';
test('Indian phone normalization accepts 10-digit and +91 mobile numbers only', () => {
    assert.equal(normalizeIndiaNumber('98765 43210'), '+919876543210');
    assert.equal(normalizeIndiaNumber('+91 98765 43210'), '+919876543210');
    assert.equal(normalizeIndiaNumber('1234567890'), null);
    assert.equal(normalizeIndiaNumber('+14155550100'), null);
});
test('Exotel call states are normalized and unknown states never overwrite provider state', () => {
    assert.equal(mapExotelStatus('ringing'), 'Ringing');
    assert.equal(mapExotelStatus('in-progress'), 'In Progress');
    assert.equal(mapExotelStatus('completed'), 'Completed');
    assert.equal(mapExotelStatus('busy'), 'Busy');
    assert.equal(mapExotelStatus('no-answer'), 'No Answer');
    assert.equal(mapExotelStatus('failed'), 'Failed');
    assert.equal(mapExotelStatus('unknown'), null);
});
//# sourceMappingURL=exotel.test.js.map