/**
 * Execute-level failure behaviour: one failure per item, never a retry, never
 * a fabricated binary, and never a leaked secret.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
	PNG_B64,
	SECRET_KEY,
	SECRET_TARGET_TOKEN,
	appErrorEnvelope,
	createExecuteContext,
	fullResponse,
	loadDist,
	serializeError,
} from './helpers.mjs';

const { SiteShot } = loadDist('nodes/SiteShot/SiteShot.node.js');

function run(ctx) {
	return new SiteShot().execute.call(ctx);
}

const baseParams = { url: 'https://example.com/', binaryPropertyName: 'data' };

/** Run and return the thrown error, asserting that something was thrown. */
async function capture(ctx) {
	try {
		await run(ctx);
	} catch (err) {
		return err;
	}
	throw new assert.AssertionError({ message: 'expected execute() to throw, but it resolved' });
}

// ---------------------------------------------------------------------------
// Nothing reaches the API until the input is valid
// ---------------------------------------------------------------------------

test('an invalid URL fails before any request is made, so no quota is spent', async () => {
	const ctx = createExecuteContext({
		params: { ...baseParams, url: 'example.com' },
		transport: fullResponse({ image: PNG_B64 }),
	});

	const err = await capture(ctx);

	assert.equal(ctx.httpCalls.length, 0);
	assert.equal(ctx.binaryCalls.length, 0);
	assert.equal(err.constructor.name, 'NodeOperationError');
	assert.ok(/http:\/\/ or https:\/\//.test(err.message), err.message);
});

test('an out-of-range viewport fails before any request is made', async () => {
	const ctx = createExecuteContext({
		params: { ...baseParams, options: { width: 9 } },
		transport: fullResponse({ image: PNG_B64 }),
	});

	const err = await capture(ctx);

	assert.equal(ctx.httpCalls.length, 0);
	assert.equal(err.constructor.name, 'NodeOperationError');
	assert.ok(/between 100 and 8000/.test(err.message), err.message);
});

// ---------------------------------------------------------------------------
// API failures
// ---------------------------------------------------------------------------

test('an HTTP 200 capture failure never returns its placeholder image', async () => {
	const ctx = createExecuteContext({
		params: baseParams,
		transport: fullResponse(appErrorEnvelope('Screenshot capture failed', 500)),
	});

	const err = await capture(ctx);

	assert.equal(ctx.binaryCalls.length, 0, 'no binary may be produced from a failed capture');
	assert.equal(ctx.httpCalls.length, 1, 'a failed capture must not be retried');
	assert.equal(err.constructor.name, 'NodeApiError');
});

test('a rejected API key and an inactive subscription are reported differently', async () => {
	const keyError = await capture(
		createExecuteContext({
			params: baseParams,
			transport: fullResponse({ message: 'Invalid authentication credentials' }, 401),
		}),
	);
	const billingError = await capture(
		createExecuteContext({
			params: baseParams,
			transport: fullResponse({ message: 'No active subscription found' }, 403),
		}),
	);

	assert.ok(/API key/i.test(keyError.message), keyError.message);
	assert.equal(keyError.httpCode, '401');

	assert.ok(/subscription/i.test(billingError.message), billingError.message);
	assert.ok(!/API key/i.test(billingError.message), billingError.message);
	assert.equal(billingError.httpCode, '403');
});

test('quota, upstream and unexpected-response failures each surface their status', async () => {
	const cases = [
		{ response: fullResponse({ message: 'API rate limit exceeded' }, 429), httpCode: '429' },
		{ response: fullResponse({ message: 'Service temporarily unavailable' }, 503), httpCode: '503' },
		{ response: fullResponse('<html>error page</html>', 200), httpCode: '200' },
	];

	for (const { response, httpCode } of cases) {
		const ctx = createExecuteContext({ params: baseParams, transport: response });
		const err = await capture(ctx);
		assert.equal(err.httpCode, httpCode);
		assert.equal(ctx.httpCalls.length, 1);
		assert.equal(ctx.binaryCalls.length, 0);
	}
});

test('a malformed image payload fails instead of producing a corrupt binary', async () => {
	for (const body of [{ image: '@@@ not base64 @@@' }, { image: '' }, {}]) {
		const ctx = createExecuteContext({ params: baseParams, transport: fullResponse(body) });
		const err = await capture(ctx);
		assert.equal(ctx.binaryCalls.length, 0);
		assert.equal(err.constructor.name, 'NodeApiError');
	}
});

test('a PNG returned for a JPEG request is rejected as a format mismatch', async () => {
	const ctx = createExecuteContext({
		params: { ...baseParams, options: { format: 'jpeg' } },
		transport: fullResponse({ image: PNG_B64 }),
	});

	const err = await capture(ctx);

	assert.equal(ctx.binaryCalls.length, 0);
	assert.ok(/not JPEG/i.test(err.message), err.message);
});

// ---------------------------------------------------------------------------
// Transport failures
// ---------------------------------------------------------------------------

test('a transport failure is reported once and never retried', async () => {
	const ctx = createExecuteContext({
		params: baseParams,
		transport: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
			code: 'ECONNREFUSED',
		}),
	});

	const err = await capture(ctx);

	assert.equal(ctx.httpCalls.length, 1);
	assert.equal(err.constructor.name, 'NodeApiError');
	assert.ok(/reach/i.test(err.message), err.message);
});

