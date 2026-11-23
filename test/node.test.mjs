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

test('new nodes are type version 1.1; workflows saved with version 1 keep loading', () => {
	const { description } = new SiteShot();
	assert.deepEqual(description.version, [1, 1.1]);
	assert.equal(description.defaultVersion, undefined);
});

test('the screenshot is the first file on the item, ahead of the files it keeps', async () => {
	const earlier = { data: 'kept', fileName: 'desktop.jpg', mimeType: 'image/jpeg' };
	const ctx = createExecuteContext({
		items: [{ json: {}, binary: { desktop: earlier, data: { data: 'old', fileName: 'old.png', mimeType: 'image/png' } } }],
		params: { url: 'https://target.example/page', binaryPropertyName: 'data' },
		transport: fullResponse({ image: PNG_B64 }),
	});

	const [output] = await run(ctx);

	assert.deepEqual(Object.keys(output[0].binary), ['data', 'desktop']);
	assert.notEqual(output[0].binary.data.data, 'old');
});

test('type version 1 keeps the 0.1.4 output: only the screenshot, and no file on failure', async () => {
	const earlier = { data: 'kept', fileName: 'desktop.jpg', mimeType: 'image/jpeg' };
	const ok = createExecuteContext({
		typeVersion: 1,
		items: [{ json: {}, binary: { desktop: earlier } }],
		params: { url: 'https://target.example/page', binaryPropertyName: 'mobile' },
		transport: fullResponse({ image: PNG_B64 }),
	});
	const [okOut] = await run(ok);
	assert.deepEqual(Object.keys(okOut[0].binary), ['mobile']);

	const bad = createExecuteContext({
		typeVersion: 1,
		items: [{ json: {}, binary: { desktop: earlier } }],
		params: { url: 'https://target.example/page', binaryPropertyName: 'mobile' },
		transport: fullResponse({ error: 'invalid authentication credentials' }, 401),
		continueOnFail: true,
	});
	const [badOut] = await run(bad);
	assert.ok(badOut[0].json.error);
	assert.equal(badOut[0].binary, undefined);
});

test('with Continue On Fail, a failed capture never leaves an older file in its output field', async () => {
	const stale = { data: 'stale', fileName: 'screenshot.png', mimeType: 'image/png' };
	const other = { data: 'other', fileName: 'a.pdf', mimeType: 'application/pdf' };
	const ctx = createExecuteContext({
		items: [{ json: {}, binary: { data: stale, other } }],
		params: { url: 'https://target.example/page', binaryPropertyName: 'data' },
		transport: fullResponse({ error: 'invalid authentication credentials' }, 401),
		continueOnFail: true,
	});

	const [output] = await run(ctx);

	assert.ok(output[0].json.error);
	assert.deepEqual(Object.keys(output[0].binary), ['other']);

	const only = createExecuteContext({
		items: [{ json: {}, binary: { data: stale } }],
		params: { url: 'https://target.example/page', binaryPropertyName: 'data' },
		transport: fullResponse({ error: 'invalid authentication credentials' }, 401),
		continueOnFail: true,
	});
	const [onlyOut] = await run(only);
	assert.equal(onlyOut[0].binary, undefined);
});

test('a failure before the request (bad URL) also drops the output field and keeps the rest', async () => {
	const stale = { data: 'stale', fileName: 'screenshot.png', mimeType: 'image/png' };
	const other = { data: 'other', fileName: 'a.pdf', mimeType: 'application/pdf' };
	const ctx = createExecuteContext({
		items: [{ json: {}, binary: { shot: stale, other } }],
		params: { url: 'not a url', binaryPropertyName: 'shot' },
		transport: fullResponse({ image: PNG_B64 }),
		continueOnFail: true,
	});

	const [output] = await run(ctx);

	assert.equal(ctx.httpCalls.length, 0);
	assert.equal(output[0].json.errorReason, 'invalid_url');
	assert.deepEqual(Object.keys(output[0].binary), ['other']);
});

test('each item keeps its own files, on success and on failure', async () => {
	const fileA = { data: 'a', fileName: 'a.jpg', mimeType: 'image/jpeg' };
	const fileB = { data: 'b', fileName: 'b.jpg', mimeType: 'image/jpeg' };
	const items = [
		{ json: { id: 1 }, binary: { a: fileA } },
		{ json: { id: 2 }, binary: { b: fileB } },
	];

	const ok = createExecuteContext({
		items,
		params: { url: 'https://target.example/page', binaryPropertyName: 'shot' },
		transport: [fullResponse({ image: PNG_B64 }), fullResponse({ image: PNG_B64 })],
	});
	const [okOut] = await run(ok);
	assert.deepEqual(Object.keys(okOut[0].binary), ['shot', 'a']);
	assert.deepEqual(Object.keys(okOut[1].binary), ['shot', 'b']);
	assert.equal(okOut[0].binary.a, fileA);
	assert.equal(okOut[1].binary.b, fileB);
	assert.notEqual(okOut[0].binary, okOut[1].binary);

	const bad = createExecuteContext({
		items,
		params: { url: 'https://target.example/page', binaryPropertyName: 'shot' },
		transport: [
			fullResponse({ error: 'invalid authentication credentials' }, 401),
			fullResponse({ error: 'invalid authentication credentials' }, 401),
		],
		continueOnFail: true,
	});
	const [badOut] = await run(bad);
	assert.deepEqual(Object.keys(badOut[0].binary), ['a']);
	assert.deepEqual(Object.keys(badOut[1].binary), ['b']);
	assert.deepEqual(badOut.map((i) => i.pairedItem), [{ item: 0 }, { item: 1 }]);
	assert.notEqual(badOut[0].binary, items[0].binary);
});

test('a field name that is not a string is read the same way on success and on failure', async () => {
	const stale = { data: 'stale', fileName: 'screenshot.png', mimeType: 'image/png' };
	const other = { data: 'other', fileName: 'a.pdf', mimeType: 'application/pdf' };
	const items = [{ json: {}, binary: { 2: stale, data: other } }];

	const ok = createExecuteContext({
		items,
		params: { url: 'https://target.example/page', binaryPropertyName: 2 },
		transport: fullResponse({ image: PNG_B64 }),
	});
	const [okOut] = await run(ok);
	assert.deepEqual(Object.keys(okOut[0].binary).sort(), ['2', 'data']);
	assert.notEqual(okOut[0].binary['2'].data, 'stale');

	const bad = createExecuteContext({
		items,
		params: { url: 'not a url', binaryPropertyName: 2 },
		continueOnFail: true,
	});
	const [badOut] = await run(bad);
	assert.deepEqual(Object.keys(badOut[0].binary), ['data']);
});

test('when the field name itself cannot be read, a failed item keeps every earlier file', async () => {
	const fileA = { data: 'a', fileName: 'a.jpg', mimeType: 'image/jpeg' };
	const fileData = { data: 'd', fileName: 'd.pdf', mimeType: 'application/pdf' };
	const ctx = createExecuteContext({
		items: [{ json: {}, binary: { a: fileA, data: fileData } }],
		params: {
			url: 'https://target.example/page',
			binaryPropertyName: () => {
				throw new Error('expression failed');
			},
		},
		continueOnFail: true,
	});

	const [output] = await run(ctx);

	assert.equal(ctx.httpCalls.length, 0);
	assert.ok(output[0].json.error);
	assert.deepEqual(Object.keys(output[0].binary).sort(), ['a', 'data']);
});
