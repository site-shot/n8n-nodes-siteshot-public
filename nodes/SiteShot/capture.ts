/**
 * Site-Shot platform adapter.
 *
 * Pure request/response logic written against the published API contract
 * (see README "API contract and evidence"). It performs no I/O, touches no
 * filesystem or environment, and never holds the credential: `userkey` is
 * injected by the Site-Shot credential, never by this module.
 *
 * Redaction rule enforced throughout: a failure carries a fixed, safe message
 * of our own plus the HTTP status. Upstream text is echoed only when it is an
 * exact match for a reason proven by the published API contract.
 */

/** The single supported endpoint. Deliberately not configurable. */
export const API_ENDPOINT = 'https://api.site-shot.com/';

export const CREDENTIALS_NAME = 'siteShotApi';

/**
 * Client-side deadline handed to the n8n HTTP helper. Mirrors the SDK's
 * budget: the API's own default render deadline (60s) plus 30s of headroom so
 * the server gets to answer first.
 */
export const REQUEST_TIMEOUT_MS = 90_000;

/**
 * Largest screenshot this node will decode, in bytes. The payload arrives
 * base64-encoded inside the JSON body, so this is checked against the encoded
 * string *before* decoding, to avoid materialising a second oversized buffer.
 *
 * This is a decode guard, not a network cap: `IHttpRequestOptions` exposes no
 * `maxContentLength`, so the transport has already buffered the body by the
 * time this runs. See README "Known limitations".
 */
export const MAX_IMAGE_BYTES = 33_554_432; // 32 MiB

/** Viewport bounds accepted by the API, as validated by site-shot-sdk. */
export const VIEWPORT_LIMITS = {
	width: { min: 100, max: 8000 },
	height: { min: 100, max: 20000 },
} as const;

export const IMAGE_FORMATS = {
	png: {
		mimeType: 'image/png',
		fileName: 'screenshot.png',
		label: 'PNG',
		/** \x89PNG\r\n\x1a\n */
		signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
		dataUrlTypes: ['image/png'],
	},
	jpeg: {
		mimeType: 'image/jpeg',
		fileName: 'screenshot.jpg',
		label: 'JPEG',
		/** SOI + first marker byte */
		signature: [0xff, 0xd8, 0xff],
		dataUrlTypes: ['image/jpeg', 'image/jpg'],
	},
} as const;

export type ImageFormat = keyof typeof IMAGE_FORMATS;

export interface CaptureOptions {
	format?: ImageFormat;
	fullPage?: boolean;
	width?: number;
	height?: number;
}

/** Machine-readable failure reasons. Stable contract for tests and callers. */
export type CaptureFailureReason =
	| 'invalid_url'
	| 'invalid_options'
	| 'invalid_api_key'
	| 'subscription_inactive'
	| 'quota_or_payment'
	| 'country_unavailable'
	| 'invalid_parameters'
	| 'upstream_timeout'
	| 'api_unavailable'
	| 'capture_failed'
	| 'unexpected_response'
	| 'no_image'
	| 'malformed_image'
	| 'format_mismatch'
	| 'response_too_large'
	| 'request_timeout'
	| 'transport_error'
	| 'request_failed';

/**
 * A capture failure that is safe to surface.
 *
 * Carries only text this module produced, plus the HTTP status. It never
 * references the request, the credential, the target URL or the response body.
 */
export class CaptureFailure extends Error {
	readonly reason: CaptureFailureReason;

	readonly httpCode?: string;

	readonly description?: string;

	constructor(
		reason: CaptureFailureReason,
		message: string,
		options: { httpCode?: number | string; description?: string } = {},
	) {
		super(message);
		this.name = 'CaptureFailure';
		this.reason = reason;
		if (options.httpCode !== undefined) this.httpCode = String(options.httpCode);
		if (options.description !== undefined) this.description = options.description;
	}
}

/**
 * Upstream reason strings proven by the published API contract, and therefore
 * safe to echo verbatim. Everything else is replaced by our own wording.
 *
 * Provenance: site-shot-sdk/src/client.ts (`country_unavailable` is the
 * documented public contract) and site-shot-sdk/test/sdk.test.mjs (live 401
 * and derived 403 envelopes).
 */
const ALLOWED_UPSTREAM_REASONS = new Set([
	'country_unavailable',
	'invalid authentication credentials',
	'no api key found in request',
	'no active subscription found',
]);