test('a client-side timeout is reported as a timeout, not as a capture', async () => {
	const ctx = createExecuteContext({
		params: baseParams,
		transport: Object.assign(new Error('timeout of 90000ms exceeded'), { code: 'ECONNABORTED' }),
	});

	const err = await capture(ctx);

	assert.equal(ctx.binaryCalls.length, 0);
	assert.ok(/timed out/i.test(err.message), err.message);
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

test('neither the credential nor the target query reaches a thrown error', async () => {
	// Everything an upstream failure could plausibly echo back at us.
	const leakyBody = appErrorEnvelope(
		`render failed for https://target.example/?secret=${SECRET_TARGET_TOKEN}&userkey=${SECRET_KEY}`,
		500,
	);
	leakyBody.screenshot_parameters.url = `https://target.example/?secret=${SECRET_TARGET_TOKEN}`;
	leakyBody.screenshot_parameters.userkey = SECRET_KEY;

	const ctx = createExecuteContext({
		params: { ...baseParams, url: `https://target.example/?secret=${SECRET_TARGET_TOKEN}` },
		transport: fullResponse(leakyBody),
	});

	const err = await capture(ctx);
	const serialized = serializeError(err);

	assert.ok(!serialized.includes(SECRET_KEY), `credential leaked: ${serialized}`);
	assert.ok(!serialized.includes(SECRET_TARGET_TOKEN), `target query leaked: ${serialized}`);
	assert.equal(ctx.logs.length, 0, 'the node must not log');
});

test('a raw transport error object never reaches the thrown error', async () => {
	// An axios error's own message embeds the full request URL, userkey included.
	const raw = Object.assign(
		new Error(`connect ECONNREFUSED https://api.site-shot.com/?userkey=${SECRET_KEY}`),
		{
			code: 'ECONNREFUSED',
			config: { url: `https://api.site-shot.com/?userkey=${SECRET_KEY}` },
			response: { data: { userkey: SECRET_KEY } },
		},
	);

	const ctx = createExecuteContext({ params: baseParams, transport: raw });

	const err = await capture(ctx);
	const serialized = serializeError(err);

	assert.ok(!serialized.includes(SECRET_KEY), `credential leaked: ${serialized}`);
});

test('secrets do not reach the output when continueOnFail is on', async () => {
	const ctx = createExecuteContext({
		items: [{ json: { id: 1 } }],
		params: { ...baseParams, url: `https://target.example/?secret=${SECRET_TARGET_TOKEN}` },
		transport: fullResponse({ message: `denied for userkey ${SECRET_KEY}` }, 401),
		continueOnFail: true,
	});

	const [output] = await run(ctx);
	const serialized = JSON.stringify(output);

	assert.ok(!serialized.includes(SECRET_KEY), `credential leaked: ${serialized}`);
	assert.ok(!serialized.includes(SECRET_TARGET_TOKEN), `target query leaked: ${serialized}`);
	assert.equal(ctx.logs.length, 0);
});

// ---------------------------------------------------------------------------
// continueOnFail
// ---------------------------------------------------------------------------

test('continueOnFail keeps the item, its pairing and its JSON, with no binary', async () => {
	const ctx = createExecuteContext({
		items: [{ json: { id: 7, label: 'keep me' } }],
		params: baseParams,
		transport: fullResponse({ message: 'No active subscription found' }, 403),
		continueOnFail: true,
	});

	const [output] = await run(ctx);

	assert.equal(output.length, 1);
	assert.equal(output[0].json.id, 7);
	assert.equal(output[0].json.label, 'keep me');
	assert.ok(/subscription/i.test(String(output[0].json.error)), String(output[0].json.error));
	assert.deepEqual(output[0].pairedItem, { item: 0 });
	assert.equal(output[0].binary, undefined, 'a failed item must carry no binary');
});

test('continueOnFail isolates one bad item without losing the good ones', async () => {
	const ctx = createExecuteContext({
		items: [{ json: { id: 1 } }, { json: { id: 2 } }, { json: { id: 3 } }],
		params: {
			url: (i) => (i === 1 ? 'not-a-url' : 'https://example.com/'),
			binaryPropertyName: 'data',
		},
		transport: fullResponse({ image: PNG_B64 }),
		continueOnFail: true,
	});

	const [output] = await run(ctx);

	assert.equal(output.length, 3);
	assert.ok(output[0].binary.data);
	assert.equal(output[1].binary, undefined);
	assert.ok(output[1].json.error);
	assert.ok(output[2].binary.data);
	assert.equal(ctx.httpCalls.length, 2, 'the invalid item must not reach the API');
});

test('without continueOnFail the first failure stops the run', async () => {
	const ctx = createExecuteContext({
		items: [{ json: { id: 1 } }, { json: { id: 2 } }],
		params: {
			url: (i) => (i === 0 ? 'not-a-url' : 'https://example.com/'),
			binaryPropertyName: 'data',
		},
		transport: fullResponse({ image: PNG_B64 }),
	});

	await capture(ctx);

	assert.equal(ctx.httpCalls.length, 0);
});

test('a failure carries the item index so downstream error handling can pair it', async () => {
	const ctx = createExecuteContext({
		items: [{ json: { id: 1 } }, { json: { id: 2 } }],
		params: {
			url: (i) => (i === 1 ? 'not-a-url' : 'https://example.com/'),
			binaryPropertyName: 'data',
		},
		transport: fullResponse({ image: PNG_B64 }),
	});

	const err = await capture(ctx);

	assert.equal(err.context.itemIndex, 1);
});

// ---------------------------------------------------------------------------
// Transport response shape
// ---------------------------------------------------------------------------

test('a transport response without a status code fails instead of guessing', async () => {
	// If `returnFullResponse` ever stops being honoured, the node would see a
	// bare body. It must refuse rather than treat the shape as a success.
	for (const reply of [{ image: PNG_B64 }, undefined, null, 'plain text']) {
		const ctx = createExecuteContext({ params: baseParams, transport: reply });
		const err = await capture(ctx);
		assert.equal(ctx.binaryCalls.length, 0);
		assert.ok(/unexpected|not the expected/i.test(err.message), err.message);
	}
});
