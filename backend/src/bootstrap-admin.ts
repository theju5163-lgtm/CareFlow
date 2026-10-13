// @ts-nocheck
import 'dotenv/config';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Hospital, HospitalMembership, User } from './models.js';
import { connectToCareFlowDatabase } from './config/database.js';
import { runWithoutHospital } from './tenant-context.js';

const args = new Set(process.argv.slice(2));
const emailArg = process.argv.slice(2).find((arg, index, values) => values[index - 1] === '--email');
const emailPattern = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function readHidden(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Run this command in an interactive terminal so the password can be entered without echo.');
  }
  return new Promise((resolve, reject) => {
    let value = '';
    stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdout.write('\n');
    };
    const onData = chunk => {
      for (const character of String(chunk)) {
        if (character === '\u0003') {
          cleanup();
          reject(new Error('Cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          cleanup();
          resolve(value);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (character >= ' ' && character <= '~') {
          value += character;
          stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

let password = '';
let terminal;
try {
  terminal = createInterface({ input: stdin, output: stdout });
  let email = emailArg || (await terminal.question('Administrator email: ')).trim().toLowerCase();
  let name = '';
  if (!emailPattern.test(email)) throw new Error('Enter a valid administrator email address with --email or at the prompt.');
  await connectToCareFlowDatabase(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/careflow_ai');
  const existing = await runWithoutHospital(() => User.findOne({ email }).select('name role active hospitalId hospitalIds'));
  if (existing && !args.has('--reset-existing')) {
    throw new Error('An account already exists for this email. Use --reset-existing only when you intend to rotate this administrator password.');
  }
  if (existing && existing.role !== 'admin') throw new Error('The existing account is not an administrator; refusing to change its password.');
  if (existing && !existing.active) throw new Error('The administrator account is inactive; contact a hospital administrator to restore access.');
  if (!existing) {
    name = (await terminal.question('Administrator name: ')).trim();
    if (!name || name.length > 120) throw new Error('Administrator name is required and must be at most 120 characters.');
  }
  terminal.close();
  const suppliedPassword = process.env.CARE_FLOW_BOOTSTRAP_PASSWORD;
  const suppliedConfirmation = process.env.CARE_FLOW_BOOTSTRAP_PASSWORD_CONFIRM;
  delete process.env.CARE_FLOW_BOOTSTRAP_PASSWORD;
  delete process.env.CARE_FLOW_BOOTSTRAP_PASSWORD_CONFIRM;
  if (suppliedPassword !== undefined || suppliedConfirmation !== undefined) {
    if (suppliedPassword === undefined || suppliedConfirmation === undefined) throw new Error('Both temporary CARE_FLOW_BOOTSTRAP_PASSWORD variables are required when using environment input.');
    password = suppliedPassword;
  } else {
    password = await readHidden('New password (12+ characters): ');
  }
  const confirmation = suppliedConfirmation ?? await readHidden('Confirm new password: ');
  if (password.length < 12 || password.length > 200) throw new Error('Password must be between 12 and 200 characters.');
  if (password !== confirmation) throw new Error('Passwords do not match. Nothing was changed.');

  const passwordHash = await bcrypt.hash(password, 12);
  if (existing) {
    existing.passwordHash = passwordHash;
    await runWithoutHospital(() => existing.save());
    console.log(`Administrator password updated for ${email}. The password was saved only as a bcrypt hash.`);
  } else {
    let hospital = await runWithoutHospital(() => Hospital.findOne({ slug: 'careflow-demo' }));
    if (!hospital) hospital = await Hospital.create({ name: process.env.DEFAULT_HOSPITAL_NAME || 'CareFlow Demonstration Hospital', slug: 'careflow-demo', city: 'Mysuru', state: 'Karnataka', currency: 'INR', timeZone: 'Asia/Kolkata', status: 'active' });
    const admin = await User.create({ name, email, role: 'admin', active: true, hospitalId: hospital._id, hospitalIds: [hospital._id], passwordHash });
    await HospitalMembership.updateOne({ hospitalId: hospital._id, userId: admin._id }, { $setOnInsert: { role: 'admin', active: true } }, { upsert: true });
    if (!hospital.createdBy) { hospital.createdBy = admin._id; await hospital.save(); }
    console.log(`Administrator ${email} created for ${hospital.name}. The password was saved only as a bcrypt hash.`);
  }

  if (args.has('--verify-api')) {
    const response = await fetch(process.env.ADMIN_LOGIN_TEST_URL || 'http://127.0.0.1:4100/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password })
    });
    const result = await response.json().catch(() => ({}));
    const verified = response.ok && Boolean(result.token) && result.user?.role === 'admin';
    console.log(`Login endpoint verification: HTTP ${response.status}; ${verified ? 'administrator sign-in succeeded.' : `administrator sign-in did not succeed${result.error ? ` (${result.error})` : ''}.`}`);
    if (!verified) process.exitCode = 1;
  }
} catch (error) {
  console.error(`Administrator bootstrap failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  terminal?.close();
  password = '';
  await mongoose.disconnect().catch(() => {});
}
