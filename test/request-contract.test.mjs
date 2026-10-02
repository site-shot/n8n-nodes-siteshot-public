import test from 'node:test';
import assert from 'node:assert/strict';

import {
	JPEG_B64,
	JPEG_BYTES,
	PNG_B64,
	createExecuteContext,
	fullResponse,
	loadDist,
} from './helpers.mjs';

const { SiteShot } = loadDist('nodes/SiteShot/SiteShot.node.js');

function run(ctx) {
	return new SiteShot().execute.call(ctx);
}

const okPng = () => fullResponse({ image: PNG_B64 });

test('the request goes to the fixed Site-Shot endpoint with GET', async () => {
	const ctx = createExecuteContext({
		params: { url: 'https://example.com/', binaryPropertyName: 'data' },
		transport: okPng(),
	});

	await run(ctx);

	const { requestOptions } = ctx.httpCalls[0];
	assert.equal(requestOptions.url, 'https://api.site-shot.com/');
	assert.equal(requestOptions.method, 'GET');
	assert.equal(requestOptions.baseURL, undefined);
});

test('auth is delegated to the siteShotApi credential, never built by the node', async () => {
	const ctx = createExecuteContext({
		params: { url: 'https://example.com/', binaryPropertyName: 'data' },
		transport: okPng(),
	});

	await run(ctx);

	const { credentialsType, requestOptions } = ctx.httpCalls[0];
	assert.equal(credentialsType, 'siteShotApi');
	assert.ok(!('userkey' in requestOptions.qs), 'node must not set userkey itself');
	assert.equal(requestOptions.headers, undefined);
	assert.equal(requestOptions.auth, undefined);
});

test('JSON response mode is forced on every request', async () => {
	const ctx = createExecuteContext({
		params: { url: 'https://example.com/', binaryPropertyName: 'data' },
		transport: okPng(),
	});

	await run(ctx);

	assert.equal(ctx.httpCalls[0].requestOptions.qs.response_type, 'json');
	assert.equal(ctx.httpCalls[0].requestOptions.json, true);
});

test('capture options map onto the documented Site-Shot query parameters', async () => {
	const ctx = createExecuteContext({
		params: {
			url: 'https://example.com/',
			binaryPropertyName: 'data',
			options: { format: 'jpeg', fullPage: true, width: 1280, height: 900 },
		},
		transport: fullResponse({ image: JPEG_B64 }),
	});

	await run(ctx);

	const { qs } = ctx.httpCalls[0].requestOptions;
	assert.equal(qs.format, 'jpeg');
	assert.equal(qs.full_size, 1);
	assert.equal(qs.width, 1280);
	assert.equal(qs.height, 900);
});

test('unset capture options are omitted so the API applies its own defaults', async () => {
	const ctx = createExecuteContext({
		params: { url: 'https://example.com/', binaryPropertyName: 'data', options: {} },
		transport: okPng(),
	});

	await run(ctx);

	const { qs } = ctx.httpCalls[0].requestOptions;
	assert.deepEqual(Object.keys(qs).sort(), ['format', 'response_type', 'url']);
	assert.equal(qs.format, 'png');
});

test('a URL carrying its own query string cannot inject extra API parameters', async () => {
	const ctx = createExecuteContext({
		params: {
			url: 'https://example.com/?userkey=attacker&response_type=image',
			binaryPropertyName: 'data',
		},
		transport: okPng(),
	});

	await run(ctx);

	const { qs } = ctx.httpCalls[0].requestOptions;
	assert.equal(qs.url, 'https://example.com/?userkey=attacker&response_type=image');
	assert.equal(qs.response_type, 'json');
	assert.ok(!('userkey' in qs));
});

test('a JPEG capture is returned with the JPEG MIME type and extension', async () => {
	const ctx = createExecuteContext({
		params: {
			url: 'https://example.com/',
			binaryPropertyName: 'data',
			options: { format: 'jpeg' },
		},
		transport: fullResponse({ image: JPEG_B64 }),
	});

	const [output] = await run(ctx);

	assert.equal(output[0].binary.data.mimeType, 'image/jpeg');
	assert.equal(ctx.binaryCalls[0].fileName, 'screenshot.jpg');
	assert.deepEqual(ctx.binaryCalls[0].buffer, JPEG_BYTES);
});

