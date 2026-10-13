// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { currentHospitalId, runInHospital, runWithoutHospital, tenantPlugin } from './tenant-context.js';

test('tenant plugin scopes normal reads, aggregates, and membership reads to the active hospital', async () => {
  const schema = new mongoose.Schema({ active: Boolean });
  schema.plugin(tenantPlugin);
  const model = mongoose.model(`TenantScopeTest${Date.now()}`, schema);
  await runInHospital('507f1f77bcf86cd799439011', async () => {
    const query = model.find({ active: true });
    await new Promise((resolve, reject) => schema.s.hooks.execPre('find', query, error => error ? reject(error) : resolve()));
    assert.equal(String(query.getFilter().hospitalId), '507f1f77bcf86cd799439011');
    const aggregate = model.aggregate([{ $group: { _id: null, count: { $sum: 1 } } }]);
    await new Promise((resolve, reject) => schema.s.hooks.execPre('aggregate', aggregate, error => error ? reject(error) : resolve()));
    assert.equal(String(aggregate.pipeline()[0].$match.hospitalId), '507f1f77bcf86cd799439011');
    const update = model.updateOne({ active: true }, { $set: { active: false } });
    await new Promise((resolve, reject) => schema.s.hooks.execPre('updateOne', update, error => error ? reject(error) : resolve()));
    assert.equal(String(update.getFilter().hospitalId), '507f1f77bcf86cd799439011');
    assert.equal(String(update.getUpdate().$setOnInsert.hospitalId), '507f1f77bcf86cd799439011');
    const remove = model.deleteMany({ active: false });
    await new Promise((resolve, reject) => schema.s.hooks.execPre('deleteMany', remove, error => error ? reject(error) : resolve()));
    assert.equal(String(remove.getFilter().hospitalId), '507f1f77bcf86cd799439011');
  });

  const memberSchema = new mongoose.Schema({ name: String, hospitalIds: [mongoose.Schema.Types.ObjectId] });
  memberSchema.plugin(tenantPlugin, { membership: true });
  const memberModel = mongoose.model(`TenantMemberTest${Date.now()}`, memberSchema);
  await runInHospital('507f1f77bcf86cd799439012', async () => {
    const query = memberModel.find({ active: true });
    await new Promise((resolve, reject) => memberSchema.s.hooks.execPre('find', query, error => error ? reject(error) : resolve()));
    assert.equal(String(query.getFilter().hospitalIds), '507f1f77bcf86cd799439012');
  });
});

test('trusted unscoped identity lookup is isolated and restores the active hospital context', async () => {
  await runInHospital('507f1f77bcf86cd799439013', async () => {
    assert.equal(currentHospitalId(), '507f1f77bcf86cd799439013');
    await runWithoutHospital(async () => assert.equal(currentHospitalId(), null));
    assert.equal(currentHospitalId(), '507f1f77bcf86cd799439013');
  });
});
