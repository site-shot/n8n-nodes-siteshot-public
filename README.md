# n8n-nodes-siteshot

An [n8n](https://n8n.io/) community node that captures a screenshot of a public
web page with the [Site-Shot](https://www.site-shot.com/) API and passes it to
the next node as binary data.

## Quick start

1. Install the node: search for **Site-Shot** in the n8n nodes panel (see
   [Installation](#installation)).
2. Copy your API key from the [Site-Shot quickstart](https://www.site-shot.com/start/)
   (create a free account there if you have none).
3. In n8n, create a **Site-Shot API** credential and paste the key into
   **API Key**.
4. Add the **Site-Shot** node after a trigger and enter the page address in
   **URL**, for example `https://example.com/`.
5. Run it. The screenshot is in the output's binary field `data`, ready for any
   storage, upload or email node.

To try it without building anything, paste this workflow into the n8n editor
(copy it, then press Ctrl+V or Cmd+V on the canvas) and pick your credential on
the Site-Shot node:

```json
{
  "nodes": [
    {
      "parameters": {},
      "name": "When clicking 'Execute workflow'",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [0, 0]
    },
    {
      "parameters": {
        "url": "https://example.com/",
        "options": { "removeCookieBanners": true, "blockAds": true }
      },
      "name": "Site-Shot",
      "type": "n8n-nodes-siteshot.siteShot",
      "typeVersion": 1,
      "position": [220, 0]
    }
  ],
  "connections": {
    "When clicking 'Execute workflow'": {
      "main": [[{ "node": "Site-Shot", "type": "main", "index": 0 }]]
    }
  }
}
```

## What it does

One action: given an explicit `http://` or `https://` address, it returns a PNG,
JPEG or WebP screenshot in a binary field, ready for any storage, upload or email
node downstream.

There is no trigger, scheduling or storage, and no country selection,
request-header, JavaScript-injection or proxy options. The API host is fixed.
The node is written against the published Site-Shot API and does not use or
include the Site-Shot SDK.

## Requirements

- n8n Cloud or self-hosted n8n. Site-Shot is
  [an n8n-verified integration](https://n8n.io/integrations/site-shot/), so it
  can be installed from the nodes panel on both; see
  [Compatibility](#compatibility) for the versions tested.
- A Site-Shot API key, from the
  [Site-Shot quickstart](https://www.site-shot.com/start/). A confirmed
  account's API key comes with the free plan: 100 API captures a month, no card
  needed. An account confirmed before 2026-10-30 switches it on with one button
  on the quickstart page; an account that has had a paid plan before does not
  get the free plan. [Paid plans](https://www.site-shot.com/pricing/) start at
  $5/mo for 2,000.

## Installation

- **n8n Cloud, or self-hosted n8n with verified community nodes:** open the
  nodes panel, search for **Site-Shot** and install it. An instance owner or
  admin does this once; see
  [n8n's guide to installing verified community nodes](https://docs.n8n.io/integrations/community-nodes/installation-and-management/install-verified-community-nodes/).
- **Self-hosted n8n otherwise:** the instance owner installs it under
  **Settings → Community Nodes** by entering the package name,
  `n8n-nodes-siteshot`.

The versions published to npm are listed on its
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

The credential test does not take a screenshot and does not count against your
captures. n8n can run it on its own, for example when a saved credential is
opened, so creating, opening and re-testing the credential can each send a
request. How n8n runs the test is described in [DEVELOPMENT.md](DEVELOPMENT.md).

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
failed item keeps its input JSON and pairing and has no binary field. It gains
`error` (the message), `errorReason` (a stable code such as `invalid_api_key`,
`page_unreachable` or `subscription_inactive`), `errorDescription` (what to do)
and, when the API answered, `httpCode`.

Limits, fixed in this version:

- **Request timeout: 90 seconds**, handed to n8n's HTTP helper: the API's
  default 60-second render deadline plus headroom. It is only as strict as that
  helper, and it has not been measured against a real clock.
- **Largest screenshot: 32 MiB.** The check runs after the response has been
  received and before the image is decoded, so it stops an oversized image from
  being passed on but does not stop it being downloaded.

## Compatibility

- **Tested:** n8n 2.40.5 and n8n 2.43.6, in their official Docker images for
  linux/arm64, against the live Site-Shot API: installing the package, the
  credential test, PNG, JPEG and WebP captures, a rejected key, an address that
  does not exist, and Continue On Fail.
  Other versions, other architectures and n8n Cloud itself have not been tested
  by this project; on n8n Cloud the node is installed through the verified
  listing.
- **Package:** no runtime dependencies; `n8n-workflow` is a peer dependency
  that n8n provides.

## Development

Building, testing, the local runtime fixture and the release steps are in
[DEVELOPMENT.md](DEVELOPMENT.md).

## Version history

- **0.1.3:** new options **Block Ads**, **Remove Cookie Banners** and
  **Delay (Ms)**, and the **WebP** format. All are off or unset by default, so
  existing workflows send the same request. A page that cannot be opened, such
  as a mistyped or non-existent address, is reported as such instead of as a
  render timeout. A Format that is not `png`, `jpeg` or `webp` (for example from
  an expression) is rejected before a request is sent; `jpg` and other letter
  cases are accepted. The credential test explains a rejected key instead of
  showing only "Unauthorized", and the credential's documentation link opens
  the quickstart. With Continue On Fail, a failed item also carries
  `errorReason`, `errorDescription` and `httpCode`.
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
