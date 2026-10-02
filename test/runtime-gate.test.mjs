/**
 * Guards on the local runtime fixture's one required input: the Python
 * interpreter of a project `.venv`, passed explicitly to `up`.
 *
 * The fixture itself needs Docker and is never run here. Each case runs a
 * sandboxed copy of runtime-gate.sh with docker, npm and every other tool it
 * could reach replaced by stubs that record the call and fail, so a malformed
 * input cannot touch a container, a network or an API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { PACKAGE_ROOT } from './helpers.mjs';

const GATE = readFileSync(join(PACKAGE_ROOT, 'runtime-fixture/runtime-gate.sh'), 'utf8');

/** Every external command the gate could reach, including a Python found on PATH. */
const STUBBED = ['docker', 'npm', 'openssl', 'jq', 'lsof', 'curl', 'python', 'python3'];

const STUB = `#!/bin/sh
printf '%s\\n' "\${0##*/} $*" >> "$CALLS"
exit "\${STUB_EXIT:-97}"
`;

/** A venv interpreter that answers the gate's two questions from its environment. */
const FAKE_PYTHON = `#!/bin/sh
printf '%s\\n' "venv-python $*" >> "$CALLS"
case "$*" in
  *sys.prefix*) printf '%s\\n' "$FAKE_PREFIX" ;;
  *'import PIL'*) exit "\${FAKE_PIL_EXIT:-0}" ;;
  *) exit 98 ;;
esac
`;

function writeExecutable(path, content, mode = 0o755) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	chmodSync(path, mode);
}

function sandbox(t) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), 'siteshot-gate-')));
	t.after(() => rmSync(root, { recursive: true, force: true }));

	const bin = join(root, 'bin');
	for (const name of STUBBED) writeExecutable(join(bin, name), STUB);
	const script = join(root, 'runtime-fixture/runtime-gate.sh');
	mkdirSync(dirname(script));
	writeFileSync(script, GATE);
	const calls = join(root, 'calls.log');

	return {
		root,

		/** A project `.venv` whose interpreter is the fake above. */
		venv(project = 'project', { cfg = true, mode = 0o755 } = {}) {
			const dir = join(root, project, '.venv');
			const python = join(dir, 'bin/python');
			writeExecutable(python, FAKE_PYTHON, mode);
			if (cfg) writeFileSync(join(dir, 'pyvenv.cfg'), 'home = /nonexistent\n');
			return { dir, python };
		},

		run(args, env = {}) {
			writeFileSync(calls, '');
			const result = spawnSync('/bin/bash', [script, ...args], {
				encoding: 'utf8',
				env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, CALLS: calls, ...env },
				timeout: 20_000,
			});
			const lines = readFileSync(calls, 'utf8').split('\n').filter(Boolean);
			return {
				status: result.status,
				stdout: result.stdout,
				stderr: result.stderr,
				tools: lines.filter((line) => !line.startsWith('venv-python ')),
				python: lines.filter((line) => line.startsWith('venv-python ')),
			};
		},
	};
}

/** The gate stopped with its fatal status, for the given reason, having touched nothing. */
function refused(result, reason, pythonCalls = 0) {
	assert.equal(result.status, 2, `exit ${result.status}\n${result.stdout}${result.stderr}`);
	assert.match(result.stderr, reason);
	assert.deepEqual(result.tools, [], 'the gate reached an external command');
	assert.equal(result.python.length, pythonCalls, result.python.join('\n'));
}

test('up requires exactly one interpreter argument and searches for no other Python', (t) => {
	const box = sandbox(t);
	const { dir, python } = box.venv();
	for (const args of [[], ['up'], ['up', python, 'extra']]) {
		refused(box.run(args, { FAKE_PREFIX: dir }), /ровно один аргумент.*\.venv\/bin\/python/);
	}
});

test('up accepts only an absolute path to the python of a .venv, without running anything else', (t) => {
	const box = sandbox(t);
	box.venv();
	const plain = join(box.root, 'plain/bin/python');
	writeExecutable(plain, FAKE_PYTHON);

	refused(box.run(['up', 'project/.venv/bin/python']), /абсолютным путём вида/);
	refused(box.run(['up', plain]), /абсолютным путём вида/);
	refused(box.run(['up', join(box.root, 'project/.venv/bin/python3')]), /абсолютным путём вида/);
});

test('up refuses a missing or non-executable interpreter without running it', (t) => {
	const box = sandbox(t);
	refused(box.run(['up', join(box.root, 'absent/.venv/bin/python')]), /нет исполняемого файла интерпретатора/);

	const { python } = box.venv('project', { mode: 0o644 });
	refused(box.run(['up', python]), /нет исполняемого файла интерпретатора/);
});

test('up refuses a .venv directory that is not a virtual environment', (t) => {
	const box = sandbox(t);
	const { python } = box.venv('project', { cfg: false });
	refused(box.run(['up', python]), /нет pyvenv\.cfg/);
});

test('up refuses an interpreter that does not run as that virtual environment', (t) => {
	const box = sandbox(t);
	const { python } = box.venv();
	const other = box.venv('other');

	// A base interpreter reports no venv prefix at all.
	refused(box.run(['up', python], { FAKE_PREFIX: '' }), /работает не как venv/, 1);
	// A link into somebody else's environment reports that environment.
	refused(box.run(['up', python], { FAKE_PREFIX: other.dir }), /работает не как venv/, 1);
});

test('up refuses a virtual environment without Pillow', (t) => {
	const box = sandbox(t);
	const { dir, python } = box.venv();
	refused(box.run(['up', python], { FAKE_PREFIX: dir, FAKE_PIL_EXIT: '1' }), /нет Pillow/, 2);
});

test('a valid interpreter is checked before up asks Docker anything', (t) => {
	const box = sandbox(t);
	const { dir, python } = box.venv();
	const result = box.run(['up', python], { FAKE_PREFIX: dir });

	// The stubbed Docker daemon is unreachable, so the gate stops at its first question.
	assert.equal(result.status, 2, result.stderr);
	assert.match(result.stderr, /демон docker недоступен/);
	assert.equal(result.python.length, 2, result.python.join('\n'));
	assert.deepEqual(result.tools, ['docker info']);
});

test('down and status need no interpreter, so cleanup never depends on a venv', (t) => {
	const box = sandbox(t);

	// Docker finds none of the fixture's resources.
	const down = box.run(['down'], { STUB_EXIT: '1' });
	assert.equal(down.status, 0, down.stderr);
	assert.equal(down.tools.length, 6, down.tools.join('\n'));
	for (const call of down.tools) assert.match(call, /^docker (container|volume|network) inspect ssrt-/);
	assert.deepEqual(down.python, []);

	const status = box.run(['status'], { STUB_EXIT: '0' });
	assert.equal(status.status, 0, status.stderr);
	assert.deepEqual(
		status.tools.map((call) => call.split(' ').slice(0, 3).join(' ')),
		['docker ps -a', 'docker network ls', 'docker volume ls'],
	);
	assert.deepEqual(status.python, []);
});
