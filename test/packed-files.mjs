/**
 * What the npm tarball holds: the built node and credential, their icons, type
 * declarations and source maps, plus the manifest, README and licence that npm
 * always adds. The packed-file test and the stage workflow's pack check both
 * hold the tarball to this list.
 */
export const PACKAGE_FILES = [
	'LICENSE',
	'README.md',
	'dist/credentials/SiteShotApi.credentials.d.ts',
	'dist/credentials/SiteShotApi.credentials.js',
	'dist/credentials/SiteShotApi.credentials.js.map',
	'dist/credentials/icons/SiteShot.svg',
	'dist/nodes/SiteShot/SiteShot.node.d.ts',
	'dist/nodes/SiteShot/SiteShot.node.js',
	'dist/nodes/SiteShot/SiteShot.node.js.map',
	'dist/nodes/SiteShot/SiteShot.node.json',
	'dist/nodes/SiteShot/capture.d.ts',
	'dist/nodes/SiteShot/capture.js',
	'dist/nodes/SiteShot/capture.js.map',
	'dist/nodes/SiteShot/siteShot.dark.svg',
	'dist/nodes/SiteShot/siteShot.svg',
	'dist/package.json',
	'package.json',
];
