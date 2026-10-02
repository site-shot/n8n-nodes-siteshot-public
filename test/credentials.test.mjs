/**
 * The credential is the only place the API key exists. These tests pin where
 * the key is placed for each request shape, and the fact that it is a password
 * field rather than an ordinary node input.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SECRET_KEY, loadDist } from './helpers.mjs';

const { SiteShotApi } = loadDist('credentials/SiteShotApi.credentials.js');
const { SiteShot } = loadDist('nodes/SiteShot/SiteShot.node.js');

const CHECK_URL = '/v1.0/credential-check';
const API_BASE_URL = 'https://api.site-shot.com';

/** Apply the credential's own auth hook, the way n8n's RoutingNode does. */
function applyAuth(requestOptions) {
	return new SiteShotApi().authenticate({ apiKey: SECRET_KEY }, requestOptions);
}

/** The request options n8n builds for the declared credential test. */
function checkRequestOptions(extra = {}) {
	const { request } = new SiteShotApi().test;
	return { baseURL: request.baseURL, url: request.url, method: request.method, ...extra };
}

/** The request options the node builds for a capture. */
function captureRequestOptions(extra = {}) {
	return {
		method: 'GET',
		url: 'https://api.site-shot.com/',
		qs: { url: 'https://example.com/', response_type: 'json', format: 'png' },
		json: true,
		returnFullResponse: true,
		...extra,
	};
}

/**
 * The same request after RoutingNode has initialised its containers.
 *
 * It hands `authenticate` empty `qs`/`body`/`headers` objects rather than
 * leaving them absent, so "there is no `qs`" is not the invariant to assert --
 * "no credential is in `qs`" is.
 */
function routed(options) {
	return { qs: {}, body: {}, headers: {}, ...options };
}

/** Both shapes `authenticate` can be handed for the same request. */
function bothShapes(options) {
	return [options, routed(options)];
}

test('the credential is named as the node references it', () => {
	const credential = new SiteShotApi();
	assert.equal(credential.name, 'siteShotApi');

	const declared = new SiteShot().description.credentials;
	assert.deepEqual(declared, [{ name: 'siteShotApi', required: true }]);
});

test('the API key is a required password field, not an ordinary input', () => {
	const credential = new SiteShotApi();
	assert.equal(credential.properties.length, 1);

	const [apiKey] = credential.properties;
	assert.equal(apiKey.name, 'apiKey');
	assert.equal(apiKey.type, 'string');
	assert.equal(apiKey.typeOptions.password, true);
	assert.equal(apiKey.required, true);
	assert.equal(apiKey.default, '');
});

test('the node never names the credential field itself, so it cannot read the key', () => {
	const declared = JSON.stringify(new SiteShot().description);
	assert.ok(!declared.includes('userkey'), 'node description must not mention userkey');
	assert.ok(!declared.includes('apiKey'), 'node description must not mention apiKey');
	assert.ok(!declared.includes(SECRET_KEY));
});

test('the credential points at documentation', () => {
	const credential = new SiteShotApi();
	assert.equal(typeof credential.documentationUrl, 'string');
	assert.ok(credential.documentationUrl.startsWith('https://'));
});

// ---------------------------------------------------------------------------
// Where the key is placed
//
// n8n runs `test.request` through a RoutingNode, so `authenticate` is applied
// to the credential test as well as to captures. A generic `qs` declaration
// would therefore put the key in the check URL's query string -- and into every
// access log on the way. These tests pin both shapes.
//
// GAP: `n8n-core`, which owns RoutingNode, is not a dependency of a community
// node package and is not installed here, so the real routing code is never
// executed by these tests. They model the request-option shapes it can hand
// over -- the declared `baseURL`/`url` pair, and the same request carrying the
// empty containers RoutingNode initialises -- and assert the invariant that
// holds either way. End-to-end proof needs a running n8n and is a
// deployment-time step.
// ---------------------------------------------------------------------------

