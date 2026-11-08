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

test('an unreachable page (error_code proxy_navigation_failed) is not reported as a timeout', () => {
	// Measured live: an address that does not resolve answers HTTP 200 with
	// this envelope in JSON mode, and `error` reads "504 Gateway Timeout".
	const body = {
		...appErrorEnvelope('504 Gateway Timeout', '504', ''),
		image: 'data:image/png;base64,',
		error_code: 'proxy_navigation_failed',
	};
	const err = failsWith('page_unreachable', () => extractCaptureImage({ statusCode: 200, body }));
	assert.equal(err.httpCode, '200');
	assert.equal(err.message, 'Site-Shot could not open the page (proxy_navigation_failed).');
	assert.ok(/spelled correctly/.test(err.description), err.description);
	assert.ok(/still counts as a capture/.test(err.description), err.description);
	assert.ok(!/timed out|simpler page/i.test(`${err.message} ${err.description}`));
});

test('proxy_navigation_failed advice names a slow page as well as a wrong address', () => {
	// The renderer sends this code for any failed navigation, including a page
	// that did not load in time or an access wall, and the API treats it as a
	// proxy failure. Advice that only blames the address would mislead.
	const body = { error: '504 Gateway Timeout', error_code: 'proxy_navigation_failed' };
	const err = failsWith('page_unreachable', () => extractCaptureImage({ statusCode: 200, body }));
	assert.ok(/wrong or unreachable/.test(err.description), err.description);
	assert.ok(/did not load in time/.test(err.description), err.description);
	assert.ok(/every retry/.test(err.description), err.description);
});

test('error_code dns_lookup_failed is an unreachable page too', () => {
	// The API's own code for a host that does not resolve, once the
	// honest-errors API change ships.
	const body = {
		...appErrorEnvelope('Host not found: nonexistent-host.invalid. Check the URL for typos.', '', ''),
		image: 'data:image/png;base64,',
		error_code: 'dns_lookup_failed',
	};
	const err = failsWith('page_unreachable', () => extractCaptureImage({ statusCode: 200, body }));
	assert.equal(err.message, 'Site-Shot could not open the page (dns_lookup_failed).');
	assert.ok(/spelled correctly/.test(err.description), err.description);
	// This code says only that the host did not resolve.
	assert.ok(!/did not load in time/.test(err.description), err.description);
});

test('error_code country_unavailable is read even when the error text differs', () => {
	const body = { error: 'No proxy available', error_code: 'country_unavailable' };
	failsWith('country_unavailable', () => extractCaptureImage({ statusCode: 200, body }));
});

test('a page-side status line or browser error on a 200 is not read as a key or option problem', () => {
	for (const error of [
		'407 Proxy Authentication Required',
		'401 Unauthorized',
		'net::ERR_CERT_AUTHORITY_INVALID',
		'400 Bad Request: invalid',
	]) {
		const err = failsWith('capture_failed', () =>
			extractCaptureImage({ statusCode: 200, body: appErrorEnvelope(error, error.slice(0, 3)) }),
		);
		assert.ok(!/API key|parameters|quota/i.test(err.message), `${error}: ${err.message}`);
	}
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
	const unexplained = failsWith('access_refused', () =>
		extractCaptureImage({ statusCode: 403, body: {} }),
	);
	assert.ok(!/API key/i.test(unexplained.message), unexplained.message);
});

/** The 403 body the API sends once the free plan's month is spent. */
const FREE_PLAN_USED_UP =
	'Free plan used up: 100 captures this month. It renews on 2026-11-30 (UTC). For more, choose a paid plan: https://www.site-shot.com/pricing/';

/**
 * The same refusal in the other wording the API may use; today it sends this
 * one.
 */
const OLD_TRIAL_USED_UP =
	'Free API trial used up: 100 captures this month. It renews on 2026-11-30 (UTC). For more, choose a plan: https://www.site-shot.com/pricing/';

/** Everything after the matched start is upstream text that must not leak. */
const UPSTREAM_TAIL = /100 captures|For more, choose a (paid )?plan:/;

