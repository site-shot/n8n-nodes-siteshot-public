#!/usr/bin/env bash
# Прогон кандидата против НАСТОЯЩЕГО n8n в изолированной фикстуре.
#
# Никаких боевых систем: сеть runtime закрыта (internal=true), наружу выхода
# нет, api.site-shot.com резолвится только внутрь фикстуры. Ключи, учётка и
# сертификаты -- одноразовые и синтетические.
#
#   ./runtime-gate.sh up /абсолютный/путь/.venv/bin/python
#                            -- собрать, поднять, прогнать, оставить редактор
#   ./runtime-gate.sh down   -- убрать РОВНО свои ресурсы
#   ./runtime-gate.sh status -- кто сейчас поднят
#
# Python (с Pillow) нужен только up и берётся только из явно переданного
# интерпретатора .venv проекта: без поиска по PATH и без запасных путей.
# down и status его не требуют -- уборка не зависит от того, жив ли venv.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
STATE="$HERE/.state"

IMAGE="docker.n8n.io/n8nio/n8n@sha256:de7539cae510d65a0aaed9fbef0113f395cea92337edf653c8ed21dd5de0d46d"
EXPECT_N8N=2.40.5
EXPECT_CORE=2.40.3
EXPECT_WORKFLOW=2.40.1
EXPECT_NODE_ENGINE_MIN=24

LABEL=owner=siteshot-n8n-runtime-gate
NET_INT=ssrt-net
NET_EDGE=ssrt-edge
C_API=ssrt-api
C_N8N=ssrt-n8n
C_INGRESS=ssrt-ingress
VOL=ssrt-n8n-data
EDITOR_PORT=5679
BASE="http://127.0.0.1:$EDITOR_PORT"

# Всё синтетическое. Настоящих ключей и учёток здесь нет.
VALID_KEY=dummy-valid-key
BLOCKED_KEY=dummy-blocked-key
INVALID_KEY=dummy-wrong-key
OWNER_EMAIL=fixture@example.invalid
OWNER_PASS=FixturePass1
ENC_KEY=fixture-encryption-key-not-a-secret

pass=0; fail=0
ok()   { pass=$((pass+1)); printf '  ok   %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  ПРОВАЛ %s\n     %s\n' "$1" "${2-}"; }
die()  { printf 'ФАТАЛЬНО: %s\n' "$*" >&2; exit 2; }
eq()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "ожидалось [$3], получено [$2]"; fi; }
# Личность рантайма и изоляция -- это ПРЕДУСЛОВИЯ, а не наблюдения. Расхождение
# здесь обрывает прогон, иначе тесты пошли бы в непонятно какую сеть.
must() { if [ "$2" = "$3" ]; then ok "$1"; else die "$1: ожидалось [$3], получено [$2]"; fi; }
step() { printf '\n== %s\n' "$1"; }

dc() { docker "$@"; }

# --- Уборка: только свои ресурсы, по точным именам ---------------------------
# Убирается только то, что этот скрипт сам и создал: у каждого ресурса
# сверяется метка владельца. Чужой или доставшийся по наследству ресурс с тем
# же именем не трогается -- про него сообщается, и это отказ, а не успех.
owned() { # owned ВИД ИМЯ -> 0 если существует и наша, 1 если нет, 2 если чужая
  local kind="$1" name="$2" lbl tmpl='{{index .Labels "owner"}}'
  [ "$kind" = container ] && tmpl='{{index .Config.Labels "owner"}}'
  lbl=$(dc "$kind" inspect "$name" --format "$tmpl" 2>/dev/null) || return 1
  [ "$lbl" = "siteshot-n8n-runtime-gate" ] || return 2
  return 0
}

down() {
  local rc=0 kind name
  for spec in "container:$C_INGRESS" "container:$C_N8N" "container:$C_API" \
              "volume:$VOL" "network:$NET_INT" "network:$NET_EDGE"; do
    kind="${spec%%:*}"; name="${spec#*:}"
    st=0; owned "$kind" "$name" || st=$?
    case $st in
      1) echo "  нет:     $kind $name"; continue ;;
      2) echo "  ЧУЖОЙ:   $kind $name -- не тронут"; rc=1; continue ;;
    esac
    if [ "$kind" = container ]; then
      dc rm -f "$name" >/dev/null || { echo "  не удалить: $kind $name"; rc=1; continue; }
    else
      dc "$kind" rm "$name" >/dev/null || { echo "  не удалить: $kind $name"; rc=1; continue; }
    fi
    # Постусловие: ресурса больше нет. Без этой проверки «убрано» было бы
    # просто словом.
    if dc "$kind" inspect "$name" >/dev/null 2>&1; then
      echo "  ОСТАЛСЯ:  $kind $name"; rc=1
    else
      echo "  убран:   $kind $name"
    fi
  done
  return $rc
}

status() {
  echo "контейнеры:"; dc ps -a --filter "label=$LABEL" --format '  {{.Names}}  {{.Status}}'
  echo "сети:";       dc network ls --filter "label=$LABEL" --format '  {{.Name}}'
  echo "тома:";       dc volume ls --filter "label=$LABEL" --format '  {{.Name}}'
  echo "редактор:     $BASE"
}

