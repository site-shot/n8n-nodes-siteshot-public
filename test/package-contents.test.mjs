/**
 * What the npm tarball contains: the built node and credential, their icons,
 * type declarations and source maps, plus the manifest, README and licence
 * that npm always adds. Nothing else — no tests, runtime fixture, lockfile,
 * compiler cache or private material — and the guard itself must fail when the
 * packed file list drifts.
 *
 * Runs against the current build, so `npm run build` must come first
 * (`npm run verify` does that).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import {
	PACKAGE_ROOT,
	PRIVATE_MARKERS,
	SECRET_KEY,
	SECRET_TARGET_TOKEN,
	packedFiles,
	readJson,
	sourceFiles,
} from './helpers.mjs';
import { checkPack } from './check-pack.mjs';
import { PACKAGE_FILES } from './packed-files.mjs';


/** Fail unless the package in `dir` packs to exactly PACKAGE_FILES, naming every difference. */
function assertPackedFiles(dir) {
	const packed = packedFiles(dir);
	const unexpected = packed.filter((file) => !PACKAGE_FILES.includes(file));
	const missing = PACKAGE_FILES.filter((file) => !packed.includes(file));
	assert.deepEqual(
		{ unexpected, missing },
		{ unexpected: [], missing: [] },
		`the tarball differs from the allowlist: ${JSON.stringify({ unexpected, missing })}`,
	);
}

/** A disposable copy of everything npm packs, removed when the test ends. */
function packageCopy(t) {
	const dir = mkdtempSync(join(tmpdir(), 'siteshot-pack-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	for (const entry of ['package.json', 'README.md', 'LICENSE', 'dist']) {
		cpSync(join(PACKAGE_ROOT, entry), join(dir, entry), { recursive: true });
	}
	return dir;
}

test('the tarball holds exactly the built node and credential with their assets, plus required metadata', () => {
	assertPackedFiles(PACKAGE_ROOT);
});

test('the tarball check fails on an unexpected file and on a missing one', (t) => {
	const dir = packageCopy(t);
	writeFileSync(join(dir, 'dist/stray.txt'), 'not part of the package\n');
	rmSync(join(dir, 'dist/credentials/icons/SiteShot.svg'));

	assert.throws(
		() => assertPackedFiles(dir),
		(err) =>
			err.message.includes('"unexpected":["dist/stray.txt"]') &&
			err.message.includes('"missing":["dist/credentials/icons/SiteShot.svg"]'),
	);
});

// npm pack runs these scripts itself, so they must be refused before npm is
// ever asked to pack — not merely reported by a separate test afterwards.
for (const script of ['prepack', 'prepare', 'postpack']) {
	test(`the tarball check refuses a "${script}" script before npm could run it`, (t) => {
		const dir = packageCopy(t);
		const marker = join(dir, `${script}.ran`);
		const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
		manifest.scripts[script] = `node -e "require('fs').writeFileSync('${script}.ran', '')"`;
		writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, '\t'));

		let refusal;
		try {
			packedFiles(dir);
		} catch (err) {
			refusal = err;
		}
		assert.ok(!existsSync(marker), `npm ran the "${script}" script`);
		assert.match(String(refusal?.message), new RegExp(`defines a "${script}" script`));
	});
}

test('the built manifest and node descriptor are copies of the source ones', () => {
	assert.deepEqual(readJson('dist/package.json'), readJson('package.json'));
	assert.deepEqual(readJson('dist/nodes/SiteShot/SiteShot.node.json'), readJson('nodes/SiteShot/SiteShot.node.json'));
});

test('the licence and README are the public ones', () => {
	assert.match(readFileSync(join(PACKAGE_ROOT, 'LICENSE'), 'utf8'), /^MIT License\n/);
	assert.match(readFileSync(join(PACKAGE_ROOT, 'README.md'), 'utf8'), /^# n8n-nodes-siteshot\n/);
});

test('each source map names only its own tracked TypeScript source and embeds no source text', () => {
	const tracked = new Set(sourceFiles());
	const maps = PACKAGE_FILES.filter((file) => file.endsWith('.js.map'));
	assert.equal(maps.length, 3);
	for (const mapPath of maps) {
		const js = mapPath.slice(0, -'.map'.length);
		const map = readJson(mapPath);

		// Nothing beyond the standard fields: in particular no sourcesContent.
		assert.deepEqual(Object.keys(map).sort(), ['file', 'mappings', 'names', 'sourceRoot', 'sources', 'version']);
		assert.equal(map.version, 3);
		assert.equal(map.file, posix.basename(js));
		assert.equal(map.sourceRoot, '');

		// One relative source, resolving from dist/ back to the .ts it was built from.
		const source = js.replace(/^dist\//, '').replace(/\.js$/, '.ts');
		assert.equal(map.sources.length, 1, `${mapPath} lists ${map.sources.length} sources`);
		assert.equal(posix.join(posix.dirname(js), map.sources[0]), source, `${mapPath} names ${map.sources[0]}`);
		assert.ok(tracked.has(source), `${mapPath} maps to ${source}, which is not a repository file`);

		const code = readFileSync(join(PACKAGE_ROOT, js), 'utf8');
		assert.ok(code.endsWith(`\n//# sourceMappingURL=${posix.basename(mapPath)}`), `${js} does not point at its own map`);
	}
});

test('no packed file carries a private path, the local package name or a synthetic test secret', () => {
	for (const file of packedFiles()) {
		const text = readFileSync(join(PACKAGE_ROOT, file), 'utf8');
		for (const marker of [...PRIVATE_MARKERS, /n8n-nodes-siteshot-[l]ocal/]) {
			assert.ok(!marker.test(text), `${file} matches ${marker}`);
		}
		for (const secret of [SECRET_KEY, SECRET_TARGET_TOKEN]) {
			assert.ok(!text.includes(secret), `${file} contains a synthetic test secret`);
		}
	}
});

test('the stage pack check accepts exactly one tarball of this package holding the allowed files', () => {
	const files = PACKAGE_FILES.map((path) => ({ path, size: 1, mode: 420 }));
	const good = { name: 'n8n-nodes-siteshot', version: '0.1.0', filename: 'n8n-nodes-siteshot-0.1.0.tgz', files };
	assert.equal(checkPack([good], '0.1.0'), 'n8n-nodes-siteshot-0.1.0.tgz');
	for (const [name, report, version] of [
		['no tarball', [], '0.1.0'],
		['two tarballs', [good, good], '0.1.0'],
		['another version', [good], '0.1.1'],
		['another package', [{ ...good, name: 'n8n-nodes-other' }], '0.1.0'],
		['another file name', [{ ...good, filename: 'x.tgz' }], '0.1.0'],
		['an extra file', [{ ...good, files: [...files, { path: 'test/helpers.mjs' }] }], '0.1.0'],
		['a missing file', [{ ...good, files: files.slice(1) }], '0.1.0'],
		['no file list', [{ ...good, files: undefined }], '0.1.0'],
	]) {
		assert.throws(() => checkPack(report, version), Error, name);
	}
});
