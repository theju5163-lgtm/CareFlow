import test from 'node:test';
import assert from 'node:assert/strict';
import { can, roleMatchesAccountType, signAccessToken, validStatusTransition, verifyAccessToken } from './security.js';
test('role permissions grant staff workflow access but deny admin-only management', () => {
    assert.equal(can('staff', 'call:write'), true);
    assert.equal(can('staff', 'user:manage'), false);
    assert.equal(can('patient', 'patient:portal:read'), true);
    assert.equal(can('patient', 'patient:read'), false);
    assert.equal(can('admin', 'user:manage'), true);
    assert.equal(can('unknown', 'call:read'), false);
});
test('selected login account type must match hospital membership role', () => {
    assert.equal(roleMatchesAccountType('patient', 'patient'), true);
    assert.equal(roleMatchesAccountType('admin', 'admin'), true);
    assert.equal(roleMatchesAccountType('appointment_coordinator', 'staff'), true);
    assert.equal(roleMatchesAccountType('patient', 'staff'), false);
    assert.equal(roleMatchesAccountType('staff', 'admin'), false);
});
test('task state machine accepts workflow moves and rejects terminal-state reopening', () => {
    assert.equal(validStatusTransition('Pending', 'In Progress'), true);
    assert.equal(validStatusTransition('In Progress', 'Completed'), true);
    assert.equal(validStatusTransition('Completed', 'Pending'), false);
    assert.equal(validStatusTransition('Draft', 'Completed'), false);
});
test('access tokens include the user role and reject the wrong secret', () => {
    const secret = 'unit-test-secret-with-more-than-32-characters';
    const token = signAccessToken({ _id: 'abc123', role: 'staff', email: 'staff@example.test' }, secret, '5m');
    assert.equal(verifyAccessToken(token, secret).role, 'staff');
    assert.throws(() => verifyAccessToken(token, `${secret}-bad`));
});
//# sourceMappingURL=security.test.js.map