/**
 * Detect C0/C7 control characters.
 *
 * Done by char code rather than by regex: a literal control range inside a
 * regex is both unreadable and flagged by `no-control-regex`.
 */
function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function asNonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse without throwing, so no `throw` ever sits inside a catch clause. */
function parseUrl(raw: string): URL | null {
	try {
		return new URL(raw);
	} catch {
		return null;
	}
}

/**
 * Validate an explicit public web address.
 *
 * Schemes are never rewritten. The SDK prepends `https://` to bare domains,
 * but the API's own default is `http`, so guessing here would silently
 * capture a different page than the user asked for.
 */
export function validateTargetUrl(raw: unknown): string {
	const invalid = (detail: string) =>
		new CaptureFailure('invalid_url', `The URL parameter ${detail}.`, {
			description:
				'Enter the full address of a public page, including the scheme — for example https://example.com/pricing.',
		});

	if (typeof raw !== 'string') throw invalid('must be a text value');

	const trimmed = raw.trim();
	if (!trimmed) throw invalid('is empty');
	if (hasControlCharacters(trimmed)) throw invalid('contains control characters');
	if (!/^https?:\/\//i.test(trimmed)) throw invalid('must start with http:// or https://');

	const parsed = parseUrl(trimmed);
	if (parsed === null) throw invalid('is not a valid URL');
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw invalid('must start with http:// or https://');
	}
	if (!parsed.hostname) throw invalid('has no host name');
	if (parsed.username || parsed.password) throw invalid('must not embed credentials');

	return trimmed;
}

/** Validate the optional viewport numbers against the API's accepted ranges. */
export function validateViewport(options: CaptureOptions): void {
	for (const axis of ['width', 'height'] as const) {
		const value = options[axis];
		if (value === undefined) continue;
		const { min, max } = VIEWPORT_LIMITS[axis];
		if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
			throw new CaptureFailure(
				'invalid_options',
				`Viewport ${axis} must be a whole number between ${min} and ${max}.`,
			);
		}
	}
}

/**
 * Build the query for one capture.
 *
 * `userkey` and `response_type` are owned here: `response_type` is pinned to
 * `json` and `userkey` is never written, so no node parameter can reach
 * either. Options the user left unset are omitted so the API keeps applying
 * its own documented defaults.
 */
export function buildCaptureQuery(
	url: string,
	options: CaptureOptions = {},
): Record<string, string | number> {
	const query: Record<string, string | number> = {
		url,
		response_type: 'json',
		format: options.format ?? 'png',
	};

	if (options.fullPage === true) query.full_size = 1;
	if (options.width !== undefined) query.width = options.width;
	if (options.height !== undefined) query.height = options.height;

	return query;
}

/**
 * Map a status plus an upstream reason onto a safe, actionable failure.
 *
 * Mirrors site-shot-sdk's taxonomy, with its two load-bearing distinctions
 * preserved: 401 means the key was rejected, 403 means the subscription is
 * inactive, and the word "forbidden" in an upstream capture error is never
 * read as a key problem (a failing target page reports its own status line
 * verbatim, so `error` can read "403 Forbidden" on an otherwise-200 response).
 */
function classifyFailure(statusCode: number, upstreamReason?: string): CaptureFailure {
	const lower = (upstreamReason ?? '').toLowerCase().trim();
	const echo = ALLOWED_UPSTREAM_REASONS.has(lower) ? ` (${lower})` : '';
	const httpCode = statusCode;

	if (lower === 'country_unavailable') {
		return new CaptureFailure(
			'country_unavailable',
			`Site-Shot has no capacity in the requested country right now (country_unavailable).`,
			{ httpCode, description: 'Try again later.' },
		);
	}

	if (statusCode === 401 || /userkey|api.?key|invalid key|unauthoriz|authenticat/.test(lower)) {
		return new CaptureFailure('invalid_api_key', `Site-Shot rejected the API key${echo}.`, {
			httpCode,
			description:
				'Check the API key on the Site-Shot credential. Keys are issued at https://www.site-shot.com/pricing/.',
		});
	}

	if (statusCode === 403) {
		return new CaptureFailure(
			'subscription_inactive',
			`The Site-Shot account has no active subscription${echo}.`,
			{
				httpCode,
				description:
					'The key itself is valid. Reactivate the plan at https://www.site-shot.com/pricing/.',
			},
		);
	}

	if (
		statusCode === 402 ||
		statusCode === 429 ||
		/quota|limit exceed|payment|credit|subscription/.test(lower)
	) {
		return new CaptureFailure(
			'quota_or_payment',
			'Site-Shot refused the capture for quota or payment reasons.',
			{ httpCode, description: 'Check the plan balance and limits on the Site-Shot account.' },
		);
	}

	if (statusCode === 400 || /invalid|out of range|must be|unsupported/.test(lower)) {
		return new CaptureFailure(
			'invalid_parameters',
			'Site-Shot rejected the capture parameters.',
			{ httpCode, description: 'Check the URL and the viewport options on this node.' },
		);
	}

	if (/time.?out|timed out/.test(lower)) {
		return new CaptureFailure('upstream_timeout', 'Site-Shot timed out while rendering the page.', {
			httpCode,
			description: 'The target page took too long to render. Try again, or try a simpler page.',
		});
	}

	if (statusCode >= 500) {
		return new CaptureFailure('api_unavailable', 'The Site-Shot API is currently unavailable.', {
			httpCode,
			description: 'This is an upstream failure. Try again later.',
		});
	}

	return new CaptureFailure('capture_failed', 'Site-Shot could not capture the page.', {
		httpCode,
		description:
			'The API accepted the request but the capture failed. Check that the page is publicly reachable.',
	});
}

