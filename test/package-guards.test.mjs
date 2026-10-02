/**
 * Static guards on the package: no runtime dependencies, no runtime filesystem
 * or environment access, no embedded secrets, no configurable host, no SDK
 * clone and no operations beyond the single documented capture — plus the
 * public package identity, the accepted dependency graph and the release
 * barrier that stays in place until the first publication is set up.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
	NODE_TYPE,
	PACKAGE_ROOT,
	PRIVATE_MARKERS,
	assertNoLifecycleScripts,
	createExecuteContext,
	foreignUrlHosts,
	loadDist,
	readJson,
	sourceFiles,
} from './helpers.mjs';

const pkg = readJson('package.json');

/** Every runtime source file — what actually ships inside dist/. */
function runtimeSources() {
	return sourceFiles()
		.filter((path) => /^(nodes|credentials)\/.*\.ts$/.test(path))
		.map((path) => {
			const source = readFileSync(join(PACKAGE_ROOT, path), 'utf8');
			return {
				path,
				source,
				// Comments cannot clone code or leak a key at runtime, but they do
				// carry provenance notes that name the SDK. Guards that are about
				// what the code *does* run against this stripped form.
				code: stripComments(source),
			};
		});
}

/** Remove block and line comments. Good enough for this codebase's own files. */
function stripComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const sources = runtimeSources();

test('the package declares no runtime dependencies', () => {
	assert.deepEqual(pkg.dependencies ?? {}, {});
	assert.deepEqual(Object.keys(pkg.peerDependencies ?? {}), ['n8n-workflow']);
});

