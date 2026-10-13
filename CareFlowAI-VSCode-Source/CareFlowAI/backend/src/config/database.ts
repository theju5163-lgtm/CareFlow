import mongoose from 'mongoose';

export async function connectToCareFlowDatabase(uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/careflow_ai') {
  await mongoose.connect(uri, { dbName: 'careflow_ai', serverSelectionTimeoutMS: 5000 });
  return mongoose.connection;
}

export function databaseReady() { return mongoose.connection.readyState === 1; }