test('HTTP 403 for a used-up free plan says so, in either wording, and is not a rejected key', () => {
	for (const [message, echoed] of [
		[FREE_PLAN_USED_UP, 'free plan used up'],
		[OLD_TRIAL_USED_UP, 'free api trial used up'],
		// Matched case-insensitively.
		[
			'FREE PLAN USED UP: 100 captures this month. It renews on 2026-11-30 (UTC).',
			'free plan used up',
		],
		[
			'free api trial used up: 100 captures this month. It renews on 2026-11-30 (UTC).',
			'free api trial used up',
		],
	]) {
		const err = failsWith('subscription_inactive', () =>
			extractCaptureImage({ statusCode: 403, body: { message } }),
		);
		assert.equal(err.httpCode, '403');
		// Our own words say "free plan" for both; only the matched start is
		// echoed, then the strictly matched renewal date.
		assert.equal(
			err.message,
			`The Site-Shot account's free plan is used up for this month (${echoed}). It renews on 2026-11-30 (UTC).`,
		);
		assert.ok(!/trial/i.test(err.message.replace(`(${echoed})`, '')), err.message);
		assert.ok(!/subscription/i.test(err.message), err.message);
		assert.ok(!/API key/i.test(err.message), err.message);
		assert.equal(
			err.description,
			'The key itself is valid. For more captures, choose a paid plan at https://www.site-shot.com/pricing/.',
		);
		assert.ok(!UPSTREAM_TAIL.test(err.message + err.description), err.message);
	}
});

test('the renewal date is taken from the free-plan text as the API gives it', () => {
	for (const [message, date] of [
		[
			'Free plan used up: 100 captures this month. It renews on 2027-01-31 (UTC). For more, choose a paid plan: https://www.site-shot.com/pricing/',
			'2027-01-31',
		],
		['Free plan used up: 2000 captures this month. It renews on 2026-12-01 (UTC).', '2026-12-01'],
		[
			'Free API trial used up: 100 captures this month. It renews on 2027-02-28 (UTC).',
			'2027-02-28',
		],
	]) {
		const err = failsWith('subscription_inactive', () =>
			extractCaptureImage({ statusCode: 403, body: { message } }),
		);
		assert.ok(err.message.endsWith(`It renews on ${date} (UTC).`), err.message);
		assert.ok(!/renews every month/i.test(err.description), err.description);
		assert.ok(!/2000 captures/.test(err.message), err.message);
	}
});

test('a used-up free plan without a well-formed renewal date says it renews every month', () => {
	for (const start of ['Free plan used up', 'Free API trial used up']) {
		for (const message of [
			`${start}: 100 captures this month.`,
			`${start}: 100 captures this month. It renews on 30.11.2026 (UTC).`,
			`${start}. It renews on 2026-11-30T00:00 (UTC).`,
			`${start}. It renews on 2026-11-30 <b>soon</b>.`,
			`${start}. it renews on 2026-11-30 (utc).`,
		]) {
			const err = failsWith('subscription_inactive', () =>
				extractCaptureImage({ statusCode: 403, body: { message } }),
			);
			assert.ok(/free plan is used up for this month/i.test(err.message), err.message);
			assert.ok(!/renews on/i.test(err.message), err.message);
			assert.equal(
				err.description,
				'The key itself is valid. The free plan renews every month; for more captures, choose a paid plan at https://www.site-shot.com/pricing/.',
			);
			assert.ok(!/2026|30\.11|100 captures|<b>/.test(err.message + err.description), err.message);
		}
	}
});

test('only a message that starts with a used-up wording is read as a used-up free plan', () => {
	for (const message of [
		'Your free plan used up: 100 captures this month.',
		'free plan',
		'free api trial',
		'Free plan: 100 captures this month.',
	]) {
		failsWith('access_refused', () => extractCaptureImage({ statusCode: 403, body: { message } }));
	}
});

test('an unexplained HTTP 403 is reported neutrally, without blaming billing or the key', () => {
	for (const body of [{}, { message: 'Forbidden' }, { error: 'subscription' }]) {
		const err = failsWith('access_refused', () => extractCaptureImage({ statusCode: 403, body }));
		assert.equal(err.httpCode, '403');
		assert.equal(
			err.message,
			'Site-Shot refused the capture (HTTP 403): the account may have no active subscription or its free plan may be used up for this month, or the address may not be allowed.',
		);
		assert.ok(!/API key/i.test(err.message), err.message);
		// It may be the address rather than billing, so it does not send the
		// user to buy a plan.
		assert.ok(!/pricing|choose a plan|buy/i.test(err.description), err.description);
	}
});