test('the credential-test request is authenticated by header, never by query', async () => {
	for (const options of bothShapes(checkRequestOptions())) {
		const applied = await applyAuth(options);

		assert.equal(applied.headers.userkey, SECRET_KEY);
		assert.equal(applied.qs?.userkey, undefined, 'the key must not reach the query string');
		assert.ok(!JSON.stringify(applied.qs ?? {}).includes(SECRET_KEY));
	}
});

test('the check is recognised even when n8n resolves baseURL into the url', async () => {
	// Which shape RoutingNode hands over cannot be executed here. If it ever
	// resolves the pair into one absolute URL, failing to recognise it would
	// fall through to the query form -- the exact leak this hook exists to
	// prevent -- so both spellings of the same request must take the header.
	for (const options of bothShapes({ method: 'GET', url: `${API_BASE_URL}${CHECK_URL}` })) {
		const applied = await applyAuth(options);

		assert.equal(applied.headers.userkey, SECRET_KEY);
		assert.ok(!JSON.stringify(applied.qs ?? {}).includes(SECRET_KEY));
	}
});

test('a capture request is authenticated by query, with no auth header invented', async () => {
	for (const options of bothShapes(captureRequestOptions())) {
		const applied = await applyAuth(options);

		assert.equal(applied.qs.userkey, SECRET_KEY);
		assert.equal(applied.headers?.userkey, undefined, 'the capture path must invent no auth header');
		assert.ok(!JSON.stringify(applied.headers ?? {}).includes(SECRET_KEY));
	}
});

test('authentication preserves every request option it was given', async () => {
	const capture = await applyAuth(captureRequestOptions());
	assert.equal(capture.url, 'https://api.site-shot.com/');
	assert.equal(capture.method, 'GET');
	assert.equal(capture.json, true);
	assert.equal(capture.returnFullResponse, true);
	assert.equal(capture.qs.url, 'https://example.com/');
	assert.equal(capture.qs.response_type, 'json');
	assert.equal(capture.qs.format, 'png');

	const check = await applyAuth(routed(checkRequestOptions({ headers: { accept: 'application/json' } })));
	assert.equal(check.baseURL, API_BASE_URL);
	assert.equal(check.url, CHECK_URL);
	assert.equal(check.method, 'GET');
	assert.equal(check.headers.accept, 'application/json', 'existing headers must survive');
	assert.equal(check.headers.userkey, SECRET_KEY);
});

test('only the exact check request takes the header form', async () => {
	// A capture whose path merely resembles the check route, and the check path
	// on some other base URL, must both keep the published query behaviour --
	// otherwise a future route could silently change how the key is sent.
	const lookalikes = [
		{ url: CHECK_URL },
		{ baseURL: 'https://evil.example', url: CHECK_URL },
		{ baseURL: API_BASE_URL, url: '/v1.0/screenshot' },
		{ baseURL: API_BASE_URL, url: `${CHECK_URL}/extra` },
	];

	for (const options of lookalikes) {
		for (const shape of bothShapes({ method: 'GET', ...options })) {
			const applied = await applyAuth(shape);
			assert.equal(applied.qs.userkey, SECRET_KEY, `${JSON.stringify(options)} should use qs`);
			assert.equal(
				applied.headers?.userkey,
				undefined,
				`${JSON.stringify(options)} gained an auth header`,
			);
		}
	}
});

// ---------------------------------------------------------------------------
// Credential test
//
// The credential declares n8n's official `test` request against the dedicated
// check route. `testedBy` is forbidden -- it would have to name a node
// credential-test method, and the only one possible would spend a capture.
// ---------------------------------------------------------------------------

test('a real credential test request is declared, not a testedBy marker', () => {
	const credential = new SiteShotApi();
	assert.ok(credential.test, 'credential must declare a test');
	assert.ok(credential.test.request, 'the test must be a real request');
	assert.equal(credential.testedBy, undefined);

	const declared = JSON.stringify(new SiteShot().description);
	assert.ok(!declared.includes('testedBy'), 'the node must not fake a testedBy');
});

test('the credential test calls the dedicated check path on the fixed host', () => {
	const { request } = new SiteShotApi().test;

	assert.equal(request.baseURL, API_BASE_URL);
	assert.equal(request.url, CHECK_URL);
	assert.equal(request.method, 'GET');
});

