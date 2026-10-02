/**
 * End-to-end tests over a real socket, against a synthetic Site-Shot stub
 * bound to 127.0.0.1.
 *
 * No external network is used: the adapter below asserts that the node asked
 * for the real Site-Shot endpoint, and only then serves that request from the
 * local stub. Any other host is refused outright. It also performs the
 * credential's own `userkey` injection, so the declared injection contract is
 * exercised rather than assumed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

import {
	PNG_B64,
	PNG_BYTES,
	SECRET_KEY,
	createExecuteContext,
	loadDist,
	serializeError,
} from './helpers.mjs';

const { SiteShot } = loadDist('nodes/SiteShot/SiteShot.node.js');
const { SiteShotApi } = loadDist('credentials/SiteShotApi.credentials.js');
const { API_ENDPOINT, MAX_IMAGE_BYTES } = loadDist('nodes/SiteShot/capture.js');

/**
 * A stand-in for n8n's HTTP helper that really talks to `origin` over
 * loopback, honouring the documented `IHttpRequestOptions` fields this node
 * uses.
 */
function loopbackTransport(origin, apiKey = SECRET_KEY) {
	return async (rawOptions) => {
		assert.equal(rawOptions.url, API_ENDPOINT, 'the node must target the fixed Site-Shot endpoint');
		assert.equal(rawOptions.allowedDomains, 'api.site-shot.com');

		// The credential's real hook, not a re-implementation of it: n8n applies
		// this before the request leaves, so the injection contract is exercised
		// over the socket rather than restated here.
		const options = await new SiteShotApi().authenticate({ apiKey }, rawOptions);
		assert.equal(options.headers?.userkey, undefined, 'a capture must invent no auth header');

		const target = new URL(origin);
		for (const [name, value] of Object.entries(options.qs ?? {})) {
			target.searchParams.set(name, String(value));
		}
		assert.equal(target.hostname, '127.0.0.1', 'tests never leave loopback');

		const res = await fetch(target, { method: options.method ?? 'GET' });
		const text = await res.text();

		let body = text;
		if (options.json) {
			try {
				body = JSON.parse(text);
			} catch {
				body = text;
			}
		}

		return {
			body,
			statusCode: res.status,
			headers: Object.fromEntries(res.headers.entries()),
		};
	};
}

/** Start a synthetic Site-Shot stub on 127.0.0.1 and record what it receives. */
async function startStub(handler) {
	const requests = [];
	const server = createServer((req, res) => {
		requests.push(new URL(req.url, 'http://127.0.0.1'));
		handler(req, res);
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const { port } = server.address();
	return {
		origin: `http://127.0.0.1:${port}/`,
		requests,
		async close() {
			server.close();
			await once(server, 'close');
		},
	};
}

function json(res, body, statusCode = 200) {
	const payload = JSON.stringify(body);
	res.writeHead(statusCode, { 'content-type': 'application/json' });
	res.end(payload);
}

test('a capture served over a real socket produces the exact image bytes', async (t) => {
	const stub = await startStub((_req, res) => json(res, { image: PNG_B64 }));
	t.after(() => stub.close());

	const ctx = createExecuteContext({
		params: { url: 'https://example.com/', binaryPropertyName: 'data' },
		transport: loopbackTransport(stub.origin),
	});

	const [output] = await new SiteShot().execute.call(ctx);

	assert.deepEqual(ctx.binaryCalls[0].buffer, PNG_BYTES);
	assert.equal(output[0].binary.data.mimeType, 'image/png');
	assert.equal(stub.requests.length, 1);
});

test('the credential key and forced JSON mode arrive in the query string', async (t) => {
	const stub = await startStub((_req, res) => json(res, { image: PNG_B64 }));
	t.after(() => stub.close());

	const ctx = createExecuteContext({
		params: {
			url: 'https://example.com/pricing',
			binaryPropertyName: 'data',
			options: { format: 'png', fullPage: true, width: 1280 },
		},
		transport: loopbackTransport(stub.origin),
	});

	await new SiteShot().execute.call(ctx);

	const received = stub.requests[0].searchParams;
	assert.equal(received.get('userkey'), SECRET_KEY);
	assert.equal(received.get('response_type'), 'json');
	assert.equal(received.get('url'), 'https://example.com/pricing');
	assert.equal(received.get('full_size'), '1');
	assert.equal(received.get('width'), '1280');
	assert.equal(received.getAll('userkey').length, 1);
});

test('a real 401 from the stub is classified without leaking the key it echoes', async (t) => {
	const stub = await startStub((req, res) => {
		// A hostile-but-plausible upstream: it echoes the key back at us.
		const key = new URL(req.url, 'http://127.0.0.1').searchParams.get('userkey');
		json(res, { message: `Invalid authentication credentials for ${key}` }, 401);
	});
	t.after(() => stub.close());

	const ctx = createExecuteContext({
		params: { url: 'https://example.com/', binaryPropertyName: 'data' },
		transport: loopbackTransport(stub.origin),
	});

	let thrown;
	await new SiteShot().execute.call(ctx).catch((err) => {
		thrown = err;
	});

	assert.ok(thrown, 'expected a failure');
	assert.equal(thrown.httpCode, '401');
	assert.ok(!serializeError(thrown).includes(SECRET_KEY), 'the echoed key leaked');
	assert.equal(stub.requests.length, 1, 'a rejected key must not be retried');
	assert.equal(ctx.binaryCalls.length, 0);
});

test('a real HTML error page over the socket never becomes a screenshot', async (t) => {
	const stub = await startStub((_req, res) => {
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end('<html><body>error</body></html>');
	});
	t.after(() => stub.close());

	const ctx = createExecuteContext({
		params: { url: 'https://example.com/', binaryPropertyName: 'data' },
		transport: loopbackTransport(stub.origin),
	});

	await assert.rejects(new SiteShot().execute.call(ctx));
	assert.equal(ctx.binaryCalls.length, 0);
	assert.equal(stub.requests.length, 1);
});

test('a real oversized body is refused before it is decoded', async (t) => {
	const stub = await startStub((_req, res) => {
		const oversized = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8);
		json(res, { image: oversized });
	});
	t.after(() => stub.close());

	const ctx = createExecuteContext({
		params: { url: 'https://example.com/', binaryPropertyName: 'data' },
		transport: loopbackTransport(stub.origin),
	});

	let thrown;
	await new SiteShot().execute.call(ctx).catch((err) => {
		thrown = err;
	});

	assert.ok(/large/i.test(thrown.message), thrown.message);
	assert.equal(ctx.binaryCalls.length, 0);
});

test('a refused connection is reported once, with no retry and no leak', async (t) => {
	const stub = await startStub((_req, res) => json(res, { image: PNG_B64 }));
	const { origin } = stub;
	await stub.close();
	t.after(() => {});

	const ctx = createExecuteContext({
		params: { url: 'https://example.com/', binaryPropertyName: 'data' },
		transport: loopbackTransport(origin),
	});

	let thrown;
	await new SiteShot().execute.call(ctx).catch((err) => {
		thrown = err;
	});

	assert.ok(thrown, 'expected a failure');
	assert.ok(/reach/i.test(thrown.message), thrown.message);
	assert.equal(ctx.httpCalls.length, 1, 'a connection failure must not be retried');
	assert.ok(!serializeError(thrown).includes(SECRET_KEY));
});