test('the binary field name is taken from the node parameter', async () => {
	const ctx = createExecuteContext({
		params: { url: 'https://example.com/', binaryPropertyName: 'screenshot' },
		transport: okPng(),
	});

	const [output] = await run(ctx);

	assert.ok(output[0].binary.screenshot);
	assert.equal(output[0].binary.data, undefined);
});

test('each input item produces one paired output item and keeps its JSON', async () => {
	const items = [
		{ json: { id: 1, site: 'a' } },
		{ json: { id: 2, site: 'b' } },
		{ json: { id: 3, site: 'c' } },
	];
	const ctx = createExecuteContext({
		items,
		params: {
			url: (i) => `https://example.com/${i}`,
			binaryPropertyName: 'data',
		},
		transport: okPng(),
	});

	const [output] = await run(ctx);

	assert.equal(output.length, 3);
	assert.equal(ctx.httpCalls.length, 3);
	output.forEach((item, i) => {
		assert.deepEqual(item.json, items[i].json);
		assert.deepEqual(item.pairedItem, { item: i });
		assert.ok(item.binary.data);
	});
	assert.equal(ctx.httpCalls[1].requestOptions.qs.url, 'https://example.com/1');
});

test('the request opts into full responses and self-classified HTTP statuses', async () => {
	const ctx = createExecuteContext({
		params: { url: 'https://example.com/', binaryPropertyName: 'data' },
		transport: okPng(),
	});

	await run(ctx);

	const { requestOptions } = ctx.httpCalls[0];
	assert.equal(requestOptions.returnFullResponse, true);
	assert.equal(requestOptions.ignoreHttpStatusErrors, true);
});

test('the credential is confined to the Site-Shot host across redirects', async () => {
	const ctx = createExecuteContext({
		params: { url: 'https://example.com/', binaryPropertyName: 'data' },
		transport: okPng(),
	});

	await run(ctx);

	const { requestOptions } = ctx.httpCalls[0];
	assert.equal(requestOptions.allowedDomains, 'api.site-shot.com');
	assert.equal(requestOptions.sendCredentialsOnCrossOriginRedirect, false);
});

test('a bounded transport timeout is requested', async () => {
	const ctx = createExecuteContext({
		params: { url: 'https://example.com/', binaryPropertyName: 'data' },
		transport: okPng(),
	});

	await run(ctx);

	const { timeout } = ctx.httpCalls[0].requestOptions;
	assert.equal(typeof timeout, 'number');
	assert.ok(timeout > 0 && timeout <= 180000, `unexpected timeout ${timeout}`);
});

test('no user-controlled field can override the endpoint, userkey or response_type', async () => {
	// Every parameter the user can reach, loaded with values that would hijack
	// a reserved one if any of them were interpolated into the request.
	const hostile = {
		url: 'https://example.com/?response_type=image&userkey=attacker#&url=evil',
		binaryPropertyName: 'response_type',
		options: {
			format: 'png',
			fullPage: true,
			width: 1024,
			height: 768,
			// Unknown keys must never reach the query, whatever an expression puts here.
			userkey: 'attacker',
			response_type: 'image',
			url: 'https://evil.example/',
			javascript_code: 'alert(1)',
			http_proxy: 'http://evil.example:3128',
			country: 'DE',
		},
	};

	const ctx = createExecuteContext({ params: hostile, transport: okPng() });

	await run(ctx);

	const { requestOptions } = ctx.httpCalls[0];
	assert.equal(requestOptions.url, 'https://api.site-shot.com/');
	assert.equal(requestOptions.qs.response_type, 'json');
	assert.ok(!('userkey' in requestOptions.qs));
	assert.equal(requestOptions.qs.url, hostile.url);
	assert.deepEqual(
		Object.keys(requestOptions.qs).sort(),
		['format', 'full_size', 'height', 'response_type', 'url', 'width'],
	);
});
