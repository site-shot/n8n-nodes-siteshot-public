/**
 * Test-only harness. Builds a fake n8n execution context that exposes exactly
 * the seam the node is allowed to use: `helpers.httpRequestWithAuthentication`
 * and `helpers.prepareBinaryData`.
 *
 * The fake context touches nothing: no network, filesystem or environment.
 * The package-file helpers at the end only read this source tree and ask git
 * and npm for local file lists; they never contact a registry.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** Load the COMPILED node/credential, so tests run against shipped output. */
export function loadDist(relPath) {
	return require(new URL(`../dist/${relPath}`, import.meta.url).pathname);
}

/** The public node type: `<package name>.<node name>`. */
export const NODE_TYPE = 'n8n-nodes-siteshot.siteShot';

/** A real 1x1 PNG (signature + IHDR + IDAT + IEND). */
export const PNG_BYTES = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
);

/** A JPEG with a real SOI/APP0/EOI framing (not a full image, but correctly signed). */
export const JPEG_BYTES = Buffer.concat([
	Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
	Buffer.from('JFIF\0', 'ascii'),
	Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
	Buffer.from([0xff, 0xd9]),
]);

export const PNG_B64 = PNG_BYTES.toString('base64');
export const JPEG_B64 = JPEG_BYTES.toString('base64');

/**
 * Synthetic secrets. Tests assert these markers never reach an error, an
 * output item or a log, so they must not look like anything else.
 */
export const SECRET_KEY = 'SYNTHETIC-USERKEY-a1b2c3d4e5f6';
export const SECRET_TARGET_TOKEN = 'SYNTHETIC-TARGET-TOKEN-9z8y7x';

/**
 * The real capture-failure envelope (HTTP 200 + `error` + placeholder image),
 * as pinned by site-shot-sdk/test/sdk.test.mjs.
 */
export function appErrorEnvelope(message, internalStatus, image = PNG_B64) {
	return {
		screenshot_parameters: {
			format: 'png',
			request_headers: [],
			response_type: 'json',
			url: 'https://example.com/',
			width: 1024,
			height: 768,
			zoom: 100,
			full_size: '0',
			no_ads: 0,
			no_cookie_popup: 0,
			source_code: 0,
			proxy_rotation: '1',
		},
		response: { status_code: internalStatus, headers: [] },
		image: `data:image/png;base64,${image}`,
		error: message,
	};
}

/** Shape of what n8n's httpRequest returns with `returnFullResponse: true`. */
export function fullResponse(body, statusCode = 200, headers = { 'content-type': 'application/json' }) {
	return { body, statusCode, headers };
}

/**
 * Build a fake IExecuteFunctions.
 *
 * @param {object} opts
 * @param {object[]} opts.items          input items (default: one empty item)
 * @param {object}   opts.params         node parameter values
 * @param {Function|Array} opts.transport what httpRequestWithAuthentication does
 * @param {boolean}  opts.continueOnFail
 */
export function createExecuteContext({
	items = [{ json: {} }],
	params = {},
	transport,
	continueOnFail = false,
} = {}) {
	const httpCalls = [];
	const binaryCalls = [];
	const logs = [];

	const replies = Array.isArray(transport) ? [...transport] : null;

	const ctx = {
		httpCalls,
		binaryCalls,
		logs,

		getInputData(itemIndex) {
			return itemIndex === undefined ? items : [items[itemIndex]];
		},

		getNodeParameter(name, itemIndex, fallback) {
			const raw = params[name];
			const value = typeof raw === 'function' ? raw(itemIndex) : raw;
			if (value === undefined) {
				if (fallback === undefined) {
					throw new Error(`test harness: no value configured for parameter "${name}"`);
				}
				return fallback;
			}
			return value;
		},

		getNode() {
			return { id: 'test-node-id', name: 'Site-Shot', type: NODE_TYPE, typeVersion: 1, position: [0, 0], parameters: {} };
		},

		continueOnFail() {
			return continueOnFail;
		},

		logger: {
			debug: (...a) => logs.push(['debug', ...a]),
			info: (...a) => logs.push(['info', ...a]),
			warn: (...a) => logs.push(['warn', ...a]),
			error: (...a) => logs.push(['error', ...a]),
		},

		helpers: {
			async httpRequestWithAuthentication(credentialsType, requestOptions, additional) {
				httpCalls.push({ credentialsType, requestOptions, additional });
				const reply = replies
					? (replies.length > 1 ? replies.shift() : replies[0])
					: transport;
				if (typeof reply === 'function') return await reply(requestOptions, httpCalls.length - 1);
				if (reply instanceof Error) throw reply;
				return reply;
			},

			async prepareBinaryData(buffer, fileName, mimeType) {
				binaryCalls.push({ buffer, fileName, mimeType });
				return {
					data: buffer.toString('base64'),
					mimeType,
					fileName,
					fileExtension: fileName?.split('.').pop(),
					fileSize: `${buffer.length} B`,
				};
			},
		},
	};

	// `helpers.*` are invoked with `.call(this, ...)` by nodes, so keep `this` usable.
	ctx.helpers.httpRequestWithAuthentication = ctx.helpers.httpRequestWithAuthentication.bind(ctx);
	ctx.helpers.prepareBinaryData = ctx.helpers.prepareBinaryData.bind(ctx);

	return ctx;
}