test('a refused target address is its own failure, not a billing or key problem', () => {
	for (const body of [
		{ error: 'Forbidden target address' },
		{ message: 'Forbidden target address' },
		{ error: 'FORBIDDEN TARGET ADDRESS: 10.1.2.3' },
	]) {
		const err = failsWith('target_not_allowed', () =>
			extractCaptureImage({ statusCode: 403, body }),
		);
		assert.equal(err.httpCode, '403');
		assert.ok(/does not capture this address/i.test(err.message), err.message);
		const text = `${err.message} ${err.description}`;
		assert.ok(!/subscription|trial|plan|pricing|API key/i.test(text), text);
		// Only the fixed prefix is echoed.
		assert.ok(!text.includes('10.1.2.3'), text);
	}
});

test('a country refused on the free plan names the paid plan, on the JSON-mode 200 and on a 403', () => {
	const refusal =
		'Geotargeting needs a paid plan: the free plan captures from the default location or the US. Plans: https://www.site-shot.com/pricing/';
	for (const [statusCode, body] of [
		// JSON mode, which this node always uses: HTTP 200, `error`, no image.
		[200, { error: refusal }],
		// Matched by the prefix alone, case-insensitively.
		[200, { error: 'GEOTARGETING NEEDS A PAID PLAN: something else entirely' }],
		// Image mode's 403.
		[403, { message: refusal }],
	]) {
		const err = failsWith('country_needs_paid_plan', () =>
			extractCaptureImage({ statusCode, body }),
		);
		assert.equal(err.httpCode, String(statusCode));
		assert.equal(
			err.message,
			'Site-Shot refused the capture: on the free plan, a capture from a country other than the US needs a paid plan (geotargeting needs a paid plan).',
		);
		assert.equal(
			err.description,
			"The key itself is valid. The refused request still counts toward the month's 100 free-plan captures. Paid plans start at $5/mo for 2,000: https://www.site-shot.com/pricing/.",
		);
		const text = `${err.message} ${err.description}`;
		assert.ok(!/trial|HTTP 403|API key|could not capture the page/i.test(text), text);
		assert.ok(!/default location|something else/.test(text), text);
	}
});

test('a known "no active subscription" 403 does not blame the free plan, and says where to switch it on', () => {
	const err = failsWith('subscription_inactive', () =>
		extractCaptureImage({ statusCode: 403, body: { message: 'No active subscription found' } }),
	);
	assert.equal(
		err.message,
		'The Site-Shot account has no active subscription (no active subscription found).',
	);
	assert.equal(
		err.description,
		'The key itself is valid. If the account has never had a paid plan, switch on the free plan at https://www.site-shot.com/start/; otherwise choose a paid plan at https://www.site-shot.com/pricing/.',
	);
	assert.ok(!/trial/i.test(err.message + err.description), err.message);
	assert.ok(!/reactivate/i.test(err.description), err.description);
});

test('HTTP 402 is a quota or payment failure', () => {
	failsWith('quota_or_payment', () =>
		extractCaptureImage({ statusCode: 402, body: { message: 'Payment required' } }),
	);
});

test('HTTP 429 is the one-capture-at-a-time limit, not quota or payment', () => {
	// The API answers 429 when the key already has a capture running (one at a
	// time on the free plan). It is refused before admission and not counted;
	// a spent monthly allowance is a 403 instead.
	for (const body of [{ message: 'API rate limit exceeded' }, {}, 'Too Many Requests']) {
		const err = failsWith('parallel_limit', () => extractCaptureImage({ statusCode: 429, body }));
		assert.equal(err.httpCode, '429');
		assert.ok(/one capture at a time/.test(err.description), err.description);
		assert.ok(/did not count/.test(err.description), err.description);
		assert.ok(!/quota|balance|payment/i.test(`${err.message} ${err.description}`), err.description);
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

test('the invalid-parameters advice names the options this node sends, not only the viewport', () => {
	const err = failsWith('invalid_parameters', () =>
		extractCaptureImage({ statusCode: 400, body: { message: 'Bad request' } }),
	);
	assert.ok(/viewport, delay, format/.test(err.description), err.description);
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
