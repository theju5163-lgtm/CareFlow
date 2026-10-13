import { timingSafeEqual } from 'node:crypto';
export function normalizeIndiaNumber(value) {
    if (typeof value !== 'string')
        return null;
    const compact = value.trim().replace(/[\s()-]/g, '');
    const e164 = /^\d{10}$/.test(compact) ? `+91${compact}` : compact;
    return /^\+91[6-9]\d{9}$/.test(e164) ? e164 : null;
}
export function exotelConfiguration() {
    const { EXOTEL_API_KEY, EXOTEL_API_TOKEN, EXOTEL_ACCOUNT_SID, EXOTEL_CALLER_ID, EXOTEL_PUBLIC_BASE_URL, EXOTEL_WEBHOOK_TOKEN } = process.env;
    const baseUrl = (process.env.EXOTEL_BASE_URL || 'https://api.in.exotel.com').replace(/\/$/, '');
    let apiHost = '';
    try {
        const parsed = new URL(baseUrl);
        if (parsed.protocol === 'https:')
            apiHost = parsed.hostname;
    }
    catch { /* invalid configuration */ }
    let publicOrigin = '';
    try {
        const parsed = new URL(EXOTEL_PUBLIC_BASE_URL || '');
        if (parsed.protocol === 'https:' && parsed.pathname === '/' && !parsed.search && !parsed.hash && !parsed.username && !parsed.password)
            publicOrigin = parsed.origin;
    }
    catch { /* invalid configuration */ }
    if (process.env.TELEPHONY_PROVIDER && process.env.TELEPHONY_PROVIDER !== 'exotel')
        return null;
    if (!EXOTEL_API_KEY || !EXOTEL_API_TOKEN || !EXOTEL_ACCOUNT_SID || !EXOTEL_CALLER_ID || !EXOTEL_PUBLIC_BASE_URL || !EXOTEL_WEBHOOK_TOKEN || EXOTEL_WEBHOOK_TOKEN.length < 32)
        return null;
    if ([EXOTEL_API_KEY, EXOTEL_API_TOKEN, EXOTEL_ACCOUNT_SID, EXOTEL_CALLER_ID, EXOTEL_WEBHOOK_TOKEN].some(value => /^(replace-|your-)|example/i.test(value)))
        return null;
    if (new URL(publicOrigin || 'https://invalid').hostname.endsWith('.example'))
        return null;
    if (!['api.in.exotel.com', 'api.exotel.com'].includes(apiHost))
        return null;
    if (!publicOrigin)
        return null;
    return { apiKey: EXOTEL_API_KEY, apiToken: EXOTEL_API_TOKEN, accountSid: EXOTEL_ACCOUNT_SID, callerId: EXOTEL_CALLER_ID, publicBaseUrl: publicOrigin, webhookToken: EXOTEL_WEBHOOK_TOKEN, baseUrl };
}
async function exotelRequest(path, init = {}) {
    const config = exotelConfiguration();
    if (!config)
        throw new Error('Exotel is not configured. Set its backend credentials, caller ID, HTTPS public URL and webhook token.');
    const response = await fetch(`${config.baseUrl}/v1/Accounts/${encodeURIComponent(config.accountSid)}${path}`, {
        ...init,
        headers: { Authorization: `Basic ${Buffer.from(`${config.apiKey}:${config.apiToken}`).toString('base64')}`, ...(init.headers || {}) },
        signal: AbortSignal.timeout(20_000)
    });
    const text = await response.text();
    let data;
    try {
        data = JSON.parse(text);
    }
    catch {
        data = {};
    }
    if (!response.ok)
        throw new Error(`Exotel request failed (${response.status}): ${String(data?.RestException?.Message || data?.message || 'provider rejected the request').slice(0, 300)}`);
    return data;
}
export function exotelCallbackUrl(callId) {
    const config = exotelConfiguration();
    if (!config)
        throw new Error('Exotel is not configured.');
    return `${config.publicBaseUrl}/api/webhooks/exotel/${encodeURIComponent(config.webhookToken)}/${encodeURIComponent(callId)}`;
}
export async function initiateExotelCall({ staffPhone, patientPhone, callId, record }) {
    const config = exotelConfiguration();
    if (!config)
        throw new Error('Exotel is not configured.');
    const form = new URLSearchParams({ From: staffPhone, To: patientPhone, CallerId: config.callerId, CallType: 'trans', TimeLimit: '3600', TimeOut: '30', Record: String(record), CustomField: callId, StatusCallback: exotelCallbackUrl(callId), StatusCallbackContentType: 'application/json' });
    form.append('StatusCallbackEvents[]', 'answered');
    form.append('StatusCallbackEvents[]', 'terminal');
    const data = await exotelRequest(`/Calls/connect.json`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    const call = data?.Call;
    if (!call?.Sid)
        throw new Error('Exotel did not return a call identifier. The provider response was not treated as a connected call.');
    return { sid: String(call.Sid), providerStatus: String(call.Status || 'queued') };
}
export async function endExotelCall(callSid) {
    const data = await exotelRequest(`/Calls/${encodeURIComponent(callSid)}/ActiveLegs.json`);
    const legs = data?.Legs || data?.legs || [];
    const active = legs.filter((leg) => ['in-progress', 'in progress', 'ringing', 'queued'].includes(String(leg.Status || leg.status || '').toLowerCase()));
    if (!active.length)
        throw new Error('Exotel reports no active call legs to end. Wait for the latest status callback and refresh.');
    for (const leg of active) {
        const legSid = leg.Sid || leg.sid;
        if (!legSid)
            continue;
        const form = new URLSearchParams({ Action: 'hangup' });
        await exotelRequest(`/Calls/${encodeURIComponent(callSid)}/Legs/${encodeURIComponent(String(legSid))}.json`, { method: 'PUT', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    }
}
export async function getExotelCallStatus(callSid) {
    const data = await exotelRequest(`/Calls/${encodeURIComponent(callSid)}.json`);
    const call = data?.Call;
    if (!call?.Sid)
        throw new Error('Exotel did not return call details for this call ID.');
    return { sid: String(call.Sid), status: String(call.Status || ''), durationSeconds: call.Duration == null ? null : Number(call.Duration) };
}
export function mapExotelStatus(input) {
    const s = String(input || '').toLowerCase().replace(/_/g, '-');
    if (!s)
        return null;
    if (['ringing', 'queued', 'initiating'].includes(s))
        return s === 'ringing' ? 'Ringing' : 'Initiating';
    if (['in-progress', 'in progress', 'answered', 'connected'].includes(s))
        return 'In Progress';
    if (s === 'completed')
        return 'Completed';
    if (s === 'busy')
        return 'Busy';
    if (['no-answer', 'no answer'].includes(s))
        return 'No Answer';
    if (['failed', 'canceled', 'cancelled'].includes(s))
        return 'Failed';
    return null;
}
export function validExotelWebhookToken(received) {
    const config = exotelConfiguration();
    if (!config || typeof received !== 'string')
        return false;
    const expected = Buffer.from(config.webhookToken);
    const actual = Buffer.from(received);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}
//# sourceMappingURL=exotel.js.map