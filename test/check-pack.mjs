/**
 * Checks the report of one `npm pack --json`: exactly one tarball, of this
 * package at the expected version, holding exactly PACKAGE_FILES. The stage
 * workflow runs it on the tarball it is about to hand to the stage job:
 *
 *   node test/check-pack.mjs pack.json VERSION   # prints the tarball's file name
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { PACKAGE_FILES } from './packed-files.mjs';

export function checkPack(report, version) {
	if (!Array.isArray(report) || report.length !== 1) throw new Error('npm pack did not make exactly one tarball');
	const [pack] = report;
	const filename = `n8n-nodes-siteshot-${version}.tgz`;
	if (pack.name !== 'n8n-nodes-siteshot' || pack.version !== version || pack.filename !== filename) {
		throw new Error('the tarball is not n8n-nodes-siteshot at the requested version');
	}
	const files = (pack.files ?? []).map((file) => file.path).sort();
	if (JSON.stringify(files) !== JSON.stringify([...PACKAGE_FILES].sort())) {
		throw new Error('the tarball does not hold exactly the allowed files');
	}
	return filename;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [report, version] = process.argv.slice(2);
	console.log(checkPack(JSON.parse(readFileSync(report, 'utf8')), version));
}
