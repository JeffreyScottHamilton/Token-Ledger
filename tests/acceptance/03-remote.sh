#!/usr/bin/env bash
# Check 3: two sources over self-signed TLS on loopback (NOT a real cloud environment)
. "$(dirname "$0")/common.sh"
R="$V/c3"; rm -rf "$R"; mkdir -p "$R"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$R/key.pem" -out "$R/cert.pem" -days 2 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
PRI() { TOKEN_LEDGER_HOME="$R/pri" CLAUDE_CONFIG_DIR="$R/claude-pri" TOKEN_LEDGER_PORT=47403 HOME="$R/h" "$@"; }
SEC() { TOKEN_LEDGER_HOME="$R/sec" CLAUDE_CONFIG_DIR="$R/claude-sec" TOKEN_LEDGER_PORT=47405 HOME="$R/h" "$@"; }
mkdir -p "$R/h"
echo "== non-loopback bind without TLS must be refused"
PRI timeout 5 $CLI serve --host 0.0.0.0 --port 47406; echo "exit=$?"
PRI $CLI serve --host 127.0.0.1 --port 47404 --tls-cert "$R/cert.pem" --tls-key "$R/key.pem" --local-port 47403 >"$R/pri.out" 2>&1 & PP=$!
sleep 1.5; cat "$R/pri.out"
T=https://localhost:47404; C="curl -s --cacert $R/cert.pem"
CODE=$(PRI $CLI pair create laptop2 --url $T --ca "$R/cert.pem" 2>"$R/pair.err"); echo "pair code len=${#CODE}"; cat "$R/pair.err"
echo "$CODE" > "$R/code.txt"
SEC $CLI pair join "$CODE"
SEC $CLI serve >"$R/sec.out" 2>&1 & SP=$!; sleep 1.5
ING=$(node -e 'console.log(JSON.parse(Buffer.from(process.argv[1].slice(8),"base64url")).i)' "$CODE")
RD=$(node -e 'console.log(JSON.parse(Buffer.from(process.argv[1].slice(8),"base64url")).r)' "$CODE")
echo "$ING" > "$R/ing.txt"; echo "$RD" > "$R/read.txt"
echo "== usage on primary (local, 100) and on secondary (250)"
TOKEN_LEDGER_PORT=47403 post "$(otlp_body "$(otlp_rec req_PRI1 100 0 0 0)")"; echo
TOKEN_LEDGER_PORT=47405 post "$(otlp_body "$(otlp_rec req_SEC1 200 50 0 0)")"; echo
sleep 4
echo "primary: $(PRI $CLI summary)"; PRI $CLI summary --json | jqn '.sources.map(s=>[s.label,s.kind,s.status,s.total,s.requests])'
echo "secondary: $(SEC $CLI summary)"; SEC $CLI summary --details | sed -n '1,25p'
PRI $CLI source list
echo "== auth matrix on TLS listener"
REC='{"records":[{"rid":"00000000000000000000000000000001","ts":1794270797684,"source":"evil","origin":"otel","model":"m","input":5,"output":0,"cache_write":0,"cache_read":0}]}'
h() { $C -o /dev/null -w '%{http_code}' "$@"; }
echo "ingest no token:        $(h -H 'Content-Type: application/json' -d "$REC" $T/ingest/v1/records)"
echo "v1/logs no token (TLS): $(h -H 'Content-Type: application/json' -d '{"resourceLogs":[]}' $T/v1/logs)"
echo "ingest w/ read token:   $(h -H "Authorization: Bearer $RD" -H 'Content-Type: application/json' -d "$REC" $T/ingest/v1/records)"
echo "ingest w/ garbage:      $(h -H "Authorization: Bearer tl_ing_AAAA" -H 'Content-Type: application/json' -d "$REC" $T/ingest/v1/records)"
echo "summary no token:       $(h $T/api/v1/summary)"
echo "summary w/ ingest tok:  $(h -H "Authorization: Bearer $ING" $T/api/v1/summary)"
echo "summary w/ read tok:    $(h -H "Authorization: Bearer $RD" $T/api/v1/summary)"
echo "ingest w/ ingest tok (source forced to token label): $($C -H "Authorization: Bearer $ING" -H 'Content-Type: application/json' -d "$REC" $T/ingest/v1/records)"
echo "loopback ingest endpoint no token: $(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "$REC" http://127.0.0.1:47403/ingest/v1/records)"
sleep 1.2; PRI $CLI summary --json | jqn '.sources.map(s=>[s.label,s.total])'
echo "== limits"
head -c 1100000 /dev/zero | tr '\0' ' ' > "$R/big.json"
echo ">1MiB loopback /v1/logs: $(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' --data-binary @"$R/big.json" http://127.0.0.1:47403/v1/logs)"
echo ">1MiB TLS ingest (auth): $(h -H "Authorization: Bearer $ING" -H 'Content-Type: application/json' --data-binary @"$R/big.json" $T/ingest/v1/records)"
echo ">1MiB chunked (no content-length): $(curl -s -o /dev/null -w '%{http_code}' -H 'Transfer-Encoding: chunked' -H 'Content-Type: application/json' --data-binary @"$R/big.json" http://127.0.0.1:47403/v1/logs)"
node -e 'const z=require("zlib");process.stdout.write(z.gzipSync(Buffer.alloc(50*1024*1024,32)))' > "$R/bomb.gz"
echo "gzip bomb 50MiB->$(stat -c %s "$R/bomb.gz")B: $(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Encoding: gzip' -H 'Content-Type: application/json' --data-binary @"$R/bomb.gz" http://127.0.0.1:47403/v1/logs)"
echo "protobuf content-type: $(curl -s -w ' %{http_code}' -H 'Content-Type: application/x-protobuf' --data-binary 'xx' http://127.0.0.1:47403/v1/logs)"
echo "text/plain: $(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: text/plain' --data-binary '{}' http://127.0.0.1:47403/v1/logs)"
echo "bad Host header: $(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example.com' http://127.0.0.1:47403/api/v1/summary)"
echo "bad Host on POST: $(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example.com:47403' -H 'Content-Type: application/json' -d '{"resourceLogs":[]}' http://127.0.0.1:47403/v1/logs)"
echo "Origin header GET: $(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: http://127.0.0.1:47403' http://127.0.0.1:47403/api/v1/summary)"
echo "Origin header POST: $(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: null' -H 'Content-Type: application/json' -d '{"resourceLogs":[]}' http://127.0.0.1:47403/v1/logs)"
echo "Origin on healthz: $(curl -s -o /dev/null -w '%{http_code}' -H 'Origin: http://x' http://127.0.0.1:47403/healthz)"
echo "healthz loopback: $(curl -s -i http://127.0.0.1:47403/healthz | tr -d '\r' | tr '\n' '|')"
echo "healthz TLS: $($C $T/healthz)"
echo "5001 records: $(node -e 'console.log(JSON.stringify({records:Array.from({length:5001},(_, i)=>({rid:i.toString(16).padStart(32,"0"),ts:1794270797684,input:1,output:0,cache_write:0,cache_read:0}))}))' | $C -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ING" -H 'Content-Type: application/json' --data-binary @- $T/ingest/v1/records)"
echo "== revoke laptop2"
B4=$(PRI $CLI summary --json | jqn .total)
PRI $CLI source revoke laptop2
echo "ingest after revoke:  $(h -H "Authorization: Bearer $ING" -H 'Content-Type: application/json' -d "$REC" $T/ingest/v1/records)"
echo "summary after revoke: $(h -H "Authorization: Bearer $RD" $T/api/v1/summary)"
echo "total before=$B4 after=$(PRI $CLI summary --json | jqn .total)"; PRI $CLI summary --json | jqn '.sources.map(s=>[s.label,s.status,s.total])'
echo "== secondary keeps counting locally after revoke, outbox held"
TOKEN_LEDGER_PORT=47405 post "$(otlp_body "$(otlp_rec req_SEC2 1 0 0 0)")"; echo; sleep 3
echo "secondary: $(SEC $CLI summary)  primary: $(PRI $CLI summary)"
tail -4 "$R/sec/collector.log"
kill $PP $SP; wait 2>/dev/null
ls -la "$R/pri" "$R/sec"
