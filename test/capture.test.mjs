/**
 * Unit tests for the Site-Shot platform adapter: URL validation, response
 * classification and image decoding. The execute-level contract lives in
 * node.test.mjs / failures.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
	JPEG_B64,
	JPEG_BYTES,
	PNG_B64,
	PNG_BYTES,
	SECRET_TARGET_TOKEN,
	appErrorEnvelope,
	loadDist,
} from './helpers.mjs';

const {
	CaptureFailure,
	MAX_IMAGE_BYTES,
	decodeCaptureImage,
	extractCaptureImage,
	validateTargetUrl,
} = loadDist('nodes/SiteShot/capture.js');

/** Assert a call fails with the given machine-readable reason. */
function failsWith(reason, fn) {
	try {
		fn();
	} catch (err) {
		assert.ok(err instanceof CaptureFailure, `expected CaptureFailure, got ${err?.name}: ${err?.message}`);
		assert.equal(err.reason, reason, `expected reason "${reason}", got "${err.reason}" (${err.message})`);
		return err;
	}
	throw new assert.AssertionError({ message: `expected a ${reason} failure, but the call succeeded` });
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

test('an explicit http or https URL is accepted unchanged', () => {
	assert.equal(validateTargetUrl('https://example.com/pricing'), 'https://example.com/pricing');
	assert.equal(validateTargetUrl('http://example.com/'), 'http://example.com/');
	assert.equal(validateTargetUrl('  https://example.com/  '), 'https://example.com/');
});

test('a bare domain is rejected rather than silently given a scheme', () => {
	// The SDK prepends https://, but the API's own default is http, so guessing
	// here would quietly capture a different page than the user asked for.
	const err = failsWith('invalid_url', () => validateTargetUrl('example.com'));
	assert.ok(/http:\/\/ or https:\/\//.test(err.message), err.message);
});

test('non-web schemes are rejected', () => {
	for (const raw of [
		'file:///etc/passwd',
		'data:text/html,<h1>x</h1>',
		'javascript:alert(1)',
		'ftp://example.com/x',
		'//example.com/',
	]) {
		failsWith('invalid_url', () => validateTargetUrl(raw));
	}
});

test('a URL with embedded credentials is rejected', () => {
	failsWith('invalid_url', () => validateTargetUrl('https://user:pass@example.com/'));
	failsWith('invalid_url', () => validateTargetUrl('https://user@example.com/'));
});

test('a URL with embedded control characters is rejected', () => {
	// The WHATWG URL parser silently strips tab/CR/LF, so these have to be
	// caught before parsing or they would vanish into a different URL.
	failsWith('invalid_url', () => validateTargetUrl('https://example.com/\nHost: evil'));
	failsWith('invalid_url', () => validateTargetUrl('https://example.com/a\tb'));
	failsWith('invalid_url', () => validateTargetUrl('https://example.com/\u0000x'));
	failsWith('invalid_url', () => validateTargetUrl('https://exa\u007fmple.com/'));
});

test('surrounding whitespace is trimmed rather than treated as a control character', () => {
	assert.equal(validateTargetUrl('\n https://example.com/ \t'), 'https://example.com/');
});

test('an empty or non-string URL is rejected', () => {
	for (const raw of ['', '   ', undefined, null, 42, {}, []]) {
		failsWith('invalid_url', () => validateTargetUrl(raw));
	}
});

test('an unparseable URL is rejected', () => {
	failsWith('invalid_url', () => validateTargetUrl('https://'));
});

test('the rejected URL is never echoed back in the failure', () => {
	const err = failsWith('invalid_url', () =>
		validateTargetUrl(`ftp://example.com/?token=${SECRET_TARGET_TOKEN}`),
	);
	assert.ok(!err.message.includes(SECRET_TARGET_TOKEN), err.message);
	assert.ok(!JSON.stringify(err.safeDetail ?? {}).includes(SECRET_TARGET_TOKEN));
});

// ---------------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------------

test('a plain successful capture yields the image payload', () => {
	assert.equal(extractCaptureImage({ statusCode: 200, body: { image: PNG_B64 } }), PNG_B64);
});

test('a message field on a successful capture is metadata, not an error', () => {
	const body = { image: PNG_B64, message: 'rendered from DE' };
	assert.equal(extractCaptureImage({ statusCode: 200, body }), PNG_B64);
});

test('an HTTP 200 capture-failure envelope fails instead of yielding its placeholder image', () => {
	const body = appErrorEnvelope('Screenshot capture failed', 500);
	const err = failsWith('capture_failed', () => extractCaptureImage({ statusCode: 200, body }));
	assert.equal(err.httpCode, '200');
});

test('an error key wins over a sibling message key', () => {
	const body = { error: 'country_unavailable', message: 'informational', image: PNG_B64 };
	failsWith('country_unavailable', () => extractCaptureImage({ statusCode: 200, body }));
});

test('an upstream "403 Forbidden" capture failure is not blamed on the API key', () => {
	const body = appErrorEnvelope('403 Forbidden', 403);
	const err = failsWith('capture_failed', () => extractCaptureImage({ statusCode: 200, body }));
	assert.ok(!/API key/i.test(err.message), err.message);
});

test('HTTP 401 is classified as a rejected API key', () => {
	for (const message of ['Invalid authentication credentials', 'No API key found in request']) {
		const err = failsWith('invalid_api_key', () =>
			extractCaptureImage({ statusCode: 401, body: { message } }),
		);
		assert.equal(err.httpCode, '401');
	}
	failsWith('invalid_api_key', () => extractCaptureImage({ statusCode: 401, body: {} }));
});

test('HTTP 403 is an inactive subscription, distinct from a rejected key', () => {
	const err = failsWith('subscription_inactive', () =>
		extractCaptureImage({ statusCode: 403, body: { message: 'No active subscription found' } }),
	);
	assert.ok(!/API key/i.test(err.message), err.message);
	failsWith('subscription_inactive', () => extractCaptureImage({ statusCode: 403, body: {} }));
});

test('HTTP 402 and 429 are quota or payment failures', () => {
	for (const statusCode of [402, 429]) {
		failsWith('quota_or_payment', () =>
			extractCaptureImage({ statusCode, body: { message: 'API rate limit exceeded' } }),
		);
	}
});

test('a quota-flavoured capture failure is classified as quota', () => {
	failsWith('quota_or_payment', () =>
		extractCaptureImage({ statusCode: 200, body: appErrorEnvelope('monthly quota exceeded', 402) }),
	);
});

test('a parameter-flavoured capture failure is classified as invalid parameters', () => {
	failsWith('invalid_parameters', () =>
		extractCaptureImage({ statusCode: 200, body: appErrorEnvelope('width out of range', 400) }),
	);
});

test('a 5xx is classified as the API being unavailable', () => {
	const err = failsWith('api_unavailable', () =>
		extractCaptureImage({ statusCode: 503, body: { message: 'Service temporarily unavailable' } }),
	);
	assert.equal(err.httpCode, '503');
});

test('a non-JSON body is an unexpected response, whatever the status', () => {
	failsWith('unexpected_response', () =>
		extractCaptureImage({ statusCode: 200, body: '<html>error page</html>' }),
	);
	failsWith('api_unavailable', () =>
		extractCaptureImage({ statusCode: 500, body: 'upstream exploded' }),
	);
});

test('a successful response with no image is an unexpected response', () => {
	failsWith('no_image', () => extractCaptureImage({ statusCode: 200, body: { status: 'ok' } }));
	failsWith('no_image', () => extractCaptureImage({ statusCode: 200, body: { image: '' } }));
	failsWith('no_image', () => extractCaptureImage({ statusCode: 200, body: { image: 42 } }));
});

test('arbitrary upstream error text never reaches the failure message', () => {
	const body = appErrorEnvelope(`boom ${SECRET_TARGET_TOKEN} at /internal/path`, 500);
	const err = failsWith('capture_failed', () => extractCaptureImage({ statusCode: 200, body }));
	assert.ok(!err.message.includes(SECRET_TARGET_TOKEN), err.message);
	assert.ok(!err.message.includes('/internal/path'), err.message);
});

test('only source-proven upstream reasons are echoed verbatim', () => {
	const allowed = failsWith('country_unavailable', () =>
		extractCaptureImage({ statusCode: 200, body: { error: 'country_unavailable' } }),
	);
	assert.ok(allowed.message.includes('country_unavailable'), allowed.message);
});

// ---------------------------------------------------------------------------
// Image decoding
// ---------------------------------------------------------------------------

test('a valid PNG payload decodes to its exact bytes', () => {
	assert.deepEqual(decodeCaptureImage(PNG_B64, 'png'), PNG_BYTES);
});

test('a valid JPEG payload decodes to its exact bytes', () => {
	assert.deepEqual(decodeCaptureImage(JPEG_B64, 'jpeg'), JPEG_BYTES);
});

test('a data-URL prefix matching the requested format is stripped', () => {
	assert.deepEqual(decodeCaptureImage(`data:image/png;base64,${PNG_B64}`, 'png'), PNG_BYTES);
	assert.deepEqual(decodeCaptureImage(`data:image/jpeg;base64,${JPEG_B64}`, 'jpeg'), JPEG_BYTES);
});

test('a data-URL prefix contradicting the requested format is rejected', () => {
	failsWith('format_mismatch', () => decodeCaptureImage(`data:image/jpeg;base64,${PNG_B64}`, 'png'));
});

test('image bytes that do not match the requested format are rejected', () => {
	// A real PNG returned when JPEG was requested must not be passed off as a JPEG.
	failsWith('format_mismatch', () => decodeCaptureImage(PNG_B64, 'jpeg'));
	failsWith('format_mismatch', () => decodeCaptureImage(JPEG_B64, 'png'));
});

test('a payload that is not an image at all is rejected', () => {
	const notAnImage = Buffer.from('not-really-a-png-but-bytes-are-bytes').toString('base64');
	failsWith('format_mismatch', () => decodeCaptureImage(notAnImage, 'png'));
});

test('malformed base64 is rejected instead of decoding to corrupt bytes', () => {
	// Node's decoder silently skips invalid characters, so these would
	// otherwise become short or empty buffers posing as screenshots.
	for (const image of ['@@@@ not base64 @@@@', '%%%%', 'iVBORw0KGgo!!!!', 'a']) {
		failsWith('malformed_image', () => decodeCaptureImage(image, 'png'));
	}
});

test('an empty payload is rejected', () => {
	failsWith('malformed_image', () => decodeCaptureImage('', 'png'));
	failsWith('malformed_image', () => decodeCaptureImage('   ', 'png'));
});

test('an oversized payload is rejected before it is decoded', () => {
	const oversized = 'A'.repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8);
	const err = failsWith('response_too_large', () => decodeCaptureImage(oversized, 'png'));
	assert.ok(/large/i.test(err.message), err.message);
});

test('the size limit is a documented, finite number of bytes', () => {
	assert.equal(typeof MAX_IMAGE_BYTES, 'number');
	assert.ok(MAX_IMAGE_BYTES > 0 && Number.isFinite(MAX_IMAGE_BYTES));
});