test('runtime code imports nothing but n8n-workflow and its own modules', () => {
	const importPattern = /(?:from\s+|require\()\s*['"]([^'"]+)['"]/g;
	for (const { path, source } of sources) {
		for (const [, specifier] of source.matchAll(importPattern)) {
			const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
			assert.ok(
				isRelative || specifier === 'n8n-workflow',
				`${path} imports "${specifier}"`,
			);
		}
	}
});

test('runtime code touches no filesystem, process or child process', () => {
	const banned = [
		'node:fs',
		'node:os',
		'node:path',
		'node:child_process',
		'child_process',
		'process.env',
		'readFile',
		'writeFile',
		'__dirname',
		'__filename',
	];
	for (const { path, source } of sources) {
		for (const needle of banned) {
			assert.ok(!source.includes(needle), `${path} references "${needle}"`);
		}
	}
});

test('runtime code writes nothing to the console', () => {
	for (const { path, source } of sources) {
		assert.ok(!/\bconsole\s*\./.test(source), `${path} uses console`);
	}
});

test('the endpoint is a fixed constant with no configurable host', () => {
	const { API_ENDPOINT } = loadDist('nodes/SiteShot/capture.js');
	assert.equal(API_ENDPOINT, 'https://api.site-shot.com/');

	const declared = JSON.stringify(new (loadDist('nodes/SiteShot/SiteShot.node.js').SiteShot)().description);
	for (const forbidden of ['baseUrl', 'baseURL', 'host', 'endpoint', 'domain', 'server']) {
		assert.ok(!declared.includes(forbidden), `node exposes a "${forbidden}" parameter`);
	}
});

test('no credential value is embedded in the source', () => {
	// A Site-Shot key is a long opaque token. The only literal allowed next to
	// `userkey` / `apiKey` is an n8n expression (`={{ ... }}`), which resolves
	// from the credential store at runtime and holds no secret itself.
	const assignment = /(userkey|api[_-]?key)\s*[:=]\s*(['"`])([^'"`]{8,})\2/gi;
	for (const { path, code } of sources) {
		for (const [, field, , literal] of code.matchAll(assignment)) {
			assert.ok(
				literal.startsWith('={{') && literal.endsWith('}}'),
				`${path} assigns a literal value to ${field}: ${literal.slice(0, 16)}…`,
			);
		}
	}
});

test('the node exposes exactly one capture action and no extra operations', () => {
	const { SiteShot } = loadDist('nodes/SiteShot/SiteShot.node.js');
	const { properties } = new SiteShot().description;

	assert.deepEqual(
		properties.map((p) => p.name),
		['url', 'binaryPropertyName', 'options'],
	);
	assert.deepEqual(
		properties.find((p) => p.name === 'options').options.map((o) => o.name).sort(),
		['format', 'fullPage', 'height', 'width'],
	);
	assert.ok(!properties.some((p) => p.name === 'resource' || p.name === 'operation'));
});

test('the node exposes no header, JavaScript, proxy or free-form query inputs', () => {
	const declared = JSON.stringify(new (loadDist('nodes/SiteShot/SiteShot.node.js').SiteShot)().description);
	for (const forbidden of [
		'request_header',
		'requestHeaders',
		'javascript',
		'javascript_code',
		'proxy',
		'http_proxy',
		'country',
		'queryParameters',
	]) {
		assert.ok(!declared.includes(forbidden), `node exposes "${forbidden}"`);
	}
});

test('the package neither depends on nor vendors site-shot-sdk', () => {
	for (const { path, code } of sources) {
		assert.ok(!code.includes('site-shot-sdk'), `${path} loads the SDK at runtime`);
		// The SDK's own client surface must not be re-implemented here.
		for (const sdkSymbol of ['captureBase64', 'captureToFile', 'captureJson', 'buildUrl']) {
			assert.ok(!code.includes(sdkSymbol), `${path} reproduces SDK method ${sdkSymbol}`);
		}
	}
	assert.ok(!('site-shot-sdk' in (pkg.dependencies ?? {})));
	assert.ok(!('site-shot-sdk' in (pkg.devDependencies ?? {})));
	assert.ok(!('site-shot-sdk' in (pkg.peerDependencies ?? {})));
});

test('the package registers exactly the one node and the one credential', () => {
	assert.deepEqual(pkg.n8n.nodes, ['dist/nodes/SiteShot/SiteShot.node.js']);
	assert.deepEqual(pkg.n8n.credentials, ['dist/credentials/SiteShotApi.credentials.js']);
	assert.equal(pkg.n8n.n8nNodesApiVersion, 1);
});

test('the package metadata matches the community-node conventions', () => {
	assert.ok(pkg.name.startsWith('n8n-nodes-'));
	assert.ok(pkg.keywords.includes('n8n-community-node-package'));
	assert.deepEqual(pkg.files, ['dist']);
	assert.equal(pkg.license, 'MIT');
});

test('no lifecycle script can run on install or rewrite the tarball as it is packed', () => {
	assertNoLifecycleScripts(pkg);
});

// --- Public identity ---------------------------------------------------------

const PACKAGE_NAME = 'n8n-nodes-siteshot';
// The proposed new public repository; package.json, the README and the stage
// workflow's repository check must all agree with it.
const REPOSITORY = 'https://github.com/site-shot/n8n-nodes-siteshot-public';

test('the package is n8n-nodes-siteshot in the manifest, lockfile, descriptor and test harness', () => {
	assert.equal(pkg.name, PACKAGE_NAME);
	const lock = readJson('package-lock.json');
	assert.equal(lock.name, PACKAGE_NAME);
	assert.equal(lock.packages[''].name, PACKAGE_NAME);
	assert.equal(readJson('nodes/SiteShot/SiteShot.node.json').node, `${PACKAGE_NAME}.siteShot`);
	assert.equal(NODE_TYPE, `${PACKAGE_NAME}.siteShot`);
	assert.equal(createExecuteContext().getNode().type, NODE_TYPE);
});

test('the internal node and credential identifiers are unchanged', () => {
	const node = new (loadDist('nodes/SiteShot/SiteShot.node.js').SiteShot)().description;
	assert.equal(node.name, 'siteShot');
	assert.deepEqual(node.credentials.map((c) => c.name), ['siteShotApi']);
	assert.equal(new (loadDist('credentials/SiteShotApi.credentials.js').SiteShotApi)().name, 'siteShotApi');
});

test('the repository and issue tracker are the public GitHub project', () => {
	assert.deepEqual(pkg.repository, { type: 'git', url: `git+${REPOSITORY}.git` });
	assert.deepEqual(pkg.bugs, { url: `${REPOSITORY}/issues` });
});

test('no source file still names the local package', () => {
	const stale = /n8n-nodes-siteshot-[l]ocal/; // a pattern, so this file does not match itself
	for (const path of sourceFiles()) {
		assert.ok(!stale.test(readFileSync(join(PACKAGE_ROOT, path), 'utf8')), `${path} names the local package`);
	}
});

test('no source file carries a private or workstation-only path', () => {
	for (const path of sourceFiles()) {
		const text = readFileSync(join(PACKAGE_ROOT, path), 'utf8');
		for (const marker of PRIVATE_MARKERS) assert.ok(!marker.test(text), `${path} matches ${marker}`);
	}
});

test('no source file names a host outside the public list in a URL', () => {
	// The lockfile is registry metadata of the dependencies, held by its graph digest below.
	for (const path of sourceFiles().filter((file) => file !== 'package-lock.json')) {
		const text = readFileSync(join(PACKAGE_ROOT, path), 'utf8');
		assert.deepEqual(foreignUrlHosts(text), [], `${path} names a host outside the public list`);
	}
});

test('the private-detail guards catch each class and let the public forms through', () => {
	// Built from pieces, so this file does not carry what it describes.
	const caught = [
		['', 'Users', 'someone', 'project'].join('/'),
		['C:', 'Users', 'someone', ''].join('\\'),
		['', 'private', 'var', 'folders', 'xy', 'T', 'tmp'].join('/'),
		['srv', 'web-app', '.venv', 'bin', 'python'].join('/'),
		`git${'@'}git.internal-corp.net:group/repo.git`,
	];
	for (const text of caught) assert.ok(PRIVATE_MARKERS.some((m) => m.test(text)), `not caught: ${text}`);
	const fine = ['dist/nodes/SiteShot/SiteShot.node.js', '/home/node/.n8n', 'project/.venv/bin/python',
		'/absolute/path/to/project/.venv/bin/python', 'absent/.venv/bin/python', 'runtime-fixture/runtime-gate.sh'];
	for (const text of fine) assert.ok(!PRIVATE_MARKERS.some((m) => m.test(text)), `flagged: ${text}`);

	const https = `https:${'//'}`;
	assert.deepEqual(
		foreignUrlHosts(`${https}git.internal-corp.net/group/repo ${https}user:pw@build.corp-ci.ru:8443/x http:${'//'}10.1.0.5/`),
		['10.1.0.5', 'build.corp-ci.ru', 'git.internal-corp.net'],
	);
	const allowed = [`${https}www.site-shot.com/start/`, `${https}api.site-shot.com/v1.0/credential-check`,
		`${REPOSITORY}/issues`, `${https}docs.n8n.io/x`, `${https}target.example/a`, `${https}example.com`,
		`http:${'//'}127.0.0.1:5678/`, `${https}redirect-sink.test/`, `${https}evil/placeholder`];
	assert.deepEqual(foreignUrlHosts(allowed.join(' ')), []);
});

// --- Lockfile ------------------------------------------------------------------

test('the lockfile root mirrors the manifest', () => {
	const lock = readJson('package-lock.json');
	assert.equal(lock.lockfileVersion, 3);
	assert.equal(lock.name, pkg.name);
	assert.equal(lock.version, pkg.version);
	const root = lock.packages[''];
	assert.equal(root.name, pkg.name);
	assert.equal(root.version, pkg.version);
	assert.equal(root.license, pkg.license);
	assert.equal(root.dependencies, undefined);
	assert.deepEqual(root.devDependencies, pkg.devDependencies);
	assert.deepEqual(root.peerDependencies, pkg.peerDependencies);
	assert.deepEqual(root.engines, pkg.engines);
});

/**
 * Digest of every lockfile entry except the root: the dependency graph that was
 * installed, verified and accepted. Renaming or re-describing the package only
 * touches the root entry. A deliberate dependency change must update this
 * digest in the same reviewed change.
 */
const ACCEPTED_DEPENDENCY_GRAPH = 'aba18c8f9f8fdc3591a55fbf39c7d630316661936e8efdab93ffaf48c95f6cfe';

test('the locked dependency graph is the accepted one', () => {
	const { packages } = readJson('package-lock.json');
	const graph = Object.fromEntries(Object.entries(packages).filter(([key]) => key !== ''));
	assert.equal(createHash('sha256').update(JSON.stringify(graph)).digest('hex'), ACCEPTED_DEPENDENCY_GRAPH);
});

// --- Release barrier -------------------------------------------------------------
//
// Two workflows. CI verifies and can publish nothing. Stage runs only by hand and
// stages one verified tarball, under the exact contract asserted below; an
// ordinary push never publishes. The reviewed release-ready commit removed
// "private" and changed the next test in the same change.

test('the release-ready package is no longer private and sets no publish configuration', () => {
	assert.ok(!('private' in pkg), 'package.json still has "private"');
	assert.equal(pkg.publishConfig, undefined);
});

test('no script can publish or release; only the official publish guard remains', () => {
	assert.equal(pkg.scripts.prepublishOnly, 'n8n-node prerelease');
	for (const name of ['release', 'publish', 'postpublish', 'version', 'preversion', 'postversion']) {
		assert.ok(!(name in pkg.scripts), `package.json defines a "${name}" script`);
	}
	for (const [name, command] of Object.entries(pkg.scripts)) {
		assert.ok(!/\bpublish\b|n8n-node\s+release|release-it/.test(command), `script "${name}" can publish: ${command}`);
	}
});

const WORKFLOWS = '.github/workflows';

function workflows() {
	return readdirSync(join(PACKAGE_ROOT, WORKFLOWS))
		.sort()
		.map((file) => ({
			path: `${WORKFLOWS}/${file}`,
			text: readFileSync(join(PACKAGE_ROOT, WORKFLOWS, file), 'utf8'),
		}));
}

test('the workflows are the verification CI and the manual stage workflow', () => {
	assert.deepEqual(workflows().map((w) => w.path), [`${WORKFLOWS}/ci.yml`, `${WORKFLOWS}/stage.yml`]);
});

const readWorkflow = (file) => readFileSync(join(PACKAGE_ROOT, WORKFLOWS, file), 'utf8');
const readCi = () => readWorkflow('ci.yml');

test('CI cannot publish, stage, release or obtain publishing credentials', () => {
	const forbidden = [
		/\bnpm\s+(stage\s+)?publish\b/,
		/n8n-node\s+release/,
		/release-it/,
		/\bid-token\s*:/,
		/\bregistry-url\s*:/,
		/NODE_AUTH_TOKEN|NPM_TOKEN|NPM_STAGE_TOKEN|RELEASE_MODE/,
		/\bsecrets\./,
		/\benvironment\s*:/,
		/\bgh\s+release\b|\bgit\s+(push|tag)\b/,
	];
	const ci = readCi();
	for (const pattern of forbidden) assert.ok(!pattern.test(ci), `ci.yml matches ${pattern}`);
});

/**
 * Least privilege: the root permissions block is the only one — the word
 * appears nowhere else, in any quoting or style — and it holds exactly
 * `contents: read`. Comments and blank lines do not end a YAML block, so the
 * block runs until the next root key.
 */
function assertReadOnlyToken(ci) {
	assert.equal((ci.match(/permissions/g) ?? []).length, 1, 'the workflow names permissions more than once');
	const lines = ci.split('\n');
	const start = lines.indexOf('permissions:');
	assert.ok(start >= 0, 'the workflow has no plain root permissions block');
	const entries = [];
	for (const line of lines.slice(start + 1)) {
		const content = line.replace(/#.*$/, '').trimEnd();
		if (content === '') continue;
		if (!/^\s/.test(content)) break;
		entries.push(content.trim());
	}
	assert.deepEqual(entries, ['contents: read']);
}

test('the token check rejects any further or elevated permission, however it is spelled', () => {
	const CI = readCi();
	const block = 'permissions:\n  contents: read\n';
	const job = '    runs-on: ubuntu-24.04\n';
	assert.ok(CI.includes(block) && CI.includes(job));
	for (const mutated of [
		CI.replace(block, `${block}  packages: 'write'\n`),
		CI.replace(block, `${block}  "packages": "write"\n`),
		CI.replace(block, `${block}  id-token: write\n`),
		CI.replace(block, `${block}# a comment does not end the block\n  actions: read\n`),
		CI.replace(block, "permissions:\n  contents: 'write'\n"),
		CI.replace(block, 'permissions: write-all\n'),
		CI.replace(block, 'permissions: { contents: read, packages: write }\n'),
		CI.replace(job, `${job}    permissions:\n      contents: write\n`),
		CI.replace(job, `${job}    'permissions': write-all\n`),
	]) {
		assert.notEqual(mutated, CI);
		assert.throws(() => assertReadOnlyToken(mutated), undefined, `accepted:\n${mutated}`);
	}
});

test('CI verifies every change with the qualified toolchain and a read-only token', () => {
	const ci = readCi();

	// Push, pull request and manual runs; nothing that runs with elevated rights.
	for (const trigger of ['push', 'pull_request', 'workflow_dispatch']) {
		assert.match(ci, new RegExp(`^  ${trigger}:`, 'm'));
	}
	assert.doesNotMatch(ci, /pull_request_target|workflow_run|^\s+(release|schedule):/m);

	assertReadOnlyToken(ci);

	// Official actions only, each pinned to a full commit.
	const uses = [...ci.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
	assert.ok(uses.length > 0);
	for (const ref of uses) assert.match(ref, /^actions\/(checkout|setup-node)@[0-9a-f]{40}$/);

	// The current Node 24 LTS and the npm it ships, asserted rather than assumed;
	// npm is never replaced on its own.
	assert.match(ci, /node-version: 24\.21\.0\n/);
	assert.match(ci, /test "\$\(node --version\)" = v24\.21\.0\n/);
	assert.match(ci, /test "\$\(npm --version\)" = 11\.19\.0\n/);
	assert.doesNotMatch(ci, /npm\s+(install|i)\s+(-g|--global)|npm@/);

	// A clean install, then the complete gate: typecheck, build, tests, lint.
	assert.match(ci, /run: npm ci\n/);
	assert.match(ci, /run: npm run verify\n/);
	assert.equal(pkg.scripts.verify, 'npm run typecheck && npm run build && npm test && npm run lint');
});

// --- The stage workflow's contract ---------------------------------------------
//
// Checked line by line, without a YAML library: the workflow is short and its
// shape is fixed. Comments are removed first, so a comment can neither grant
// nor satisfy anything.

const withoutComments = (text) => text.replace(/(^|\s)#.*$/gm, '$1');

/** The non-blank lines under a root key, up to the next root key. */
function rootBlock(yml, key) {
	const lines = yml.split('\n');
	const start = lines.indexOf(`${key}:`);
	assert.ok(start >= 0, `no plain root ${key}: block`);
	const block = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trim() === '') continue;
		if (!/^\s/.test(line)) break;
		block.push(line);
	}
	return block;
}

/** Each job's text, by job id, in order. */
function jobsOf(yml) {
	const jobs = {};
	let current;
	for (const line of rootBlock(yml, 'jobs')) {
		const id = /^ {2}([A-Za-z0-9_-]+):$/.exec(line);
		if (id) jobs[(current = id[1])] = '';
		else if (current) jobs[current] += `${line}\n`;
	}
	return jobs;
}

/** The trimmed entries of the block that starts at `header` inside `text`. */
function blockEntries(text, header, indent) {
	const lines = text.split('\n');
	const start = lines.indexOf(header);
	assert.ok(start >= 0, `no plain ${header.trim()} block`);
	const entries = [];
	for (const line of lines.slice(start + 1)) {
		if (!line.startsWith(' '.repeat(indent)) || line[indent] === ' ') break;
		entries.push(line.trim());
	}
	return entries;
}

/** Each step's text in a job, from its dash to the next. */
function stepsOf(job) {
	const steps = [];
	let inSteps = false;
	for (const line of job.split('\n')) {
		if (line === '    steps:') inSteps = true;
		else if (inSteps && line.startsWith('      - ')) steps.push(`${line}\n`);
		else if (inSteps && line.startsWith('       ') && steps.length) steps[steps.length - 1] += `${line}\n`;
		else if (inSteps && line.trim() !== '') break;
	}
	return steps;
}

const count = (text, pattern) => (text.match(pattern) ?? []).length;

function assertStageContract(text) {
	const yml = withoutComments(text);

	// By hand only, and never anything that runs with elevated rights or on its own.
	assert.deepEqual(rootBlock(yml, 'on').filter((line) => /^ {2}\S/.test(line)), ['  workflow_dispatch:']);
	// The operator gives the commit, its version and the SHA-256 of an independently packed tarball.
	assert.deepEqual(rootBlock(yml, 'on').filter((line) => /^ {6}\S/.test(line)), ['      sha:', '      version:', '      tarball_sha256:']);
	assert.equal(count(yml, /^ {8}required: true$/gm), 3);
	// The expected hash is only ever the given one: no job hands a hash, or anything else, to another.
	assert.doesNotMatch(yml, /^ {4}outputs:|needs\.[\w-]+\.outputs/m);
	assert.equal(count(yml, /WANT_TARBALL_SHA256: \$\{\{ inputs\.tarball_sha256 \}\}\n/g), 3);
	assert.doesNotMatch(yml, /pull_request_target|workflow_run|n8n-node\s+release|release-it|\bgh\s+release\b|\bgit\s+(push|tag)\b/);

	// Two permission blocks: the read-only root and the stage job's.
	assert.equal(count(yml, /permissions/g), 2, 'permissions are named elsewhere');
	assert.deepEqual(blockEntries(yml, 'permissions:', 2), ['contents: read']);

	const jobs = jobsOf(yml);
	assert.deepEqual(Object.keys(jobs), ['verify-pack', 'stage']);
	const { 'verify-pack': verify, stage } = jobs;

	// verify-pack installs, verifies and packs, with no credential anywhere near it.
	for (const pattern of [/permissions/, /\benvironment\s*:/, /\bsecrets\./, /id-token/, /registry-url/,
		/NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/, /RELEASE_MODE/, /\bpublish\b/]) {
		assert.doesNotMatch(verify, pattern);
	}
	for (const gate of [
		/test "\$GITHUB_EVENT_NAME" = workflow_dispatch\n/,
		/test "\$GITHUB_REF" = refs\/heads\/main\n/,
		/\[\[ "\$WANT_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]\n/,
		/test "\$WANT_SHA" = "\$GITHUB_SHA"\n/,
		/\[\[ "\$WANT_VERSION" =~ \^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]\n/,
		/\[\[ "\$WANT_TARBALL_SHA256" =~ \^\[0-9a-f\]\{64\}\$ \]\]\n/,
		/ref: \$\{\{ inputs\.sha \}\}\n {10}persist-credentials: false\n/,
		/test "\$\(git rev-parse HEAD\)" = "\$WANT_SHA"\n/,
		/if \(pkg\.name !== "n8n-nodes-siteshot"\) throw/,
		/if \(pkg\.version !== process\.env\.WANT_VERSION\) throw/,
		/if \(pkg\.private === true\) throw/,
		/const repository = `git\+\$\{process\.env\.GITHUB_SERVER_URL\}\/\$\{process\.env\.GITHUB_REPOSITORY\}\.git`;/,
		/if \(pkg\.repository\?\.url !== repository\) throw/,
		/run: npm ci\n/,
		/run: npm run verify\n/,
		/npm pack --json > "\$RUNNER_TEMP\/pack\.json"\n/,
		/tarball=\$\(node test\/check-pack\.mjs "\$RUNNER_TEMP\/pack\.json" "\$WANT_VERSION"\)\n {10}test "\$\(sha256sum "\$tarball" \| cut -d' ' -f1\)" = "\$WANT_TARBALL_SHA256"\n/,
	]) {
		assert.match(verify, gate);
	}

	// stage: a reviewer approves the environment; it gets an OIDC token for the
	// provenance and runs nothing from the repository.
	assert.match(stage, /^ {4}needs: verify-pack\n/m);
	assert.match(stage, /^ {4}environment: npm-stage\n/m);
	assert.deepEqual(blockEntries(stage, '    permissions:', 6), ['contents: read', 'id-token: write']);
	for (const pattern of [/actions\/checkout/, /\bnpm\s+(ci|install|i|run|exec|pack|x)\b/, /\bnpx\b/, /\bnode\s+(?!--version\b)/]) {
		assert.doesNotMatch(stage, pattern);
	}

	// One token reference in the whole workflow, in the last step, which stages the
	// file named by the given version, after the check that it has the given SHA-256.
	const steps = stepsOf(stage);
	const last = steps.at(-1);
	assert.equal(count(yml, /secrets\./g), 1);
	assert.equal(count(yml, /NODE_AUTH_TOKEN/g), 1);
	assert.equal(count(yml, /RELEASE_MODE/g), 1);
	assert.equal(count(yml, /\bpublish\b/g), 1, 'publish is named elsewhere');
	assert.match(last, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_STAGE_TOKEN \}\}\n/);
	assert.match(last, /RELEASE_MODE: 'true'\n/);
	assert.match(last, /TARBALL: n8n-nodes-siteshot-\$\{\{ inputs\.version \}\}\.tgz\n/);
	assert.match(last, /run: npm stage publish "\.\/\$TARBALL" --provenance --access public\n$/);
	const check = /TARBALL: n8n-nodes-siteshot-\$\{\{ inputs\.version \}\}\.tgz\n {10}WANT_TARBALL_SHA256: \$\{\{ inputs\.tarball_sha256 \}\}\n {8}run: \|\n {10}\[\[ "\$WANT_TARBALL_SHA256" =~ \^\[0-9a-f\]\{64\}\$ \]\]\n {10}test "\$\(sha256sum "\$TARBALL" \| cut -d' ' -f1\)" = "\$WANT_TARBALL_SHA256"\n/;
	assert.ok(steps.slice(0, -1).some((step) => check.test(step)), 'no check of the downloaded tarball against the given SHA-256');

	// The registry only where the token is; the same toolchain in both jobs.
	assert.equal(count(yml, /registry-url/g), 1);
	assert.match(stage, /registry-url: https:\/\/registry\.npmjs\.org\n/);
	assert.equal(count(yml, /node-version: 24\.21\.0\n/g), 2);
	assert.equal(count(yml, /test "\$\(npm --version\)" = 11\.19\.0\n/g), 2);

	// Official actions only, each pinned to a full commit.
	const uses = [...yml.matchAll(/uses:\s*(\S+)/g)].map((m) => m[1]);
	assert.equal(uses.length, 5);
	for (const ref of uses) assert.match(ref, /^actions\/(checkout|setup-node|upload-artifact|download-artifact)@[0-9a-f]{40}$/);
}

test('the stage workflow stages one verified tarball by hand, with the token in one step', () => {
	assertStageContract(readWorkflow('stage.yml'));
});

test('the stage contract rejects every weakening, and a comment cannot stand in for a gate', () => {
	const STAGE = readWorkflow('stage.yml');
	const mutate = (from, to) => {
		assert.ok(STAGE.includes(from), `fixture text not found: ${from}`);
		return STAGE.replace(from, to);
	};
	const verifyStep = '      - name: Verify\n        run: npm run verify\n';
	const stageToolchain = '      - name: Check the toolchain\n        run: |\n          test "$(node --version)" = v24.21.0\n          test "$(npm --version)" = 11.19.0\n\n      # The one step';
	for (const [name, mutated] of [
		['a push trigger', mutate('on:\n  workflow_dispatch:\n', 'on:\n  push:\n    branches: [main]\n  workflow_dispatch:\n')],
		['id-token for every job', mutate('permissions:\n  contents: read\n', 'permissions:\n  contents: read\n  id-token: write\n')],
		['no protected environment', mutate('    environment: npm-stage\n', '')],
		['the token in verify-pack', mutate(verifyStep, verifyStep.replace('        run:', '        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_STAGE_TOKEN }}\n        run:'))],
		['a second secret', mutate("          RELEASE_MODE: 'true'\n", "          RELEASE_MODE: 'true'\n          OTHER: ${{ secrets.OTHER }}\n")],
		['RELEASE_MODE outside the stage step', mutate(verifyStep, verifyStep.replace('        run:', "        env:\n          RELEASE_MODE: 'true'\n        run:"))],
		['the working directory instead of the tarball', mutate('npm stage publish "./$TARBALL"', 'npm stage publish')],
		['direct publication', mutate('npm stage publish "./$TARBALL"', 'npm publish "./$TARBALL"')],
		['no provenance', mutate(' --provenance --access public', ' --access public')],
		['a checkout next to the token', mutate('    steps:\n      - uses: actions/download-artifact', '    steps:\n      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\n      - uses: actions/download-artifact')],
		['an install next to the token', mutate(stageToolchain, stageToolchain.replace('        run: |\n', '        run: |\n          npm ci\n'))],
		['an unpinned action', mutate('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020', 'actions/setup-node@v7')],
		['no tarball_sha256 input', mutate('      tarball_sha256:\n        description: SHA-256 of the tarball from an independent pack of that commit (64 lowercase hex)\n        required: true\n        type: string\n', '')],
		['a looser tarball_sha256 format', mutate('          [[ "$WANT_TARBALL_SHA256" =~ ^[0-9a-f]{64}$ ]]\n          test "$(sha256sum "$TARBALL"', '          [[ "$WANT_TARBALL_SHA256" =~ ^[0-9a-fA-F]+$ ]]\n          test "$(sha256sum "$TARBALL"')],
		['verify-pack trusts its own pack', mutate(`          test "$(sha256sum "$tarball" | cut -d' ' -f1)" = "$WANT_TARBALL_SHA256"\n`, '')],
		['stage trusts a hash from the build job', mutate('          WANT_TARBALL_SHA256: ${{ inputs.tarball_sha256 }}\n        run: |\n          [[ "$WANT_TARBALL_SHA256"', '          WANT_TARBALL_SHA256: ${{ needs.verify-pack.outputs.sha256 }}\n        run: |\n          [[ "$WANT_TARBALL_SHA256"')],
		['the build job hands its hash on', mutate('    timeout-minutes: 20\n    steps:\n', '    timeout-minutes: 20\n    outputs:\n      sha256: ${{ steps.pack.outputs.sha256 }}\n    steps:\n')],
		['no check of the downloaded tarball', mutate(`          test "$(sha256sum "$TARBALL" | cut -d' ' -f1)" = "$WANT_TARBALL_SHA256"\n`, '')],
		['the stage file named by the build job', mutate("          RELEASE_MODE: 'true'\n          TARBALL: n8n-nodes-siteshot-${{ inputs.version }}.tgz\n", "          RELEASE_MODE: 'true'\n          TARBALL: ${{ needs.verify-pack.outputs.tarball }}\n")],
		['no main-branch gate', mutate('          test "$GITHUB_REF" = refs/heads/main\n', '')],
		['a commented-out main-branch gate', mutate('          test "$GITHUB_REF" = refs/heads/main\n', '          # test "$GITHUB_REF" = refs/heads/main\n')],
		['no private gate', mutate('            if (pkg.private === true) throw new Error("the package is still private");\n', '')],
		['no repository gate', mutate('            if (pkg.repository?.url !== repository) throw new Error("repository.url names another repository");\n', '')],
		['no verification', mutate(verifyStep, '')],
		['no pack check', mutate('          tarball=$(node test/check-pack.mjs "$RUNNER_TEMP/pack.json" "$WANT_VERSION")\n', '          tarball=n8n-nodes-siteshot-$WANT_VERSION.tgz\n')],
	]) {
		assert.notEqual(mutated, STAGE, name);
		assert.throws(() => assertStageContract(mutated), undefined, `accepted: ${name}`);
	}
});
