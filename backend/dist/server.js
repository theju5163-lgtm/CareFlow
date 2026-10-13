import 'dotenv/config';
import { connectDatabase } from './app.js';
import app from './app.js';
const port = Number(process.env.PORT || 4100);
const jwtSecret = process.env.JWT_SECRET || '';
if (jwtSecret.length < 32) {
    throw new Error('Set JWT_SECRET to a random value of at least 32 characters in backend/.env.');
}
const server = app.listen(port, () => console.log(`CareFlow API listening on http://localhost:${port}.`));
connectDatabase()
    .then(() => console.log('MongoDB connected to careflow_ai.'))
    .catch(error => console.error(`MongoDB is not ready: ${error.message}. API health remains available; data requests return 503.`));
server.on('error', error => {
    console.error(`CareFlow API could not listen on port ${port}: ${error.message}`);
    process.exitCode = 1;
});
//# sourceMappingURL=server.js.map