# --- Интерпретатор: ровно переданный, и только из venv ------------------------
# Проверяется ДО первого обращения к docker. Имя пути ничего не доказывает,
# поэтому venv подтверждает сам интерпретатор: его sys.prefix обязан быть этим
# самым каталогом .venv, а не базовой установкой и не чужим окружением.
venv_python() { # venv_python ПУТЬ -> VENV_PY или ФАТАЛЬНО
  local py="$1" venv prefix
  case "$py" in
    /*/.venv/bin/python) ;;
    *) die "интерпретатор задаётся абсолютным путём вида /…/.venv/bin/python, получено: $py" ;;
  esac
  [ -f "$py" ] && [ -x "$py" ] || die "нет исполняемого файла интерпретатора: $py"
  venv="$(cd "$(dirname "$py")/.." && pwd -P)"
  [ -f "$venv/pyvenv.cfg" ] || die "$venv -- не venv: нет pyvenv.cfg"
  prefix="$("$py" -I -c 'import os, sys; print(os.path.realpath(sys.prefix) if sys.prefix != sys.base_prefix else "")')" \
    || die "интерпретатор не запускается: $py"
  [ "$prefix" = "$venv" ] || die "$py работает не как venv $venv (sys.prefix: ${prefix:-не venv})"
  "$py" -I -c 'import PIL' >/dev/null 2>&1 || die "в venv $venv нет Pillow (нужен для байтов-образцов)"
  VENV_PY="$py"
}

case "${1-up}" in
  down) down; exit 0 ;;
  status) status; exit 0 ;;
  up) [ $# -eq 2 ] || die "нужен ровно один аргумент -- интерпретатор .venv проекта: $0 up /абсолютный/путь/.venv/bin/python" ;;
  *) die "неизвестная команда: $1 (up|down|status)" ;;
esac

# --- Предусловия: всё закрытое, без обходных путей ---------------------------
step "Предусловия"
venv_python "$2"
echo "  интерпретатор: $VENV_PY"
command -v docker >/dev/null || die "нет docker"
dc info >/dev/null 2>&1 || die "демон docker недоступен"
command -v jq >/dev/null || die "нет jq"
command -v openssl >/dev/null || die "нет openssl"
dc image inspect "$IMAGE" >/dev/null 2>&1 || die "образ не скачан: docker pull $IMAGE"

# Занятое имя -- это чужое или недоубранное состояние. Переиспользовать его
# нельзя: docker volume create и network create молча вернут существующий
# ресурс с неизвестным содержимым.
for n in "$C_API" "$C_N8N" "$C_INGRESS"; do
  dc container inspect "$n" >/dev/null 2>&1 &&
    die "контейнер $n уже существует -- сначала $0 down"
done
for n in "$NET_INT" "$NET_EDGE"; do
  dc network inspect "$n" >/dev/null 2>&1 &&
    die "сеть $n уже существует -- сначала $0 down"
done
dc volume inspect "$VOL" >/dev/null 2>&1 &&
  die "том $VOL уже существует -- сначала $0 down"
lsof -nP -iTCP:$EDITOR_PORT -sTCP:LISTEN >/dev/null 2>&1 &&
  die "порт $EDITOR_PORT уже занят"

# Личность образа -- из самого образа, а не из имени тега.
IMG_ARCH=$(dc image inspect "$IMAGE" --format '{{.Architecture}}/{{.Os}}')
[ "$IMG_ARCH" = "arm64/linux" ] || die "архитектура образа $IMG_ARCH, ожидалась arm64/linux"
echo "  образ: $IMAGE"
echo "  платформа: $IMG_ARCH"

# --- Сборка кандидата: ровно то, что поедет в n8n ----------------------------
step "Сборка кандидата"
( cd "$PKG" && npm run build >/dev/null 2>&1 ) || die "сборка кандидата провалилась"
[ -f "$PKG/dist/nodes/SiteShot/SiteShot.node.js" ] || die "нет собранного узла"
[ -f "$PKG/dist/credentials/SiteShotApi.credentials.js" ] || die "нет собранных учётных данных"
DIST_SHA=$("$VENV_PY" - "$PKG/dist" <<'PY'
import hashlib, pathlib, sys
root = pathlib.Path(sys.argv[1]); h = hashlib.sha256()
for f in sorted(p for p in root.rglob('*') if p.is_file()):
    h.update(str(f.relative_to(root)).encode()); h.update(f.read_bytes())
print(h.hexdigest())
PY
)
echo "  dist sha256: $DIST_SHA"

# --- Сертификаты: собственный CA, доверенный ТОЛЬКО внутри фикстуры ----------
step "Сертификаты фикстуры"
rm -rf "$STATE"; mkdir -p "$STATE/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -keyout "$STATE/certs/ca.key" -out "$STATE/certs/ca.pem" \
  -subj "/CN=siteshot-runtime-fixture-ca" >/dev/null 2>&1 || die "не удалось создать CA"
cat > "$STATE/certs/san.cnf" <<'CNF'
[req]
distinguished_name = dn
[dn]
[ext]
subjectAltName = DNS:api.site-shot.com, DNS:redirect-sink.test
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
CNF
openssl req -newkey rsa:2048 -nodes -keyout "$STATE/certs/server.key" \
  -out "$STATE/certs/server.csr" -subj "/CN=api.site-shot.com" >/dev/null 2>&1
openssl x509 -req -in "$STATE/certs/server.csr" -CA "$STATE/certs/ca.pem" \
  -CAkey "$STATE/certs/ca.key" -CAcreateserial -days 2 \
  -extfile "$STATE/certs/san.cnf" -extensions ext \
  -out "$STATE/certs/server.crt" >/dev/null 2>&1 || die "не удалось подписать сертификат"
openssl x509 -in "$STATE/certs/server.crt" -noout -text | grep -q "DNS:api.site-shot.com" \
  || die "в сертификате нет нужного SAN"
echo "  CA и серверный сертификат созданы (SAN: api.site-shot.com, redirect-sink.test)"

# --- Байты-образцы: известны заранее и сверяются побайтно --------------------
step "Байты-образцы"
"$VENV_PY" - "$STATE" <<'PY'
import sys, pathlib
from PIL import Image
state = pathlib.Path(sys.argv[1])
# Детерминированные, не одноцветные: так подмена «чем-нибудь похожим»
# не пройдёт незамеченной.
img = Image.new('RGB', (8, 8))
img.putdata([((x * 31) % 256, (y * 37) % 256, ((x + y) * 43) % 256)
             for y in range(8) for x in range(8)])
img.save(state / 'fixture.png', format='PNG', optimize=False)
img.save(state / 'fixture.jpg', format='JPEG', quality=80)
PY
PNG_SHA=$(shasum -a 256 "$STATE/fixture.png" | cut -d' ' -f1)
JPG_SHA=$(shasum -a 256 "$STATE/fixture.jpg" | cut -d' ' -f1)
echo "  fixture.png sha256=$PNG_SHA ($(wc -c < "$STATE/fixture.png" | tr -d ' ') байт)"
echo "  fixture.jpg sha256=$JPG_SHA ($(wc -c < "$STATE/fixture.jpg" | tr -d ' ') байт)"
printf 'ok' > "$STATE/mode"
: > "$STATE/requests.jsonl"

# --- Сети --------------------------------------------------------------------
step "Сети"
dc network create --internal --label "$LABEL" "$NET_INT" >/dev/null || die "не создать $NET_INT"
dc network create --label "$LABEL" "$NET_EDGE" >/dev/null || die "не создать $NET_EDGE"
must "внутренняя сеть закрыта (internal=true)" \
   "$(dc network inspect "$NET_INT" --format '{{.Internal}}')" "true"

# --- Контейнеры --------------------------------------------------------------
step "Контейнеры"
dc volume create --label "$LABEL" "$VOL" >/dev/null || die "не создать том"

dc run -d --name "$C_API" --label "$LABEL" --network "$NET_INT" \
  --network-alias api.site-shot.com --network-alias redirect-sink.test \
  --user 0 \
  -v "$HERE/server.mjs:/fixture/server.mjs:ro" \
  -v "$STATE:/state" -v "$STATE/certs:/certs:ro" \
  -e STATE_DIR=/state -e CERT_DIR=/certs \
  -e FIXTURE_VALID_KEY="$VALID_KEY" -e FIXTURE_BLOCKED_KEY="$BLOCKED_KEY" \
  --entrypoint node "$IMAGE" /fixture/server.mjs 443 >/dev/null || die "не поднять $C_API"

dc run -d --name "$C_N8N" --label "$LABEL" --network "$NET_INT" \
  -v "$VOL:/home/node/.n8n" \
  -v "$PKG/dist:/ext:ro" \
  -v "$STATE/certs:/certs:ro" \
  -v "$STATE:/state" \
  -e N8N_CUSTOM_EXTENSIONS=/ext \
  -e NODE_EXTRA_CA_CERTS=/certs/ca.pem \
  -e N8N_ENCRYPTION_KEY="$ENC_KEY" \
  -e N8N_DIAGNOSTICS_ENABLED=false \
  -e N8N_VERSION_NOTIFICATIONS_ENABLED=false \
  -e N8N_TEMPLATES_ENABLED=false \
  -e N8N_ONBOARDING_FLOW_DISABLED=true \
  -e N8N_SECURE_COOKIE=false \
  -e N8N_DEFAULT_BINARY_DATA_MODE=default \
  -e E2E_TESTS=false \
  -e GENERIC_TIMEZONE=UTC \
  "$IMAGE" >/dev/null || die "не поднять $C_N8N"

# Вход создаётся на bridge-сети: публикация порта на internal-сети не
# работает вовсе (проверено). К внутренней сети он подключается ВТОРЫМ шагом.
dc run -d --name "$C_INGRESS" --label "$LABEL" --network "$NET_EDGE" \
  -p "127.0.0.1:$EDITOR_PORT:5678" \
  -v "$HERE/ingress.mjs:/fixture/ingress.mjs:ro" \
  --entrypoint node "$IMAGE" /fixture/ingress.mjs >/dev/null || die "не поднять $C_INGRESS"
dc network connect "$NET_INT" "$C_INGRESS" || die "не подключить вход к внутренней сети"

trap 'echo; echo "(ресурсы оставлены поднятыми; убрать: $HERE/runtime-gate.sh down)"' EXIT

# --- Личность рантайма: из самого контейнера ---------------------------------
step "Личность рантайма"
RT=$(dc exec "$C_N8N" node -e '
const r = (p) => require(`/usr/local/lib/node_modules/n8n/node_modules/${p}/package.json`).version;
console.log(JSON.stringify({
  node: process.versions.node,
  n8n: require("/usr/local/lib/node_modules/n8n/package.json").version,
  core: r("n8n-core"),
  workflow: r("n8n-workflow"),
}));' 2>/dev/null) || die "не прочитать версии из контейнера"
must "n8n в образе"          "$(jq -r .n8n      <<<"$RT")" "$EXPECT_N8N"
must "n8n-core в образе"     "$(jq -r .core     <<<"$RT")" "$EXPECT_CORE"
must "n8n-workflow в образе" "$(jq -r .workflow <<<"$RT")" "$EXPECT_WORKFLOW"
# Версия Node берётся из образа, а не назначается: проверяется, что она
# удовлетворяет engines самого n8n (>= 24), а не равна догадке.
NODE_VERSION=$(jq -r .node <<<"$RT")
NODE_MAJOR=${NODE_VERSION%%.*}
ENGINE_MIN=$(dc exec "$C_N8N" node -e \
  'console.log(require("/usr/local/lib/node_modules/n8n/package.json").engines.node)' 2>/dev/null | tr -d '\r')
must "engines.node у n8n в образе" "$ENGINE_MIN" ">=$EXPECT_NODE_ENGINE_MIN.0.0"
[ "$NODE_MAJOR" -ge "$EXPECT_NODE_ENGINE_MIN" ] ||
  die "Node $NODE_VERSION не удовлетворяет engines $ENGINE_MIN"
ok "Node $NODE_VERSION удовлетворяет engines $ENGINE_MIN"

# --- Изоляция: измеряется, а не декларируется --------------------------------
step "Изоляция"
for c in "$C_N8N" "$C_API"; do
  nets=$(dc inspect "$c" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | xargs)
  must "$c подключён только к внутренней сети" "$nets" "$NET_INT"
done
ing=$(dc inspect "$C_INGRESS" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | sort | xargs)
must "вход подключён ровно к двум сетям" "$ing" "$NET_EDGE $NET_INT"

egress_probe='const net=require("node:net");const s=net.connect({host:"1.1.1.1",port:443});
s.setTimeout(6000);s.on("connect",()=>{console.log("ОТКРЫТО");process.exit(0)});
s.on("error",()=>{console.log("ЗАКРЫТО");process.exit(0)});
s.on("timeout",()=>{console.log("ЗАКРЫТО");process.exit(0)});'
for c in "$C_N8N" "$C_API"; do
  must "$c: выхода в интернет нет" "$(dc exec "$c" node -e "$egress_probe" 2>/dev/null | tr -d '\r')" "ЗАКРЫТО"
done
dns_probe='require("node:dns").lookup("registry.npmjs.org",(e,a)=>console.log(e?"НЕТ":a));'
must "$C_N8N: внешний DNS не резолвится" "$(dc exec "$C_N8N" node -e "$dns_probe" 2>/dev/null | tr -d '\r')" "НЕТ"

API_IP=$(dc inspect "$C_API" --format "{{(index .NetworkSettings.Networks \"$NET_INT\").IPAddress}}")
RESOLVED=$(dc exec "$C_N8N" node -e 'require("node:dns").lookup("api.site-shot.com",(e,a)=>console.log(e?"ОШИБКА":a));' 2>/dev/null | tr -d '\r')
must "api.site-shot.com резолвится в фикстуру, а не наружу" "$RESOLVED" "$API_IP"
case "$RESOLVED" in
  172.*|10.*|192.168.*) ok "адрес фикстуры частный ($RESOLVED)" ;;
  *) die "адрес фикстуры не частный: $RESOLVED -- прогон остановлен до первого запроса" ;;
esac

# --- Редактор: готовность и одноразовая учётка -------------------------------
step "Редактор"
JAR="$STATE/cookies.txt"; : > "$JAR"
# Готовность -- это КОНКРЕТНЫЙ ответ REST, а не «хоть что-то ответило».
# Незалогиненный клиент на живом /rest/login получает 401; пока контейнер
# поднимается, curl не соединяется вовсе и возвращает ненулевой код.
READY=""
for _ in $(seq 1 90); do
  if code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/rest/login"); then
    case "$code" in 200|401) READY="$code"; break ;; esac
  fi
  sleep 2
done
[ -n "$READY" ] || die "редактор не ответил ожидаемым REST-кодом за 180 с (docker logs $C_N8N)"
ok "редактор отвечает на $BASE через фиксированный вход (HTTP $READY на /rest/login)"

curl -s -m 20 -c "$JAR" -X POST "$BASE/rest/owner/setup" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$OWNER_EMAIL\",\"firstName\":\"Fixture\",\"lastName\":\"Owner\",\"password\":\"$OWNER_PASS\"}" \
  -o "$STATE/setup.json" -w '%{http_code}' > "$STATE/setup.code" || :
SETUP_CODE=$(cat "$STATE/setup.code")
[ "$SETUP_CODE" = "200" ] || die "не создать одноразового владельца: HTTP $SETUP_CODE $(cat "$STATE/setup.json")"
ok "одноразовый владелец создан ($OWNER_EMAIL)"

api() { # api МЕТОД ПУТЬ [ТЕЛО]
  local m="$1" p="$2" body="${3-}"
  if [ -n "$body" ]; then
    curl -s -m 120 -b "$JAR" -X "$m" "$BASE$p" -H 'content-type: application/json' -d "$body"
  else
    curl -s -m 120 -b "$JAR" -X "$m" "$BASE$p"
  fi
}

# --- Загрузка кандидата настоящим загрузчиком n8n ----------------------------
step "Загрузка узла и учётных данных"
api GET /types/nodes.json > "$STATE/nodes.json"
api GET /types/credentials.json > "$STATE/credentials.json"
NODE_ENTRY=$(jq -c '[.[] | select(.name=="CUSTOM.siteShot" or .name=="siteShot")] | first' "$STATE/nodes.json")
CRED_ENTRY=$(jq -c '[.[] | select(.name=="siteShotApi")] | first' "$STATE/credentials.json")
[ "$NODE_ENTRY" != "null" ] && ok "n8n загрузил узел SiteShot из собранного кандидата" \
  || bad "n8n загрузил узел SiteShot" "в /types/nodes.json его нет"
[ "$CRED_ENTRY" != "null" ] && ok "n8n загрузил учётные данные siteShotApi" \
  || bad "n8n загрузил учётные данные siteShotApi" "в /types/credentials.json их нет"
NODE_TYPE_NAME=$(jq -r '.name' <<<"$NODE_ENTRY")
echo "  имя типа узла в рантайме: $NODE_TYPE_NAME"
eq "у узла объявлены обязательные учётные данные" \
   "$(jq -r '[.credentials[]? | select(.name=="siteShotApi") | .required] | first' <<<"$NODE_ENTRY")" "true"
# n8n 2.40.5 сам добавляет к КАЖДОМУ типу учётных данных два поля про
# домены. Это факт рантайма, а не объявление кандидата, поэтому проверяется
# раздельно: своё поле -- ровно одно.
eq "объявленное кандидатом поле" \
   "$(jq -r '[.properties[].name | select(. != "allowedHttpRequestDomains" and . != "allowedDomains")] | join(",")' <<<"$CRED_ENTRY")" "apiKey"
eq "поля, добавленные самим n8n" \
   "$(jq -r '[.properties[].name | select(. == "allowedHttpRequestDomains" or . == "allowedDomains")] | sort | join(",")' <<<"$CRED_ENTRY")" \
   "allowedDomains,allowedHttpRequestDomains"
eq "поле ключа помечено паролем" \
   "$(jq -r '[.properties[] | select(.name=="apiKey")] | first | .typeOptions.password' <<<"$CRED_ENTRY")" "true"
eq "параметры узла" \
   "$(jq -r '[.properties[].name] | join(",")' <<<"$NODE_ENTRY")" "url,binaryPropertyName,options"

# --- Учётные данные в базе ---------------------------------------------------
mk_cred() { # mk_cred ИМЯ КЛЮЧ -> печатает id
  api POST /rest/credentials \
    "{\"name\":\"$1\",\"type\":\"siteShotApi\",\"data\":{\"apiKey\":\"$2\"}}" \
    | jq -r '.data.id'
}
CRED_OK=$(mk_cred fixture-valid "$VALID_KEY")
CRED_BAD=$(mk_cred fixture-invalid "$INVALID_KEY")
CRED_BLOCKED=$(mk_cred fixture-blocked "$BLOCKED_KEY")
CRED_EMPTY=$(mk_cred fixture-empty "")
for c in "$CRED_OK" "$CRED_BAD" "$CRED_BLOCKED" "$CRED_EMPTY"; do
  [ -n "$c" ] && [ "$c" != "null" ] || die "не создать учётные данные в базе"
done
ok "учётные данные созданы через REST (4 шт.)"

# --- Инструменты замера ------------------------------------------------------
reqs() { wc -l < "$STATE/requests.jsonl" | tr -d ' '; }
since() { tail -n +$(( $1 + 1 )) "$STATE/requests.jsonl"; }
# Переключение режима -- атомарное и ВНУТРИ контейнера фикстуры.
#
# Запись с хоста прямо в bind-mount атомарной не является: наблюдался случай,
# когда фикстура прочитала "sl" вместо "slow" и честно отказала. Лечить это
# повтором или паузой нельзя -- это спрятало бы гонку, а не убрало её. Запись
# во временный файл рядом и rename в пределах той же файловой системы
# атомарны, а прочитанное обратно значение обязано совпасть точно.
mode() {
  local m="$1" got
  docker exec "$C_API" node -e '
    const fs = require("node:fs");
    fs.writeFileSync("/state/.mode.tmp", process.argv[1]);
    fs.renameSync("/state/.mode.tmp", "/state/mode");
  ' "$m" || die "не удалось переключить режим фикстуры на $m"
  got=$(docker exec "$C_API" node -e \
    'process.stdout.write(require("node:fs").readFileSync("/state/mode","utf8"))')
  [ "$got" = "$m" ] || die "режим не установился: ожидалось [$m], прочитано [$got]"
}

test_cred() { # test_cred ID КЛЮЧ -> печатает JSON результата
  api POST /rest/credentials/test \
    "{\"credentials\":{\"id\":\"$1\",\"name\":\"t\",\"type\":\"siteShotApi\",\"data\":{\"apiKey\":\"$2\"}}}"
}

# --- Тест учётных данных: настоящая цепочка CredentialsTester/RoutingNode ----
step "Проверка учётных данных настоящим тестером"
mode ok

N0=$(reqs); R=$(test_cred "$CRED_OK" "$VALID_KEY"); N1=$(reqs)
eq "верный ключ: статус"  "$(jq -r '.data.status' <<<"$R")" "OK"
eq "верный ключ: ровно один запрос к API" "$(( N1 - N0 ))" "1"
E=$(since "$N0" | head -1)
eq "путь запроса"                 "$(jq -r .path <<<"$E")" "/v1.0/credential-check"
eq "метод"                        "$(jq -r .method <<<"$E")" "GET"
eq "ключ пришёл заголовком"       "$(jq -r .userkey_header <<<"$E")" "$VALID_KEY"
eq "строка запроса пуста"         "$(jq -r .query <<<"$E")" ""
eq "ключа в параметрах запроса нет" "$(jq -r '.userkey_query // "нет"' <<<"$E")" "нет"
eq "заголовка Authorization нет"  "$(jq -r '.authorization // "нет"' <<<"$E")" "нет"
eq "хост"                         "$(jq -r .host <<<"$E")" "api.site-shot.com"

N0=$(reqs); R=$(test_cred "$CRED_BAD" "$INVALID_KEY"); N1=$(reqs)
eq "неверный ключ: статус" "$(jq -r '.data.status' <<<"$R")" "Error"
INVALID_REQS=$(( N1 - N0 ))
echo "  ИЗМЕРЕНО: запросов при 401 = $INVALID_REQS"
eq "неверный ключ: ключ и здесь только в заголовке" \
   "$(since "$N0" | jq -r '.userkey_query // "нет"' | sort -u | tr '\n' ',' | sed 's/,$//')" "нет"

N0=$(reqs); R=$(test_cred "$CRED_EMPTY" ""); N1=$(reqs)
eq "пустой ключ: статус" "$(jq -r '.data.status' <<<"$R")" "Error"
EMPTY_REQS=$(( N1 - N0 ))
echo "  ИЗМЕРЕНО: запросов при пустом ключе = $EMPTY_REQS"

N0=$(reqs); R=$(test_cred "$CRED_BLOCKED" "$BLOCKED_KEY"); N1=$(reqs)
eq "заблокированный ключ: статус" "$(jq -r '.data.status' <<<"$R")" "Error"
BLOCKED_MSG=$(jq -r '.data.message' <<<"$R")
case "$BLOCKED_MSG" in
  *"no active subscription"*) ok "403 показан собственным сообщением правила кандидата" ;;
  *) bad "403 показан собственным сообщением правила" "получено: $BLOCKED_MSG" ;;
esac
echo "  ИЗМЕРЕНО: запросов при 403 = $(( N1 - N0 ))"

# --- Редиректы: ключ не должен уехать, сток не должен быть тронут ------------
step "Редиректы"
for kind in redirect-same redirect-cross; do
  mode "$kind"
  N0=$(reqs); R=$(test_cred "$CRED_OK" "$VALID_KEY"); N1=$(reqs)
  eq "$kind: тест не признан успешным" "$(jq -r '.data.status' <<<"$R")" "Error"
  SINK=$(since "$N0" | jq -r 'select(.path=="/v1.0/sink") | .path' | wc -l | tr -d ' ')
  eq "$kind: сток не тронут"           "$SINK" "0"
  eq "$kind: ровно один запрос"        "$(( N1 - N0 ))" "1"
  eq "$kind: ключ не ушёл в сток"      "$(since "$N0" | jq -r 'select(.path=="/v1.0/sink") | .userkey_header' | wc -l | tr -d ' ')" "0"
done

# --- Таймаут: измеряется секундомером, а не обещанием ------------------------
step "Таймаут"
mode slow
N0=$(reqs); T0=$(date +%s)
R=$(test_cred "$CRED_OK" "$VALID_KEY")
T1=$(date +%s); ELAPSED=$(( T1 - T0 ))
# Контракт: проверка обязана оборваться на объявленных 10 с, а не ждать
# пятиминутное умолчание, которое RoutingNode подставляет вместо неё
# (routing-node.ts:225-229). Значение доживает до транспорта только потому,
# что его ставит authenticate() -- последний хук перед отправкой.
echo "  ИЗМЕРЕНО: обрыв через $ELAPSED с при задержке фикстуры 25 с"
eq "медленный ответ признан ошибкой" "$(jq -r '.data.status' <<<"$R")" "Error"
if [ "$ELAPSED" -ge 8 ] && [ "$ELAPSED" -le 16 ]; then
  ok "сработал объявленный таймаут 10 с, а не умолчание n8n в 300 с"
else
  bad "сработал объявленный таймаут 10 с" "прошло $ELAPSED с"
fi

# Таймаут -- НА ПОПЫТКУ, а не на всю кнопку Test. n8n делает на 401 вторую
# попытку, и суммарное время складывается из обеих. Замеряется сумма; никакого
# обещания про общий предел здесь нет и быть не может.
mode slow-401
N0=$(reqs); T0=$(date +%s)
R=$(test_cred "$CRED_BAD" "$INVALID_KEY")
T1=$(date +%s); ELAPSED401=$(( T1 - T0 )); N1=$(reqs)
ATTEMPTS=$(( N1 - N0 ))
echo "  ИЗМЕРЕНО: попыток $ATTEMPTS, суммарно $ELAPSED401 с при задержке 6 с на попытку"
eq "медленный 401: статус"                 "$(jq -r '.data.status' <<<"$R")" "Error"
eq "медленный 401: n8n повторил запрос"    "$ATTEMPTS" "2"
if [ "$ELAPSED401" -ge 11 ] && [ "$ELAPSED401" -le 20 ]; then
  ok "суммарно около двух попыток по 6 с ($ELAPSED401 с): ни одна не оборвана на 10 с"
else
  bad "сумма двух попыток по 6 с" "прошло $ELAPSED401 с"
fi
# Каждая попытка обязана остаться той же самой проверкой -- без сползания на
# путь съёмки и без ключа в строке запроса.
eq "медленный 401: обе попытки -- тот же путь" \
   "$(since "$N0" | jq -r .path | sort -u | tr '\n' ',' | sed 's/,$//')" "/v1.0/credential-check"
eq "медленный 401: обе попытки -- GET" \
   "$(since "$N0" | jq -r .method | sort -u)" "GET"
eq "медленный 401: ключ в заголовке на обеих попытках" \
   "$(since "$N0" | jq -r .userkey_header | sort -u)" "$INVALID_KEY"
eq "медленный 401: строка запроса пуста на обеих попытках" \
   "$(since "$N0" | jq -r '.query' | sort -u)" ""
eq "медленный 401: путь съёмки не задет" \
   "$(since "$N0" | jq -r 'select(.path=="/") | .path' | wc -l | tr -d ' ')" "0"

mode ok

# --- Настоящее выполнение рабочего процесса ----------------------------------
step "Выполнение рабочего процесса"
mk_wf() { # mk_wf ФАЙЛ ID_УЧЁТКИ ИМЯ_УЧЁТКИ ФОРМАТ ПОЛЕ ДОП_ОПЦИИ_JSON
  jq -n --arg t "$NODE_TYPE_NAME" --arg cid "$2" --arg cname "$3" \
        --arg fmt "$4" --arg prop "$5" --argjson extra "$6" '
  {
    name: "fixture-capture", active: false, settings: {},
    nodes: [
      { parameters: {}, id: "11111111-1111-4111-8111-111111111111",
        name: "Start", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0,0] },
      { parameters: ({ url: "https://example.invalid/pricing", binaryPropertyName: $prop,
                       options: ({ format: $fmt } + $extra) }),
        id: "22222222-2222-4222-8222-222222222222",
        name: "Site-Shot", type: $t, typeVersion: 1, position: [220,0],
        credentials: { siteShotApi: { id: $cid, name: $cname } } }
    ],
    connections: { Start: { main: [[{ node: "Site-Shot", type: "main", index: 0 }]] } }
  }' > "$STATE/$1"
}

# Прогон -- через тот же REST редактора, что и кнопка «Execute workflow».
# CLI `n8n execute` для этого не годится: в 2.40.5 он требует --id, поднимает
# в том же профиле второй процесс n8n и сталкивается с ним на порту брокера
# задач. Второй процесс -- это уже не тот рантайм, который проверяется.
#
# Результат возвращается в кодировке flatted, поэтому разбирается тем самым
# пакетом flatted, который лежит внутри образа n8n, а не переписанным заново.
wf_run() { # wf_run ФАЙЛ -> $STATE/exec.json, $STATE/exec.status
  local file="$1" id body run eid ex st
  id=$(api POST /rest/workflows "$(jq -c '{name,nodes,connections,settings}' "$STATE/$file")" \
       | jq -r '.data.id')
  [ -n "$id" ] && [ "$id" != null ] || die "не создать рабочий процесс из $file"
  body=$(jq -c --arg id "$id" '{workflowData:{id:$id,name:.name,nodes:.nodes,
         connections:.connections,settings:.settings},
         triggerToStartFrom:{name:"Start"}}' "$STATE/$file")
  run=$(api POST "/rest/workflows/$id/run" "$body")
  eid=$(jq -r '.data.executionId // empty' <<<"$run")
  [ -n "$eid" ] || die "прогон не запустился: $run"
  st=""
  for _ in $(seq 1 120); do
    ex=$(api GET "/rest/executions/$eid?includeData=true")
    st=$(jq -r '.data.status // empty' <<<"$ex")
    case "$st" in success|error|crashed|canceled) break ;; esac
    sleep 1
  done
  case "$st" in
    success|error|crashed|canceled) : ;;
    *) die "прогон $eid не завершился за 120 с (статус: ${st:-нет})" ;;
  esac
  printf '%s' "$st" > "$STATE/exec.status"
  jq -r '.data.data' <<<"$ex" | docker exec -i "$C_N8N" node -e '
    let buf = "";
    process.stdin.on("data", (d) => (buf += d)).on("end", () => {
      const { parse } = require("/usr/local/lib/node_modules/n8n/node_modules/flatted");
      process.stdout.write(JSON.stringify(parse(buf)));
    });' > "$STATE/exec.json" || die "не разобрать данные прогона"
}
wf_status() { cat "$STATE/exec.status"; }
wf_binary() { # wf_binary СВОЙСТВО ПОЛЕ
  jq -r ".resultData.runData[\"Site-Shot\"][0].data.main[0][0].binary.$1.$2" "$STATE/exec.json"
}
wf_error()  { jq -r '.resultData.error.message // .resultData.runData["Site-Shot"][0].error.message // ""' "$STATE/exec.json"; }

mk_wf workflow-png.json  "$CRED_OK" fixture-valid png  data '{}'
mk_wf workflow-jpeg.json "$CRED_OK" fixture-valid jpeg shot '{"fullPage":true,"width":1280,"height":900}'

N0=$(reqs); wf_run workflow-png.json; N1=$(reqs)
eq "PNG: прогон успешен"           "$(wf_status)" "success"
eq "PNG: ровно один запрос к API"  "$(( N1 - N0 ))" "1"
eq "PNG: mimeType"                 "$(wf_binary data mimeType)" "image/png"
eq "PNG: имя файла"                "$(wf_binary data fileName)" "screenshot.png"
eq "PNG: расширение"               "$(wf_binary data fileExtension)" "png"
wf_binary data data | base64 -d > "$STATE/out.png"
eq "PNG: байты совпали с образцом"  "$(shasum -a 256 "$STATE/out.png" | cut -d' ' -f1)" "$PNG_SHA"
E=$(since "$N0" | head -1)
eq "PNG: ключ ушёл параметром запроса (опубликованный контракт)" \
   "$(jq -r .userkey_query <<<"$E")" "$VALID_KEY"
eq "PNG: заголовка userkey на съёмке нет" "$(jq -r '.userkey_header // "нет"' <<<"$E")" "нет"
eq "PNG: параметры съёмки" \
   "$(jq -r '.query' <<<"$E" | tr '&' '\n' | grep -v '^userkey=' | sort | tr '\n' ' ' | xargs)" \
   "format=png response_type=json url=https%3A%2F%2Fexample.invalid%2Fpricing"

N0=$(reqs); wf_run workflow-jpeg.json; N1=$(reqs)
eq "JPEG: прогон успешен" "$(wf_status)" "success"
eq "JPEG: mimeType"       "$(wf_binary shot mimeType)" "image/jpeg"
eq "JPEG: имя файла"      "$(wf_binary shot fileName)" "screenshot.jpg"
eq "JPEG: поле задано параметром узла" \
   "$(jq -r '.resultData.runData["Site-Shot"][0].data.main[0][0].binary | keys | join(",")' "$STATE/exec.json")" "shot"
wf_binary shot data | base64 -d > "$STATE/out.jpg"
eq "JPEG: байты совпали с образцом" "$(shasum -a 256 "$STATE/out.jpg" | cut -d' ' -f1)" "$JPG_SHA"
eq "JPEG: выбранные параметры доехали" \
   "$(since "$N0" | head -1 | jq -r '.query' | tr '&' '\n' | grep -E '^(full_size|width|height)=' | sort | tr '\n' ' ' | xargs)" \
   "full_size=1 height=900 width=1280"

# --- Ошибки продукта доходят до пользователя ---------------------------------
step "Сообщения об ошибках"
mk_wf workflow-blocked.json "$CRED_BLOCKED" fixture-blocked png data '{}'
wf_run workflow-blocked.json
eq "403: прогон завершился ошибкой" "$(wf_status)" "error"
case "$(wf_error)" in
  *"no active subscription"*) ok "403 на съёмке показан сообщением про подписку" ;;
  *) bad "403 на съёмке показан сообщением про подписку" "получено: $(wf_error)" ;;
esac
case "$(wf_error)" in
  *"$VALID_KEY"*|*"$BLOCKED_KEY"*|*userkey*) bad "в сообщении об ошибке нет ключа" "$(wf_error)" ;;
  *) ok "в сообщении об ошибке нет ни ключа, ни имени параметра" ;;
esac

# Защита по размеру: измеряется, КОГДА она срабатывает.
step "Предел 32 MiB"
mode oversize
N0=$(reqs); wf_run workflow-png.json; N1=$(reqs)
mode ok
eq "ответ больше предела: прогон завершился ошибкой" "$(wf_status)" "error"
case "$(wf_error)" in
  *"larger than the 32 MiB"*) ok "ответ больше предела отклонён собственным сообщением" ;;
  *) bad "ответ больше предела отклонён" "получено: $(wf_error)" ;;
esac
eq "предел проверен ПОСЛЕ получения тела (запрос состоялся)" "$(( N1 - N0 ))" "1"

# --- Итог --------------------------------------------------------------------
trap - EXIT
step "Итог"
printf 'прошло: %d, провалилось: %d\n' "$pass" "$fail"
cat <<INFO

Редактор оставлен поднятым для осмотра:
  адрес:  $BASE
  вход:   $OWNER_EMAIL / $OWNER_PASS   (одноразовая синтетическая учётка)
  узел:   "Site-Shot" (тип $NODE_TYPE_NAME), учётные данные "Site-Shot API"
  готовые учётные данные: fixture-valid / fixture-invalid / fixture-blocked / fixture-empty

Ресурсы этого прогона:
  образ      $IMAGE
  контейнеры $C_N8N (только $NET_INT), $C_API (только $NET_INT), $C_INGRESS ($NET_EDGE + $NET_INT)
  том        $VOL
  сети       $NET_INT (internal=true), $NET_EDGE
  журнал запросов фикстуры: $STATE/requests.jsonl

  остановить и убрать: $HERE/runtime-gate.sh down
  повторить целиком:   $HERE/runtime-gate.sh down && $HERE/runtime-gate.sh up $VENV_PY
INFO
[ "$fail" -eq 0 ] || exit 1
