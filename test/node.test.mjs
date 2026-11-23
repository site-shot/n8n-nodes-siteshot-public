import test from 'node:test';
import assert from 'node:assert/strict';

import {
	PNG_B64,
	PNG_BYTES,
	createExecuteContext,
	fullResponse,
	loadDist,
} from './helpers.mjs';

const { SiteShot } = loadDist('nodes/SiteShot/SiteShot.node.js');

function run(ctx) {
	return new SiteShot().execute.call(ctx);
}

test('a successful PNG capture returns the decoded image as binary data', async () => {
	const ctx = createExecuteContext({
		params: { url: 'https://example.com/', binaryPropertyName: 'data' },
		transport: fullResponse({ image: PNG_B64 }),
	});

	const [output] = await run(ctx);

	assert.equal(output.length, 1);
	assert.equal(output[0].binary.data.mimeType, 'image/png');
	assert.deepEqual(ctx.binaryCalls[0].buffer, PNG_BYTES);
});

test('files from earlier nodes stay on the item next to the screenshot', async () => {
	const earlier = { data: 'kept', fileName: 'desktop.jpg', mimeType: 'image/jpeg' };
	const ctx = createExecuteContext({
		items: [{ json: { a: 1 }, binary: { desktop: earlier } }],
		params: { url: 'https://target.example/page', binaryPropertyName: 'mobile' },
		transport: fullResponse({ image: PNG_B64 }),
	});

	const [output] = await run(ctx);

	assert.deepEqual(Object.keys(output[0].binary).sort(), ['desktop', 'mobile']);
	assert.equal(output[0].binary.desktop, earlier);
	assert.equal(output[0].binary.mobile.mimeType, 'image/png');
	assert.deepEqual(output[0].json, { a: 1 });
});

test('a capture into an existing field replaces that file only', async () => {
	const other = { data: 'other', fileName: 'a.pdf', mimeType: 'application/pdf' };
	const ctx = createExecuteContext({
		items: [{ json: {}, binary: { data: { data: 'old', fileName: 'old.png', mimeType: 'image/png' }, other } }],
		params: { url: 'https://target.example/page', binaryPropertyName: 'data' },
		transport: fullResponse({ image: PNG_B64 }),
	});

	const [output] = await run(ctx);

	assert.equal(output[0].binary.other, other);
	assert.notEqual(output[0].binary.data.data, 'old');
	assert.deepEqual(ctx.binaryCalls[0].buffer, PNG_BYTES);
});

test('with Continue On Fail, a failed capture keeps the files from earlier nodes', async () => {
	const earlier = { data: 'kept', fileName: 'desktop.jpg', mimeType: 'image/jpeg' };
	const ctx = createExecuteContext({
		items: [{ json: { a: 1 }, binary: { desktop: earlier } }],
		params: { url: 'https://target.example/page', binaryPropertyName: 'mobile' },
		transport: fullResponse({ error: 'invalid authentication credentials' }, 401),
		continueOnFail: true,
	});

	const [output] = await run(ctx);

	assert.ok(output[0].json.error);
	assert.deepEqual(Object.keys(output[0].binary), ['desktop']);
	assert.equal(output[0].binary.desktop, earlier);
});

test('an item without files still gets only the screenshot, and a failed one gets none', async () => {
	const ok = createExecuteContext({
		params: { url: 'https://target.example/page', binaryPropertyName: 'data' },
		transport: fullResponse({ image: PNG_B64 }),
	});
	const [okOut] = await run(ok);
	assert.deepEqual(Object.keys(okOut[0].binary), ['data']);

	const bad = createExecuteContext({
		params: { url: 'https://target.example/page', binaryPropertyName: 'data' },
		transport: fullResponse({ error: 'invalid authentication credentials' }, 401),
		continueOnFail: true,
	});
	const [badOut] = await run(bad);
	assert.equal(badOut[0].binary, undefined);
});
