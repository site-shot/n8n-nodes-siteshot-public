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
	toCaptureFailure,
	validateTargetUrl,
	validateViewport,
	type CaptureOptions,
	type ImageFormat,
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
						displayName: 'Format',
						name: 'format',
						type: 'options',
						default: 'png',
						description: 'Image format of the returned screenshot',
						options: [
							{ name: 'PNG', value: 'png' },
							{ name: 'JPEG', value: 'jpeg' },
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
			try {
				// Input is validated before anything is sent: a rejected capture
				// still costs quota, so a bad URL must never reach the API.
				const url = validateTargetUrl(this.getNodeParameter('url', itemIndex, ''));
				const options = this.getNodeParameter('options', itemIndex, {}) as CaptureOptions;
				validateViewport(options);

				const binaryPropertyName = this.getNodeParameter(
					'binaryPropertyName',
					itemIndex,
					'data',
				) as string;
				const format = (options.format ?? 'png') as ImageFormat;
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
						timeout: REQUEST_TIMEOUT_MS,
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
				const failure = toCaptureFailure(error);

				if (this.continueOnFail()) {
					output.push({
						json: { ...items[itemIndex].json, error: failure.message },
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
