// Mongoose's hook overloads do not carry schema generics through regular expressions.
// @ts-nocheck
import { AsyncLocalStorage } from 'node:async_hooks';
import mongoose from 'mongoose';

const tenantStorage = new AsyncLocalStorage<string | null>();

export function runInHospital<T>(hospitalId: string, callback: () => T): T {
  return tenantStorage.run(hospitalId, callback);
}

export function currentHospitalId(): string | undefined {
  return tenantStorage.getStore();
}

/** Reserved for trusted identity and control-plane lookups only. */
export function runWithoutHospital<T>(callback: () => T): T {
  return tenantStorage.run(null, callback);
}

/** Adds a tenant predicate to every scoped read, aggregate and update. */
export function tenantPlugin(schema: mongoose.Schema, options: { membership?: boolean } = {}) {
  schema.add({ hospitalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Hospital', index: true } });
  schema.pre(/^find/, function () {
    const hospitalId = currentHospitalId();
    if (!hospitalId) return;
    this.where(options.membership ? { hospitalIds: hospitalId } : { hospitalId });
  });
  schema.pre('countDocuments', function () {
    const hospitalId = currentHospitalId();
    if (hospitalId) this.where(options.membership ? { hospitalIds: hospitalId } : { hospitalId });
  });
  schema.pre('distinct', function () {
    const hospitalId = currentHospitalId();
    if (hospitalId) this.where(options.membership ? { hospitalIds: hospitalId } : { hospitalId });
  });
  schema.pre(/^delete/, function () {
    const hospitalId = currentHospitalId();
    if (!hospitalId) return;
    this.where(options.membership ? { hospitalIds: hospitalId } : { hospitalId });
  });
  schema.pre(/^(update|replace)/, function () {
    const hospitalId = currentHospitalId();
    if (!hospitalId) return;
    const update = this.getUpdate() || {};
    this.where(options.membership ? { hospitalIds: hospitalId } : { hospitalId });
    this.setUpdate({
      ...update,
      ...(options.membership ? { $addToSet: { ...(update.$addToSet || {}), hospitalIds: hospitalId } } : {}),
      $setOnInsert: { ...(update.$setOnInsert || {}), hospitalId }
    });
  });
  schema.pre('insertMany', function (next, documents) {
    const hospitalId = currentHospitalId();
    if (hospitalId) for (const doc of documents) {
      doc.hospitalId ??= hospitalId;
      if (options.membership) doc.hospitalIds = [...new Set([...(doc.hospitalIds || []).map(String), hospitalId])];
    }
    next();
  });
  schema.pre('aggregate', function () {
    const hospitalId = currentHospitalId();
    if (hospitalId) this.pipeline().unshift({ $match: options.membership ? { hospitalIds: new mongoose.Types.ObjectId(hospitalId) } : { hospitalId: new mongoose.Types.ObjectId(hospitalId) } });
  });
  schema.pre('save', function () {
    const hospitalId = currentHospitalId();
    if (!hospitalId) return;
    if (options.membership) {
      this.hospitalId ??= hospitalId;
      const memberships = (this.hospitalIds || []).map(String);
      if (!memberships.includes(hospitalId)) this.hospitalIds = [...(this.hospitalIds || []), hospitalId];
    } else this.hospitalId ??= hospitalId;
  });
}
