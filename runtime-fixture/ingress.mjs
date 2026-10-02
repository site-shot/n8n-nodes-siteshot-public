// Единственный вход снаружи: с 127.0.0.1 на редактор n8n.
//
// Это НЕ прокси. Апстрим зашит константой и не берётся ни из запроса, ни из
// заголовков: CONNECT, абсолютные URI и произвольная маршрутизация здесь
// невозможны в принципе, потому что содержимое соединения вообще не
// разбирается -- это встречный перенос байтов на фиксированный адрес.
//
// Контейнер с этим файлом -- единственный, кто подключён и к внутренней сети,
// и к сети с опубликованным портом. Сам n8n остаётся только во внутренней
// сети и выхода наружу не получает.
import { createServer, connect } from 'node:net';
import { env } from 'node:process';

const UPSTREAM_HOST = 'ssrt-n8n';
const UPSTREAM_PORT = 5678;
const LISTEN_PORT = Number(env.INGRESS_PORT ?? 5678);

createServer((client) => {
  const upstream = connect(UPSTREAM_PORT, UPSTREAM_HOST);
  const drop = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', drop);
  upstream.on('error', drop);
  client.pipe(upstream);
  upstream.pipe(client);
}).listen(LISTEN_PORT, '0.0.0.0', () =>
  console.log(`ingress ${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`),
);
