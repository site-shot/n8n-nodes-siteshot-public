import type {
	IAuthenticate,
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestOptions,
	INodeProperties,
} from 'n8n-workflow';

/** The one host this credential is ever sent to. */
const API_BASE_URL = 'https://api.site-shot.com';

/** The dedicated credential-check route. Nothing else may use the header form. */
const CREDENTIAL_CHECK_PATH = '/v1.0/credential-check';

/**
 * The check route is meant to answer without rendering anything, so a slow
 * answer means it is broken. Applied per attempt in `authenticate` — see the
 * comment there.
 */
const CHECK_TIMEOUT_MS = 10_000;

/** The one request that takes the header form, as an absolute URL. */
const CREDENTIAL_CHECK_URL = `${API_BASE_URL}${CREDENTIAL_CHECK_PATH}`;

/**
 * Is this the fixed credential-test request?
 *
 * Matched on the whole resolved URL, so both spellings of the same request are
 * recognised: the `baseURL` + `url` pair this credential declares, and the
 * single absolute URL it becomes if n8n resolves the pair before calling this
 * hook. Failing to recognise one would silently fall through to the query
 * form, which is the leak this function exists to prevent.
 *
 * Anything else — every capture — keeps the published query-parameter
 * behaviour.
 */
function isCredentialCheckRequest(requestOptions: IHttpRequestOptions): boolean {
	return `${requestOptions.baseURL ?? ''}${requestOptions.url ?? ''}` === CREDENTIAL_CHECK_URL;
}

/**
 * Site-Shot authenticates with a `userkey` credential — not a bearer token.
 *
 * Where that key is placed depends on the request, which is why this is a
 * function rather than a generic `qs` declaration:
 *
 * - **Capture** sends it as the `userkey` **query parameter**. That is the
 *   published API contract and is not changed here.
 * - **The credential test** sends it as the `userkey` **header** and never in
 *   the query. n8n runs `test.request` through a RoutingNode, so this hook is
 *   applied to it too; a generic `qs` declaration would append `?userkey=...`
 *   to the check URL and write the key into every access log along the way.
 *
 * Either way the key is injected here and only here, so the node's own code
 * never reads or holds it.
 */
export class SiteShotApi implements ICredentialType {
	name = 'siteShotApi';

	displayName = 'Site-Shot API';

	documentationUrl = 'https://www.site-shot.com/#documentation';

	icon = 'file:icons/SiteShot.svg' as const;

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'Your Site-Shot API key. Site-Shot sends it as the <code>userkey</code> query parameter. A paid plan is required; there is no free API tier.',
		},
	];

	authenticate: IAuthenticate = async (
		credentials: ICredentialDataDecryptedObject,
		requestOptions: IHttpRequestOptions,
	): Promise<IHttpRequestOptions> => {
		const apiKey = String(credentials.apiKey ?? '');

		if (isCredentialCheckRequest(requestOptions)) {
			// Header only. `qs` is passed through untouched — whatever n8n
			// handed over, usually an empty object — so the key cannot reach
			// the request line.
			return {
				...requestOptions,
				// n8n overwrites `options.timeout` for every credential test
				// (`routing-node.ts:225-229` in 2.40.5), so a timeout declared on
				// `test.request` never reaches the transport. This hook runs last,
				// on the finished options, so the bound is applied here, per
				// attempt. Regression: `runtime-fixture/runtime-gate.sh`.
				timeout: CHECK_TIMEOUT_MS,
				headers: { ...requestOptions.headers, userkey: apiKey },
			};
		}

		// Capture: the published contract. `headers` is left untouched, so no
		// auth header is invented on the capture path.
		return {
			...requestOptions,
			qs: { ...requestOptions.qs, userkey: apiKey },
		};
	};

	/**
	 * Credential test against the dedicated check route.
	 *
	 * The route's contract: it accepts or rejects the key as a capture would,
	 * and answers without taking a screenshot or spending capture quota.
	 * That it is live, and what one live test did cost, is stated once, in the
	 * README ("The credential test and your quota").
	 *
	 * The request carries no credential of its own: `authenticate` above is the
	 * single source of truth for where the key goes.
	 *
	 * Apart from the key in the `userkey` header, nothing identifying is sent:
	 * no target URL, no body, no account id.
	 */
	test: ICredentialTestRequest = {
		request: {
			baseURL: API_BASE_URL,
			url: CREDENTIAL_CHECK_PATH,
			method: 'GET',
			// No `timeout` here on purpose: n8n overwrites it. The bound lives in
			// `authenticate` above.
			//
			// A redirect must never carry the key somewhere else, and following
			// one would defeat the point of testing this exact route. All three
			// are belt and braces on purpose: the first stops the redirect being
			// followed at all, the others stop the key travelling if it ever is.
			disableFollowRedirect: true,
			sendCredentialsOnCrossOriginRedirect: false,
			allowedDomains: 'api.site-shot.com',
		},
		rules: [
			{
				// A valid key on a lapsed plan: the key itself is fine, and saying
				// otherwise would send the user to fix the wrong thing.
				type: 'responseCode',
				properties: {
					value: 403,
					message:
						'The API key is valid, but the Site-Shot account has no active subscription.',
				},
			},
		],
	};
}