/**
 * Pull the image payload out of a full HTTP response, or fail.
 *
 * The ordering is the contract:
 *  1. A non-empty top-level `error` wins on ANY status. A failure during
 *     capture answers HTTP 200 with a placeholder error image alongside
 *     `error`, so checking it first is what stops that placeholder being
 *     handed back as a screenshot.
 *  2. Only then does a non-2xx status get mined for `message`.
 *  3. `message` on a successful 2xx is metadata and never an error.
 */
export function extractCaptureImage(response: { statusCode: unknown; body: unknown }): string {
	const { statusCode, body } = response;

	// Without a status there is nothing to classify against, and a bare body
	// must never be read as a success.
	if (typeof statusCode !== 'number' || !Number.isFinite(statusCode)) {
		throw new CaptureFailure(
			'unexpected_response',
			'Site-Shot returned a response that was not the expected JSON capture result.',
			{ description: 'The response carried no HTTP status, so it was discarded. Try again.' },
		);
	}

	const ok = statusCode >= 200 && statusCode < 300;

	if (!isPlainObject(body)) {
		if (!ok) throw classifyFailure(statusCode);
		throw new CaptureFailure(
			'unexpected_response',
			'Site-Shot returned a response that was not the expected JSON capture result.',
			{ httpCode: statusCode, description: 'Try again later.' },
		);
	}

	const upstreamError = asNonEmptyString(body.error);
	if (upstreamError) throw classifyFailure(statusCode, upstreamError);

	if (!ok) throw classifyFailure(statusCode, asNonEmptyString(body.message));

	const image = asNonEmptyString(body.image);
	if (image === undefined) {
		throw new CaptureFailure(
			'no_image',
			'Site-Shot returned a successful response that contained no image.',
			{ httpCode: statusCode, description: 'Try again later.' },
		);
	}

	return image;
}

/** Strip a `data:` prefix, checking that any declared type matches the request. */
function stripDataUrlPrefix(image: string, format: ImageFormat): string {
	if (!image.startsWith('data:')) return image;

	const comma = image.indexOf(',');
	if (comma === -1) return image;

	const declared = image.slice(5, comma).split(';')[0].trim().toLowerCase();
	const accepted: readonly string[] = IMAGE_FORMATS[format].dataUrlTypes;
	if (declared && !accepted.includes(declared)) {
		throw new CaptureFailure(
			'format_mismatch',
			`Site-Shot returned an image that is not ${IMAGE_FORMATS[format].label}.`,
			{ description: 'Re-run the capture, or switch the Format option to match.' },
		);
	}

	return image.slice(comma + 1);
}

/**
 * Decode and verify the screenshot bytes.
 *
 * A created binary file is not proof of a capture: Node's base64 decoder
 * silently skips invalid characters, so a truncated or malformed payload would
 * otherwise become a short buffer posing as a screenshot. Both the encoding
 * and the format signature are checked before anything is handed downstream.
 */
