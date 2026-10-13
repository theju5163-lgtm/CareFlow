import test from 'node:test';
import assert from 'node:assert/strict';
import { Department, HospitalMembership } from './models.js';

test('staff profile metadata reuses hospital memberships and links managers by membership id', () => {
  for (const field of ['employeeId', 'jobTitle', 'phone', 'departmentId', 'role', 'active']) {
    assert.ok(HospitalMembership.schema.path(field), `membership field ${field} exists`);
  }
  assert.equal(Department.schema.path('managerStaffId').options.ref, 'HospitalMembership');
  assert.equal(Department.schema.path('code').options.uppercase, true);
});

test('employee IDs and department codes have hospital-scoped unique partial indexes', () => {
  const membershipIndex = HospitalMembership.schema.indexes().find(([keys]) => keys.employeeId === 1);
  const departmentIndex = Department.schema.indexes().find(([keys]) => keys.code === 1);
  assert.equal(membershipIndex?.[1]?.unique, true);
  assert.deepEqual(membershipIndex?.[0], { hospitalId: 1, employeeId: 1 });
  assert.equal(departmentIndex?.[1]?.unique, true);
  assert.deepEqual(departmentIndex?.[0], { code: 1, isDemo: 1, hospitalId: 1 });
});