/** Everything a thrown error could carry, flattened to one searchable string. */
export function serializeError(err) {
	const parts = [
		err?.message,
		err?.description,
		err?.stack,
		safeJson(err),
		safeJson(err?.errorResponse),
		safeJson(err?.context),
		safeJson(err?.cause),
		safeJson(err?.messages),
		typeof err?.toJSON === 'function' ? safeJson(err.toJSON()) : '',
	];
	return parts.filter(Boolean).join(' | ');
}

function safeJson(value) {
	if (value === undefined || value === null) return '';
	try {
		const seen = new WeakSet();
		return JSON.stringify(value, (_k, v) => {
			if (typeof v === 'object' && v !== null) {
				if (seen.has(v)) return '[circular]';
				seen.add(v);
			}
			if (typeof v === 'bigint') return v.toString();
			return v;
		});
	} catch {
		return String(value);
	}
}

// --- Package files ------------------------------------------------------------

/** The package root: the directory holding package.json. */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Parse a JSON file given relative to the package root. */
export function readJson(relPath) {
	return JSON.parse(readFileSync(join(PACKAGE_ROOT, relPath), 'utf8'));
}

/**
 * Every source file that belongs to the repository: tracked files plus new,
 * not-ignored ones — what a commit of the working tree would contain. Build
 * output, installed dependencies and local runtime state are ignored by
 * .gitignore; a tracked file deleted from the working tree has no content left
 * to check.
 */
export function sourceFiles() {
	const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
		cwd: PACKAGE_ROOT,
		encoding: 'utf8',
	});
	return [...new Set(out.split('\0').filter(Boolean))]
		.filter((path) => existsSync(join(PACKAGE_ROOT, path)))
		.sort();
}

/**
 * Scripts npm runs by itself: on install, or while packing — `npm pack` runs
 * prepack, prepare and postpack even as a dry run. The package defines none.
 */
export const LIFECYCLE_SCRIPTS = [
	'prepare',
	'preinstall',
	'install',
	'postinstall',
	'prepublish',
	'preprepare',
	'postprepare',
	'prepack',
	'postpack',
];

export function assertNoLifecycleScripts(manifest) {
	for (const name of LIFECYCLE_SCRIPTS) {
		assert.ok(!(name in (manifest.scripts ?? {})), `package.json defines a "${name}" script`);
	}
}

/**
 * What `npm pack` would put in the tarball for the package in `dir`, as sorted
 * relative paths. A dry run: nothing is written, and with the update check off
 * no registry is contacted. A package with a lifecycle script is refused before
 * npm is invoked, so that script never runs.
 */
export function packedFiles(dir = PACKAGE_ROOT) {
	assertNoLifecycleScripts(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')));
	const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--update-notifier=false'], {
		cwd: dir,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const [report] = JSON.parse(out);
	return report.files.map((f) => f.path).sort();
}

/**
 * Classes of workstation-only or private detail that must not reach a public
 * file. They name no private host or path, so the guard itself discloses
 * nothing; a private host in a URL is caught by foreignUrlHosts instead.
 * Written as patterns so this file does not match itself.
 */
export const PRIVATE_MARKERS = [
	/\/Users\/[^/\s]/, // a macOS home directory
	/[A-Za-z]:\\Users\\/, // a Windows home directory
	/\/var\/folders\//, // a macOS temporary directory
	/(?<![\w-])(?!(?:project|absent)\/)[\w-]+\/\.venv\//, // a named project's interpreter; project/ and absent/ are the documented placeholders
	/\bgit@[A-Za-z0-9.-]+:/, // an SSH remote
];

/**
 * The hosts a public file may name in a URL: the services this package, its
 * documentation and its icons refer to, plus loopback. Names reserved for
 * examples and tests (RFC 2606, RFC 6761) are allowed by their suffix.
 */
const PUBLIC_HOSTS = new Set([
	'site-shot.com',
	'www.site-shot.com',
	'api.site-shot.com',
	'github.com',
	'n8n.io',
	'docs.n8n.io',
	'docs.npmjs.com',
	'www.npmjs.com',
	'registry.npmjs.org',
	'nodejs.org',
	'prettier.io',
	'www.w3.org',
	'localhost',
]);
const RESERVED_HOST = /(^|\.)(example|invalid|test|localhost)$|^example\.(com|net|org)$|^127(\.\d{1,3}){3}$/;

/**
 * Hosts named in URLs in `text` that are neither public nor reserved. A name
 * without a dot is a placeholder in a test, not a host anyone can reach, and
 * is skipped; every IP address but loopback counts.
 */
export function foreignUrlHosts(text) {
	const hosts = new Set();
	for (const [, host] of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@"'`)<>]*@)?([A-Za-z0-9.-]+)/g)) {
		const name = host.toLowerCase().replace(/\.+$/, '');
		if (!name.includes('.') || PUBLIC_HOSTS.has(name) || RESERVED_HOST.test(name)) continue;
		hosts.add(name);
	}
	return [...hosts].sort();
}