test('the credential test declares no credential of its own', () => {
	// One source of truth: `authenticate` decides where the key goes. A second
	// declaration here would be the thing that drifts.
	const { request } = new SiteShotApi().test;

	assert.equal(request.headers, undefined);
	assert.equal(request.auth, undefined);
	assert.ok(!JSON.stringify(request).includes('apiKey'));
	assert.ok(!JSON.stringify(request).includes('userkey'));
});

test('the credential test carries no URL, body, account id or other PII', () => {
	const { request } = new SiteShotApi().test;
	const serialized = JSON.stringify(request);

	assert.equal(request.body, undefined);
	assert.equal(request.qs, undefined);
	for (const forbidden of ['url=', 'email', 'username', 'user_id', 'account', 'custom_id']) {
		assert.ok(!serialized.includes(forbidden), `test request mentions "${forbidden}"`);
	}
	assert.deepEqual(
		Object.keys(request).sort(),
		[
			'allowedDomains',
			'baseURL',
			'disableFollowRedirect',
			'method',
			'sendCredentialsOnCrossOriginRedirect',
			'url',
		],
	);
});

test('the credential test cannot carry the key off-host', () => {
	const { request } = new SiteShotApi().test;

	// A redirect is never legitimate here: the check is one fixed route on one
	// fixed host.
	assert.equal(request.disableFollowRedirect, true);
	assert.equal(request.sendCredentialsOnCrossOriginRedirect, false);
	assert.equal(request.allowedDomains, 'api.site-shot.com');
});

test('the check bounds its own timeout, overriding the one n8n substitutes', async () => {
	// This is the actual shape `authenticate` is handed. RoutingNode has
	// already overwritten `timeout` with its own five-minute default by this
	// point (`routing-node.ts:225-229` in n8n 2.40.5), which is why declaring a
	// timeout on `test.request` has no effect and the hook has to set it.
	//
	// Measured against the real runtime before this was added: a check against
	// an endpoint that stalled for 25s returned success after 25s.
	const applied = await applyAuth(routed({ ...checkRequestOptions(), timeout: 300_000 }));

	assert.equal(applied.timeout, 10_000);
	assert.ok(applied.timeout < 300_000, 'the substituted default must not survive');
});

test('the capture keeps the timeout the node asked for', async () => {
	// The capture does not go through RoutingNode -- the node calls the HTTP
	// helper itself -- so its own 90s budget must be passed through untouched.
	const { REQUEST_TIMEOUT_MS } = loadDist('nodes/SiteShot/capture.js');
	const applied = await applyAuth(routed({ ...captureRequestOptions(), timeout: REQUEST_TIMEOUT_MS }));

	assert.equal(applied.timeout, REQUEST_TIMEOUT_MS);
	assert.equal(applied.timeout, 90_000);
});

test('the credential test cannot reach the capture endpoint', () => {
	const { request } = new SiteShotApi().test;
	const { API_ENDPOINT } = loadDist('nodes/SiteShot/capture.js');

	// Same host and same credential as a capture, but a different, dedicated
	// path.
	assert.equal(`${request.baseURL}/`, API_ENDPOINT);
	assert.notEqual(request.url, '/');
	assert.ok(!/screenshot|download|fetch-ephemeral/.test(request.url));
});

test('an inactive subscription is reported distinctly from a bad key', () => {
	const { rules } = new SiteShotApi().test;

	const blocked = rules.find((rule) => rule.properties.value === 403);
	assert.ok(blocked, 'a 403 rule must exist');
	assert.equal(blocked.type, 'responseCode');
	const { message } = blocked.properties;
	assert.ok(/subscription/i.test(message), message);
	// It must not send the user off to fix a key that is actually fine. Saying
	// "the API key is valid" is the opposite of blaming it, so the check is on
	// the instruction, not on the words "API key".
	assert.ok(!/(check|invalid|rejected|wrong|incorrect)[^.]*\bkey\b/i.test(message), message);
	assert.ok(!/\bkey\b[^.]*(invalid|rejected|wrong|incorrect)/i.test(message), message);
});