export function decodeCaptureImage(rawImage: string, format: ImageFormat): Buffer {
	const spec = IMAGE_FORMATS[format];
	const malformed = (detail: string) =>
		new CaptureFailure('malformed_image', `Site-Shot returned ${detail}.`, {
			description: 'Nothing usable was returned, so no binary file was produced. Try again.',
		});

	const payload = stripDataUrlPrefix(rawImage, format).replace(/\s+/g, '');

	if (!payload) throw malformed('an empty image payload');

	// Checked before decoding: the encoded form is already in memory, and
	// decoding would allocate a second buffer of ~3/4 that size.
	const maxEncodedLength = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
	if (payload.length > maxEncodedLength) {
		throw new CaptureFailure(
			'response_too_large',
			`Site-Shot returned an image larger than the ${Math.round(
				MAX_IMAGE_BYTES / (1024 * 1024),
			)} MiB this node accepts.`,
			{
				description:
					'Reduce the viewport size or turn off Full Page. The response was discarded without decoding.',
			},
		);
	}

	if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
		throw malformed('a malformed base64 image payload');
	}

	const buffer = Buffer.from(payload, 'base64');
	const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
	const expectedLength = (payload.length / 4) * 3 - padding;
	if (buffer.length === 0 || buffer.length !== expectedLength) {
		throw malformed('a truncated base64 image payload');
	}

	const signature = spec.signature;
	if (buffer.length < signature.length) {
		throw new CaptureFailure(
			'format_mismatch',
			`Site-Shot returned an image that is not ${spec.label}.`,
			{ description: 'Re-run the capture, or switch the Format option to match.' },
		);
	}
	for (let i = 0; i < signature.length; i++) {
		if (buffer[i] !== signature[i]) {
			throw new CaptureFailure(
				'format_mismatch',
				`Site-Shot returned an image that is not ${spec.label}.`,
				{ description: 'Re-run the capture, or switch the Format option to match.' },
			);
		}
	}

	return buffer;
}

/**
 * Transport-level failure codes that are safe to name.
 *
 * These are Node/OS connection codes, not upstream text: they carry no
 * credential, no target and no request detail. n8n's own error layer maps the
 * same set to human wording (see `COMMON_ERRORS` in n8n-workflow's
 * `node.error.ts`), which is why they are only ever placed in the
 * `description` — a message containing one would be rewritten by that layer.
 */
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);

const NETWORK_CODES = new Set([
	'ECONNREFUSED',
	'ECONNRESET',
	'ENOTFOUND',
	'EAI_AGAIN',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'EPIPE',
	'EPROTO',
	'CERT_HAS_EXPIRED',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

function readStringField(value: unknown, field: string): string | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const raw = (value as Record<string, unknown>)[field];
	return typeof raw === 'string' ? raw : undefined;
}

/**
 * Find a connection code on an error or on its causes.
 *
 * axios puts the code on the error itself; `fetch` reports `TypeError: fetch
 * failed` and hides the real code one level down in `cause`. The walk is
 * depth-bounded and reads nothing but `code`.
 */
function readErrorCode(error: unknown): string | undefined {
	let current = error;
	for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth++) {
		const code = readStringField(current, 'code');
		if (code) return code;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

/** Same bounded walk, for the abort/timeout marker `fetch` and axios both use. */
function readErrorName(error: unknown): string | undefined {
	let current = error;
	for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth++) {
		const name = readStringField(current, 'name');
		if (name === 'AbortError' || name === 'TimeoutError') return name;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

/**
 * Turn a thrown transport error into a safe failure.
 *
 * Only the error's `code` and `name` are read, and only against a fixed
 * allowlist. The error's own `message`, `config` and `response` are never
 * touched: an axios error embeds the full request URL — `userkey` included —
 * in all three.
 */
export function describeTransportFailure(error: unknown): CaptureFailure {
	const code = readErrorCode(error);
	const name = readErrorName(error);

	if (name !== undefined || (code && TIMEOUT_CODES.has(code))) {
		return new CaptureFailure(
			'request_timeout',
			`The Site-Shot request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`,
			{
				description:
					'The capture was not retried, because a completed render still costs quota. Try a simpler page, or a smaller viewport.',
			},
		);
	}

	if (code && NETWORK_CODES.has(code)) {
		return new CaptureFailure('transport_error', 'Could not reach the Site-Shot API.', {
			description: `The connection failed (${code}). Check that this n8n instance can reach api.site-shot.com.`,
		});
	}

	return new CaptureFailure('request_failed', 'The Site-Shot request could not be completed.', {
		description:
			'Check that the Site-Shot credential is set on this node and that this n8n instance can reach api.site-shot.com.',
	});
}

/** Classify anything thrown while capturing one item into a safe failure. */
export function toCaptureFailure(error: unknown): CaptureFailure {
	return error instanceof CaptureFailure ? error : describeTransportFailure(error);
}
