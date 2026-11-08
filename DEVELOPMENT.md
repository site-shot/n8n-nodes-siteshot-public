# Development and release

Maintainer notes for `n8n-nodes-siteshot`. The user documentation is the
[README](README.md).

## Build and test

```bash
npm ci
npm run verify   # typecheck, build, test, lint
```

The tests are synthetic. They never contact the Site-Shot API, use a real key or
take a screenshot; tests that need a socket use a stub on `127.0.0.1`. They
also check the package itself: its name and metadata, exactly which files
`npm pack` would include, the source maps, and the release path. Ordinary CI
only verifies; only the separate, manual **Stage** workflow can stage a
version, and only after the protected `npm-stage` environment is approved.
Publishing a staged version is a separate, final step: the owner's approval on
npm.

[CI](.github/workflows/ci.yml) runs `npm ci` and `npm run verify` with the same
Node and npm versions on pushes to `main`, on pull requests and on demand. It
has read-only repository access and cannot publish.

**Toolchain:** Node 24.21.0 and the npm it ships, 11.19.0. Pack a release
tarball with exactly this toolchain: a tarball packed with another Node or npm
(for example on a workstation) can differ in its gzip bytes, so its SHA-256 will
not match the one the Stage workflow computes. npm 11.19.0 runs no dependency
install script unless approved; none is needed to build or verify this package.

## Runtime fixture (local only)

`runtime-fixture/runtime-gate.sh` runs the built package in the pinned n8n
2.40.5 image on an isolated Docker network, against a synthetic API stand-in,
and drives the editor's REST API. It is a local check, not part of CI. It needs
Docker on an ARM64 machine, the pinned image already pulled, and the Python
interpreter of a project `.venv` that has Pillow, passed explicitly:

```bash
runtime-fixture/runtime-gate.sh up /absolute/path/to/project/.venv/bin/python
runtime-fixture/runtime-gate.sh status
runtime-fixture/runtime-gate.sh down   # removes only resources it created
```

`down` and `status` do not need Python. The script's messages and comments are
in Russian.

## How n8n runs the credential test

Measured with n8n 2.40.5 against a local stand-in for the API:

- **A rejected key sends two requests.** n8n retries a credential test once
  after a `401`. This package neither asks for that retry nor can switch it off.
  A success or a `403` sends one request.
- **The 10-second timeout applies to each attempt**, not to the whole test. A
  stand-in that answered `401` after 6 seconds made the test take about 12
  seconds. No overall limit is claimed.
- Same-origin and cross-origin redirects were both refused, and the key never
  reached the redirect target.

The timeout is set in the credential's `authenticate` hook because n8n 2.40.5
replaces any timeout declared on the test request itself.

## The credential test and quota, as measured

The `/v1.0/credential-check` endpoint is live on the Site-Shot API. In the one
live run with n8n 2.40.5, a credential test with a valid key succeeded and did
not count against the account's quota; a capture counted once. With n8n 2.40.5,
opening a saved credential sent a test without anything being clicked.

## Release

- CI only verifies. The stage workflow (`.github/workflows/stage.yml`) runs
  only by hand and only stages; an ordinary push never publishes.
- `repository` and `bugs` in `package.json` and the issue link below name this
  repository, and the stage workflow refuses to run in any other.

A release, step by step:

1. A reviewed commit of `main` is packed independently, with the same
   toolchain, and the tarball's SHA-256 is recorded. `npm pack` of the same
   commit is byte for byte reproducible.
2. A maintainer dispatches **Stage** on `main` with three values: the commit's
   full SHA, its version and that SHA-256. The first job checks out exactly
   that commit and refuses a different repository, commit or version, or a
   private manifest. It then runs `npm ci`, the full `npm run verify` and packs
   the tarball. It stops unless the tarball holds exactly the expected files
   and has the given SHA-256. It has no secret and no OIDC token.
3. After a reviewer approves the protected `npm-stage` environment, the second
   job takes that tarball and checks its SHA-256 against the given one again;
   it never takes a hash from the first job. Then it runs
   `npm stage publish ./n8n-nodes-siteshot-<version>.tgz --provenance --access public`.
   It checks out and installs nothing; the npm token exists only in that one,
   last step.
4. The first stage of a package that does not exist yet creates a public
   `0.0.0-stage` placeholder on npm. The staged version itself stays
   unpublished until the owner reviews it on npm and approves it with 2FA.
   Before approval, the staged tarball and its provenance (subject and source
   commit) are checked; after approval, the published version is checked on
   npm.
5. The October 1, 2026 `npm audit` of the locked install graph reports 14
   findings: 5 moderate and 9 high. They include the CLI development chain and
   the automatically installed `n8n-workflow` peer and its Axios dependency;
   they are not all development-only. This package bundles no dependencies,
   and n8n normally supplies the runtime peer. The audit does not establish an
   exploit through this node, but it also does not show that the host n8n is
   unaffected. Review the host version and upstream dependency advisories
   before release.

Why a tarball: `npm stage publish <file>.tgz` sends that file as it is and runs
no lifecycle script, so the `prepublishOnly` guard (`n8n-node prerelease`) does
not run there. The workflow's checks of repository, commit, version, full
verification, packed files and the given SHA-256 are the release gate. The
official `n8n-node release` command is not used: it publishes directly, and it
runs only lint and build.

Publishing to npm is separate from n8n verification. Site-Shot is
[listed as a verified integration by n8n](https://n8n.io/integrations/site-shot/),
and n8n's verified registry pins one npm version by its checksum. n8n Cloud and
the nodes panel keep installing that pinned version until n8n reviews a newer
one, so a release is finished only after its last step:

6. After the owner approves the staged version on npm and it is published,
   submit that version to n8n for re-verification of the verified listing, and
   check afterwards that the n8n registry lists the new version.

If a Stage run fails, look at npm's staged versions first (a staged version is
not visible anonymously): if the version is staged, it only needs the owner's
approval; re-pack and re-dispatch only if it is missing.

