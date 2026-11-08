# n8n-nodes-siteshot

An [n8n](https://n8n.io/) community node that captures a screenshot of a public
web page with the [Site-Shot](https://www.site-shot.com/) API and passes it to
the next node as binary data.

## What it does

One action: given an explicit `http://` or `https://` address, it returns a PNG,
JPEG or WebP screenshot in a binary field, ready for any storage, upload or email
node downstream.

There is no trigger, scheduling or storage, and no country selection,
request-header, JavaScript-injection or proxy options. The API host is fixed.
The node is written against the published Site-Shot API and does not use or
include the Site-Shot SDK.

## Requirements

- Self-hosted n8n with community nodes enabled. Only n8n 2.40.5 has been tested;
  see [Compatibility](#compatibility).
- A Site-Shot API key, from the
  [Site-Shot quickstart](https://www.site-shot.com/start/). A confirmed
  account's API key comes with the free plan: 100 API captures a month, no card
  needed. An account confirmed before 2026-10-30 switches it on with one button
  on the quickstart page; an account that has had a paid plan before does not
  get the free plan. [Paid plans](https://www.site-shot.com/pricing/) start at
  $5/mo for 2,000.

## Installation

The owner of a self-hosted n8n instance installs the node under
**Settings → Community Nodes** by entering the package name,
`n8n-nodes-siteshot`. The versions published to npm are listed on its
[npm page](https://www.npmjs.com/package/n8n-nodes-siteshot); a package of this
name from anywhere else is not this project.

## Credentials

Create a **Site-Shot API** credential and paste your key into **API Key**, a
password field. n8n's credential layer adds the key to each request; the node's
own code never reads it.

- **Captures** send the key as the `userkey` query parameter, which is how the
  Site-Shot API authenticates a capture.
- **The credential test** sends `GET https://api.site-shot.com/v1.0/credential-check`
  with the key in a `userkey` header, an empty query string and nothing else —
  no page address, body or account details. It never requests a screenshot.
  Each attempt times out after 10 seconds, redirects are not followed, and the
  key is only ever sent to `api.site-shot.com`.

| Test result | Meaning |
| --- | --- |
| success | The key was accepted. |
| `401` | The key is missing or not recognised. n8n shows: "Site-Shot did not recognise this API key. Copy it again from https://www.site-shot.com/start/, without spaces." |
| `403` | The key is valid, but the account has no active subscription, or its free plan is used up for this month. |

### The credential test and your quota

The `/v1.0/credential-check` endpoint is live on the Site-Shot API. In the one
live run with n8n 2.40.5 (see [Compatibility](#compatibility)), a credential
test with a valid key succeeded and did not count against the account's quota;
a capture counted once. The other results in the table above have not been seen
through n8n against the live API.

It is not only the **Test** button. n8n can run the test on its own: with n8n
2.40.5, opening a saved credential sent a test without anything being clicked.
Creating, opening and re-testing the credential can each send a request.

### How n8n runs the credential test

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

## Node reference

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| **URL** | yes | — | Must start with `http://` or `https://`. Never rewritten or guessed. |
| **Put Output File in Field** | yes | `data` | Name of the output binary field. |
| **Options → Block Ads** | no | off | Hides ads before the capture (`no_ads=1`). |
| **Options → Delay (Ms)** | no | API default | Milliseconds to wait after the page loads, 0–30000 (`delay_time`). Leaving it unset is not a zero wait: the API applies its own. |
| **Options → Format** | no | `png` | `png`, `jpeg` or `webp`. PNG and WebP are lossless; JPEG is lossy and smallest on photo-heavy pages. A WebP full-page capture taller than 16,383 px is cut at 16,383 px. An expression may also give `PNG`, `jpg` and so on; any other value is rejected before a request is sent. |
| **Options → Full Page** | no | off | Captures the whole scrollable page. |
| **Options → Remove Cookie Banners** | no | off | Removes cookie-consent banners and popups before the capture (`no_cookie_popup=1`). |
| **Options → Viewport Width** | no | API default (1024) | 100–8000 px. |
| **Options → Viewport Height** | no | API default (768) | 100–20000 px. |

Options you leave unset are not sent, so the API applies its own defaults. A bare
`example.com` is rejected rather than given a scheme, and so are addresses with
embedded credentials (`https://user:pass@host/`) or control characters.

## Output

Each input item produces one output item, paired with its input, with the input
JSON unchanged and the screenshot in the binary field. For example, a workflow
**Manual Trigger → Site-Shot → (any node that takes a binary file)** with the
defaults produces an item like this (abbreviated; n8n adds the file data and
size):

```json
{
  "json": {},
  "binary": {
    "data": {
      "mimeType": "image/png",
      "fileName": "screenshot.png",
      "fileExtension": "png"
    }
  }
}
```

Point the downstream node at the same field name. The file name is always
`screenshot.png`, `screenshot.jpg` or `screenshot.webp`; rename it downstream if many captures go
to one destination.

## Cost, errors and limits

**Captures are billable.** Every capture request the API accepts may count
against your Site-Shot quota, including one that fails while rendering. The
node checks the URL, viewport, delay and format before sending anything, so invalid input is
rejected without a request. It never retries a capture, never falls back to
another endpoint and never returns a placeholder result. If you enable n8n's
**Retry On Fail**, each retry is another capture request.

**A failure is never a screenshot.** A capture that fails while rendering is
answered with HTTP 200, an `error` field and a placeholder image. The node reads
`error` on every response and produces no binary field unless the response
holds a real image in the requested format. It also rejects missing, empty or
malformed image data, an image in a format other than the one requested, and
responses that are not the expected JSON.

| Situation | What the node reports |
| --- | --- |
| HTTP 401 | The API key was rejected. |
| HTTP 403, `No active subscription found` | The account has no active subscription; the key itself is fine. |
| HTTP 403, `Free plan used up` or `Free API trial used up` (the API may use either wording) | This month's free-plan captures are used up, with the date the free plan renews when the API gives one; the key itself is fine. |
| HTTP 403, `Forbidden target address` | Site-Shot does not capture this address, for example one on a private or local network. |
| Any other HTTP 403 | Site-Shot refused the capture: the account may have no active subscription or its free plan may be used up for this month, or the address may not be allowed. |
| HTTP 402 or 429, or a quota failure | A quota or payment problem. |
| `country_unavailable` | No capacity in the requested country right now. |
| `error_code` `proxy_navigation_failed` on an HTTP 200 | Site-Shot could not open the page, for example because the address does not exist or is mistyped. The attempt still counts as a capture. |
| `Geotargeting needs a paid plan` | Site-Shot refuses a capture from a country other than the US on the free plan and returns an error instead of an image; the refused request still counts toward the month's 100. The node has no country option, so it does not ask for one itself. |
| HTTP 5xx | The API is unavailable. |
| Capture failed on an HTTP 200 | The page could not be captured. A status line from the page or proxy (such as `407 Proxy Authentication Required`) or a browser network error is never read as a key, quota or option problem. |
| Invalid URL, viewport, delay or format | Rejected before any request is sent. |

Error messages are written by this node. They include the HTTP status, and
upstream wording only when it matches a short list of known reasons (plus a
used-up free plan's renewal date, when it has the exact `YYYY-MM-DD (UTC)`
form); they never include the API key, the request address, headers or
response bodies. The node writes no logs. With **Continue On Fail** enabled, a
failed item keeps its input JSON and pairing, gains an `error` message and has
no binary field.

Limits, fixed in this version:

- **Request timeout: 90 seconds**, handed to n8n's HTTP helper: the API's
  default 60-second render deadline plus headroom. It is only as strict as that
  helper, and it has not been measured against a real clock.
- **Largest screenshot: 32 MiB.** The check runs after the response has been
  received and before the image is decoded, so it stops an oversized image from
  being passed on but does not stop it being downloaded.

## Compatibility

- **Tested:** n8n 2.40.5 only, in its official Docker image for linux/arm64
  pinned by digest (Node 26.7.0, `n8n-core` 2.40.3, `n8n-workflow` 2.40.1).
  Other n8n versions, other architectures and n8n Cloud have not been tested.
  - **Against the live Site-Shot API, once:** with a pre-release build of this
    package installed in that n8n, one credential test succeeded without
    counting against the quota, and one workflow captured a 1024×768 PNG that
    counted once. That single run covered only this success path.
  - **Against a synthetic stand-in for the API only**, in an isolated local
    environment with no internet access: rejected keys, timeouts, redirects,
    API errors and failed captures.
- **Package:** no runtime dependencies; `n8n-workflow` is a peer dependency
  that n8n provides.
- **Development toolchain:** Node 24.21.0 and the npm it ships, 11.19.0.
  npm 11.19.0 runs no dependency install script unless approved; none is
  needed to build or verify this package.

## Development

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

### Runtime fixture (local only)

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

Publishing to npm is separate from n8n verification. Site-Shot is now
[listed as a verified integration by n8n](https://n8n.io/integrations/site-shot/).
Instance owners and admins can use
[n8n's verified-node installation guide](https://docs.n8n.io/integrations/community-nodes/installation-and-management/install-verified-community-nodes/).
This project's documented runtime tests remain self-hosted; a verified listing
is not an independent n8n Cloud execution test.

## Version history

- **0.1.2:** the node and its credential describe the free plan and explain a
  `403` by the API's own message. The **API Key** field no longer says that a
  paid plan is required: a confirmed account's key comes with the free plan of
  100 API captures a month. A capture refused with `403` now says which of these
  it was: no active subscription (with where to switch the free plan on), this
  month's free plan used up (with the date it renews when the API gives one), or
  an address Site-Shot does not capture, such as one on a private network. If
  Site-Shot answers that a country other than the US needs a paid plan, the
  node says so instead of reporting a failed page capture. Any
  other `403` is reported neutrally, without sending you to buy a paid plan. The
  credential test's `403` names both billing causes, and the hint for a rejected
  key links to the quickstart (`/start/`), where the key is shown. The requests
  the node sends are unchanged.
- **0.1.1:** the node's codex file (`SiteShot.node.json`) lists only the
  `Development` category. 0.1.0 also listed `Developer Tools`, which is not a
  category n8n accepts for a community node. The node's code, credential and
  requests are unchanged.
- **0.1.0:** the first version.

## Support

- Problems with this node: [GitHub issues](https://github.com/site-shot/n8n-nodes-siteshot-public/issues).
  Never post an API key in an issue.
- The Site-Shot API: [API reference](https://www.site-shot.com/#documentation)
  and [quickstart](https://www.site-shot.com/start/).

## License

[MIT](LICENSE)
