import test from 'node:test';
import assert from 'node:assert/strict';

import {
	PNG_B64,
	PNG_BYTES,
	createExecuteContext,
	fullResponse,
	loadDist,
} from './helpers.mjs';

const { SiteShot } = loadDist('nodes/SiteShot/SiteShot.node.js');

function run(ctx) {
	return new SiteShot().execute.call(ctx);
}

test('a successful PNG capture returns the decoded image as binary data', async () => {
	const ctx = createExecuteContext({
		params: { url: 'https://example.com/', binaryPropertyName: 'data' },
		transport: fullResponse({ image: PNG_B64 }),
	});

	const [output] = await run(ctx);

	assert.equal(output.length, 1);
	assert.equal(output[0].binary.data.mimeType, 'image/png');
	assert.deepEqual(ctx.binaryCalls[0].buffer, PNG_BYTES);
});
