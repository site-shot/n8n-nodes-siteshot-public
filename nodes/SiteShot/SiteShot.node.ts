import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	API_ENDPOINT,
	CREDENTIALS_NAME,
	IMAGE_FORMATS,
	REQUEST_TIMEOUT_MS,
	buildCaptureQuery,
	decodeCaptureImage,
	extractCaptureImage,
	normalizeFormat,
	requestTimeoutFor,
	toCaptureFailure,
	validateTargetUrl,
	validateViewport,
	type CaptureOptions,
} from './capture';

/** Reasons that are the user's own input, not something the API said. */
const INPUT_REASONS = new Set(['invalid_url', 'invalid_options']);

export class SiteShot implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Site-Shot',
		name: 'siteShot',
		icon: { light: 'file:siteShot.svg', dark: 'file:siteShot.dark.svg' },
		group: ['transform'],
		version: 1,
		description: 'Capture a screenshot of a public web page with Site-Shot',
		subtitle: '={{$parameter["url"]}}',
		defaults: { name: 'Site-Shot' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: CREDENTIALS_NAME, required: true }],
		properties: [
			{
				displayName: 'URL',
				name: 'url',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'https://example.com/pricing',
				description:
					'Full address of the public page to capture. Must start with http:// or https://.',
			},
			{
				displayName: 'Put Output File in Field',
				name: 'binaryPropertyName',
				type: 'string',
				required: true,
				default: 'data',
				hint: 'The name of the output binary field to put the screenshot in',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				options: [
					{
						displayName: 'Block Ads',
						name: 'blockAds',
						type: 'boolean',
						default: false,
						description:
							'Whether to block common ads before the page is captured. Uses a block list, so some ads may remain.',
					},
					{
						displayName: 'Delay (Ms)',
						name: 'delay',
						type: 'number',
						default: 3000,
						typeOptions: { minValue: 0, maxValue: 30000 },
						description:
							'Milliseconds to wait after the page loads before capturing, between 0 and 30000. Useful for pages that animate or load content late. Not sent unless added. When it is not added, Site-Shot applies its own wait, and waits 3000 ms when it retries a capture that came out as an error or half-loaded page. A value set here is also used on that retry, so a value below 3000 shortens it. This node waits up to 90 seconds plus twice the delay for the answer.',
					},
					{
						displayName: 'Format',
						name: 'format',
						type: 'options',
						default: 'png',
						description: 'Image format of the returned screenshot',
						options: [
							{ name: 'PNG', value: 'png' },
							{ name: 'JPEG', value: 'jpeg' },
							{
								name: 'WebP',
								value: 'webp',
								description:
									'Lossless. A full-page capture taller than 16,383 px is cut at 16,383 px.',
							},
						],
					},
					{
						displayName: 'Full Page',
						name: 'fullPage',
						type: 'boolean',
						default: false,
						description:
							'Whether to capture the whole scrollable page instead of just the viewport',
					},
					{
						displayName: 'Remove Cookie Banners',
						name: 'removeCookieBanners',
						type: 'boolean',
						default: false,
						description:
							'Whether to try to remove common cookie-consent banners and popups before capturing. Uses a block list, so a banner a site draws itself may remain.',
					},
					{
						displayName: 'Viewport Height',
						name: 'height',
						type: 'number',
						default: 768,
						typeOptions: { minValue: 100, maxValue: 20000 },
						description: 'Viewport height in pixels, between 100 and 20000',
					},
					{
						displayName: 'Viewport Width',
						name: 'width',
						type: 'number',
						default: 1024,
						typeOptions: { minValue: 100, maxValue: 8000 },
						description: 'Viewport width in pixels, between 100 and 8000',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const output: INodeExecutionData[] = [];

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			// Named in a timeout failure, so it is known before the request goes out.
			let timeoutMs = REQUEST_TIMEOUT_MS;
			try {
				// Input is validated before anything is sent: a rejected capture
				// still costs quota, so a bad URL must never reach the API.
				const url = validateTargetUrl(this.getNodeParameter('url', itemIndex, ''));
				const options = this.getNodeParameter('options', itemIndex, {}) as CaptureOptions;
				validateViewport(options);
				const format = normalizeFormat(options.format);
				timeoutMs = requestTimeoutFor(options);

				const binaryPropertyName = this.getNodeParameter(
					'binaryPropertyName',
					itemIndex,
					'data',
				) as string;
				const spec = IMAGE_FORMATS[format];

				const response = await this.helpers.httpRequestWithAuthentication.call(
					this,
					CREDENTIALS_NAME,
					{
						method: 'GET',
						url: API_ENDPOINT,
						qs: buildCaptureQuery(url, options) as IDataObject,
						json: true,
						// Statuses are classified here rather than by the transport, so a
						// 401 can be told apart from a 403 and from an HTTP 200 that
						// carries a capture failure.
						returnFullResponse: true,
						ignoreHttpStatusErrors: true,
						// A Delay is waited out inside the render, possibly twice.
						timeout: timeoutMs,
						// The key is only ever valid for this host; never let a redirect
						// carry it anywhere else.
						allowedDomains: 'api.site-shot.com',
						sendCredentialsOnCrossOriginRedirect: false,
					},
				);

				const image = extractCaptureImage({
					statusCode: response?.statusCode as number,
					body: response?.body,
				});
				const buffer = decodeCaptureImage(image, format);

				output.push({
					json: items[itemIndex].json,
					binary: {
						[binaryPropertyName]: await this.helpers.prepareBinaryData.call(
							this,
							buffer,
							spec.fileName,
							spec.mimeType,
						),
					},
					pairedItem: { item: itemIndex },
				});
			} catch (error) {
				// Everything thrown here is reduced to a failure this node authored.
				// A raw transport error embeds the request URL — `userkey` included —
				// in its message, config and response, so none of it is passed on.
				const failure = toCaptureFailure(error, timeoutMs);

				if (this.continueOnFail()) {
					// The same safe fields an error would carry, so a workflow can
					// branch on the reason instead of parsing the message.
					const details: IDataObject = { error: failure.message, errorReason: failure.reason };
					if (failure.description !== undefined) details.errorDescription = failure.description;
					if (failure.httpCode !== undefined) details.httpCode = failure.httpCode;
					output.push({
						json: { ...items[itemIndex].json, ...details },
						pairedItem: { item: itemIndex },
					});
					continue;
				}

				if (INPUT_REASONS.has(failure.reason)) {
					throw new NodeOperationError(this.getNode(), failure.message, {
						description: failure.description,
						itemIndex,
					});
				}

				throw new NodeApiError(
					this.getNode(),
					{ message: failure.message },
					{
						message: failure.message,
						description: failure.description,
						httpCode: failure.httpCode,
						itemIndex,
					},
				);
			}
		}

		return [output];
	}
}
