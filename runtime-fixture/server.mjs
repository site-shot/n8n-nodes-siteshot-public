// Синтетический Site-Shot для изолированного прогона. Только встроенные
// модули Node: у фикстуры не должно быть ни одной зависимости.
//
// Сервер намеренно тупой: он не притворяется настоящим API и не делает
// скриншотов. Он отдаёт заранее известные байты и ЗАПИСЫВАЕТ КАЖДЫЙ запрос,
// потому что доказательства строятся на подсчёте запросов и на том, где
// оказался ключ.
import { createServer } from 'node:https';
import { readFileSync, appendFileSync } from 'node:fs';
import { argv, env } from 'node:process';

const CERT_DIR = env.CERT_DIR ?? '/certs';
const STATE_DIR = env.STATE_DIR ?? '/state';
const LOG = `${STATE_DIR}/requests.jsonl`;
const MODE_FILE = `${STATE_DIR}/mode`;

// Ключи фикстуры. Настоящих ключей здесь нет и быть не может.
const VALID_KEY = env.FIXTURE_VALID_KEY;
const BLOCKED_KEY = env.FIXTURE_BLOCKED_KEY;
if (!VALID_KEY || !BLOCKED_KEY) throw new Error('FIXTURE_VALID_KEY/FIXTURE_BLOCKED_KEY обязательны');

// Заранее известные байты. Проверяется именно совпадение с ними, а не то,
// что «пришло что-то похожее на картинку».
const PNG = readFileSync(`${STATE_DIR}/fixture.png`);
const JPEG = readFileSync(`${STATE_DIR}/fixture.jpg`);

// Конечный набор режимов. Файл режима ОБЯЗАТЕЛЕН и обязан содержать ровно
// одно из этих значений. Молчаливого отката к 'ok' здесь нет намеренно: он
// превратил бы сломанную настройку фикстуры в зелёный тест.
const MODES = new Set(['ok', 'redirect-same', 'redirect-cross', 'slow', 'slow-401', 'oversize']);

const mode = () => {
  const raw = readFileSync(MODE_FILE, 'utf8').trim();
  if (!MODES.has(raw)) throw new Error(`недопустимый режим фикстуры: ${JSON.stringify(raw)}`);
  return raw;
};

let seq = 0;
const log = (entry) => appendFileSync(LOG, JSON.stringify({ seq: ++seq, at: Date.now(), ...entry }) + '\n');

const send = (res, status, body, headers = {}) => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length, ...headers });
  res.end(buf);
};

const server = createServer(
  { key: readFileSync(`${CERT_DIR}/server.key`), cert: readFileSync(`${CERT_DIR}/server.crt`) },
  (req, res) => {
    try {
      handle(req, res);
    } catch (err) {
      log({ event: 'fixture-error', message: String(err && err.message) });
      send(res, 500, JSON.stringify({ error: `fixture failure: ${String(err && err.message)}` }));
    }
  },
);

function handle(req, res) {
    const host = (req.headers.host ?? '').split(':')[0];
    const [path, query = ''] = req.url.split('?');
    const params = new URLSearchParams(query);

    log({
      host,
      method: req.method,
      path,
      // Сырая строка запроса -- по ней проверяется, что ключа в ней нет.
      query,
      // Имена всех заголовков: доказательство «только userkey и ничего
      // сверху» строится на полном списке, а не на выборочной проверке.
      header_names: Object.keys(req.headers).sort(),
      userkey_header: req.headers.userkey ?? null,
      userkey_query: params.get('userkey'),
      authorization: req.headers.authorization ?? null,
    });

    // Сток редиректа. Каждое попадание сюда -- это провал теста на редирект,
    // поэтому он обязан быть видимым, а не молчаливым.
    if (path === '/v1.0/sink') return send(res, 200, '{"status":"sink-was-reached"}');

    if (path === '/v1.0/credential-check') {
      const m = mode();
      if (m === 'redirect-same')
        return send(res, 302, '{"status":"redirect"}', { location: 'https://api.site-shot.com/v1.0/sink' });
      if (m === 'redirect-cross')
        return send(res, 302, '{"status":"redirect"}', { location: 'https://redirect-sink.test/v1.0/sink' });
      if (m === 'slow') return setTimeout(() => send(res, 200, '{"status":"ok"}'), 25_000);
      // Отказ с задержкой: каждая попытка укладывается в объявленные 10 с, но
      // n8n делает на 401 ещё одну. Нужен, чтобы измерить СУММУ, а не обещать
      // её: таймаут здесь -- на попытку, а не на всю кнопку Test.
      if (m === 'slow-401')
        return setTimeout(() => send(res, 401, '{"status":"unauthorized"}'), 6_000);

      const key = req.headers.userkey;
      if (key === undefined) return send(res, 401, '{"status":"unauthorized"}');
      if (key === BLOCKED_KEY) return send(res, 403, '{"status":"forbidden"}');
      if (key !== VALID_KEY) return send(res, 401, '{"status":"unauthorized"}');
      return send(res, 200, '{"status":"ok"}');
    }

    // Съёмка: ключ по опубликованному контракту идёт параметром запроса.
    if (path === '/') {
      const key = params.get('userkey');
      if (key === BLOCKED_KEY) return send(res, 403, '{"error":"subscription"}');
      if (key !== VALID_KEY) return send(res, 401, '{"error":"unauthorized"}');
      if (params.get('response_type') !== 'json') return send(res, 400, '{"error":"bad response_type"}');
      // Ответ заведомо больше предела узла (32 MiB). Нужен, чтобы измерить,
      // КОГДА срабатывает защита: тело к тому моменту уже получено целиком.
      if (mode() === 'oversize') {
        const oversize = Buffer.alloc(33_554_432 + 1024, 0x41).toString('base64');
        return send(res, 200, JSON.stringify({ image: oversize }));
      }

      const format = params.get('format');
      // Неизвестный формат -- ошибка фикстуры, а не тихая подстановка PNG:
      // иначе запрос с опечаткой в format выглядел бы успешным.
      if (format !== 'png' && format !== 'jpeg')
        return send(res, 400, JSON.stringify({ error: `fixture: unknown format ${format}` }));
      const image = format === 'jpeg' ? JPEG : PNG;
      return send(res, 200, JSON.stringify({ image: image.toString('base64') }));
    }

    return send(res, 404, '{"status":"not_found"}');
}

// Режим проверяется на старте, а не при первом запросе: сломанная настройка
// обязана упасть сразу и заметно.
const startupMode = mode();

server.listen(Number(argv[2] ?? 443), '0.0.0.0', () =>
  log({ event: 'listening', mode: startupMode }),
);
