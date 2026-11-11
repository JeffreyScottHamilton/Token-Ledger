#!/usr/bin/env bash
# Check 4: privacy canaries. Greps every file under both ledger homes with grep -a.
. "$(dirname "$0")/common.sh"
R="$V/c4"; rm -rf "$R"; mkdir -p "$R/h" "$R/claude/projects/-home-CANARYPATH9-proj"
export HOME="$R/h" CLAUDE_CONFIG_DIR="$R/claude"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$R/key.pem" -out "$R/cert.pem" -days 2 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
PRI() { TOKEN_LEDGER_HOME="$R/pri" TOKEN_LEDGER_PORT=47407 "$@"; }
SEC() { TOKEN_LEDGER_HOME="$R/sec" TOKEN_LEDGER_PORT=47409 "$@"; }
# pre-existing settings so install creates a backup
echo '{"model":"opus","env":{"FOO":"bar"}}' > "$R/claude/settings.json"
SEC $CLI install --yes --skip-claude-check --no-import >"$R/install.out" 2>&1; echo "install exit=$?"; SEC $CLI stop >/dev/null
PRI $CLI serve --port 47408 --tls-cert "$R/cert.pem" --tls-key "$R/key.pem" --local-port 47407 >"$R/pri.out" 2>&1 &
sleep 1.2
CODE=$(PRI $CLI pair create canarybox --url https://localhost:47408 --ca "$R/cert.pem" 2>/dev/null)
SEC $CLI pair join "$CODE" >/dev/null
SEC $CLI serve >"$R/sec.out" 2>&1 &
sleep 1.2
ING=$(node -e 'console.log(JSON.parse(Buffer.from(process.argv[1].slice(8),"base64url")).i)' "$CODE")
RD=$(node -e 'console.log(JSON.parse(Buffer.from(process.argv[1].slice(8),"base64url")).r)' "$CODE")
RAWREQ=req_011CANARYREQID77; RAWSESS=5e55c0de-CANARYSESSION-4242
cat > "$R/body.json" <<JSON
{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"claude-code"}},{"key":"host.name","value":{"stringValue":"CANARYHOST1"}},{"key":"user.email","value":{"stringValue":"canary.email@example.invalid"}}]},
"scopeLogs":[{"scope":{"name":"com.anthropic.claude_code.events"},"logRecords":[
{"body":{"stringValue":"claude_code.user_prompt"},"attributes":[{"key":"event.name","value":{"stringValue":"user_prompt"}},{"key":"prompt","value":{"stringValue":"CANARYPROMPT1 secret prompt text"}},{"key":"session.id","value":{"stringValue":"$RAWSESS"}}]},
{"body":{"stringValue":"claude_code.tool_result"},"attributes":[{"key":"event.name","value":{"stringValue":"tool_result"}},{"key":"tool_name","value":{"stringValue":"CANARYTOOL2"}},{"key":"tool_parameters","value":{"stringValue":"{\"command\":\"cat /home/CANARYPATH3/secret.txt\"}"}},{"key":"tool_input","value":{"stringValue":"CANARYTOOLINPUT4"}}]},
{"body":{"stringValue":"claude_code.api_request"},"attributes":[{"key":"event.name","value":{"stringValue":"api_request"}},{"key":"request_id","value":{"stringValue":"$RAWREQ"}},{"key":"session.id","value":{"stringValue":"$RAWSESS"}},{"key":"user.email","value":{"stringValue":"canary.email@example.invalid"}},{"key":"user.account_uuid","value":{"stringValue":"acc7-CANARYACCOUNT5"}},{"key":"user.id","value":{"stringValue":"CANARYUSERID10"}},{"key":"organization.id","value":{"stringValue":"org-CANARYORG6"}},{"key":"cwd","value":{"stringValue":"/home/CANARYPATH3/work"}},{"key":"model","value":{"stringValue":"claude CANARYMODEL11 bad model"}},{"key":"query_source","value":{"stringValue":"CANARYQS12"}},{"key":"input_tokens","value":{"intValue":11}},{"key":"output_tokens","value":{"intValue":22}},{"key":"cache_read_tokens","value":{"intValue":33}},{"key":"cache_creation_tokens","value":{"intValue":44}}]}
]}]}]}
JSON
echo "OTLP to secondary (with Authorization + cookie headers): $(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer CANARYAUTHHDR7' -H 'Cookie: c=CANARYCOOKIE13' -H 'X-Api-Key: CANARYAPIKEY14' -H 'Content-Type: application/json' --data-binary @"$R/body.json" http://127.0.0.1:47409/v1/logs)"
echo "same OTLP direct to primary loopback: $(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer CANARYAUTHHDR7' -H 'Content-Type: application/json' --data-binary @"$R/body.json" http://127.0.0.1:47407/v1/logs)"
echo "malformed JSON w/ canary: $(curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' --data-binary '{"CANARYBADJSON15":' http://127.0.0.1:47409/v1/logs)"
echo "404 path w/ canary: $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:47409/CANARYURL16?q=CANARYQUERY17")"
echo "relay ingest w/ extra fields + bad model: $(curl -s --cacert "$R/cert.pem" -H "Authorization: Bearer $ING" -H 'Content-Type: application/json' -d '{"records":[{"rid":"000000000000000000000000000000aa","ts":1794270797684,"model":"CANARY MODEL18","session":"CANARYSESS19","prompt":"CANARYEXTRA20","input":1,"output":0,"cache_write":0,"cache_read":0},{"rid":"000000000000000000000000000000ab","ts":1794270797684,"model":"ok","prompt":"CANARYEXTRA20","cwd":"/CANARYEXTRA21","input":1,"output":0,"cache_write":0,"cache_read":0}]}' https://localhost:47408/ingest/v1/records)"
echo "bad token attempt: $(curl -s -o /dev/null -w '%{http_code}' --cacert "$R/cert.pem" -H "Authorization: Bearer tl_ing_CANARYBADTOKEN22" -H 'Content-Type: application/json' -d '{}' https://localhost:47408/ingest/v1/records)"
# transcript with canary content, paths
T="$R/claude/projects/-home-CANARYPATH9-proj/CANARYSESSFILE23.jsonl"
cat > "$T" <<JSON
{"type":"user","sessionId":"$RAWSESS","cwd":"/home/CANARYPATH9/proj","message":{"role":"user","content":"CANARYTRANSCRIPTPROMPT8"},"timestamp":"2026-11-10T03:00:00.000Z"}
{"type":"assistant","sessionId":"$RAWSESS","requestId":"req_011CANARYREQTR24","cwd":"/home/CANARYPATH9/proj","gitBranch":"CANARYBRANCH25","timestamp":"2026-11-10T03:00:01.000Z","message":{"model":"claude-opus-5-5","id":"msg_CANARYMSGID26","role":"assistant","content":[{"type":"text","text":"CANARYREPLY27"},{"type":"tool_use","name":"Bash","input":{"command":"echo CANARYTOOLCMD28"}}],"usage":{"input_tokens":3,"output_tokens":4,"cache_creation_input_tokens":5,"cache_read_input_tokens":6}}}
{"type":"assistant","sessionId":"$RAWSESS","cwd":"/home/CANARYPATH9/proj","timestamp":"2026-11-10T03:00:02.000Z","message":{"model":"claude-opus-5-5","content":[{"type":"text","text":"CANARYNOREQID29"}],"usage":{"input_tokens":3,"output_tokens":4}}}
{"type":"assistant","CANARYBROKEN30
JSON
SEC $CLI import --dry-run > "$R/dry.out" 2>&1; SEC $CLI import --yes > "$R/imp.out" 2>&1; SEC $CLI sync >> "$R/imp.out" 2>&1; cat "$R/imp.out"
sleep 4
for h in pri sec; do
  F() { TOKEN_LEDGER_HOME="$R/$h" TOKEN_LEDGER_PORT=47499 "$@"; }
  F $CLI export --format json --out "$R/$h/export.json" >/dev/null; F $CLI export --format csv --out "$R/$h/export.csv" >/dev/null
  F $CLI summary --details > "$R/$h/details.txt"; F $CLI source list > "$R/$h/sources.txt"
  F $CLI doctor > "$R/$h/doctor.txt" 2>&1
done
echo "primary: $(PRI $CLI summary)  secondary: $(SEC $CLI summary)   (expect 110+2 on primary; 110+18 local view)"
# checkpoint WAL into db by stopping; grep both live (wal/shm present) and after stop
scan() {
  echo "--- canary scan ($1): files"; find "$R/pri" "$R/sec" -type f | sort | xargs stat -c '%a %s %n' | sed "s#$R/##"
  echo "--- hits for CANARY / raw request ids / raw session id:"
  grep -rac -e CANARY -e "$RAWREQ" -e req_011 -e "$RAWSESS" -e 'example.invalid' "$R/pri" "$R/sec" | grep -v ':0$' || echo "(no hits)"
  echo "--- files containing plaintext tl_ing_/tl_read_:"
  grep -ral -e 'tl_ing_' -e 'tl_read_' "$R/pri" "$R/sec" || echo "(none)"
  echo "--- exact ingest/read token of this pairing anywhere:"
  grep -raFl -e "$ING" -e "$RD" "$R/pri" "$R/sec" || echo "(none)"
  echo "--- pairing code (first 60 chars of base64 payload) anywhere:"; grep -raFl -e "${CODE:8:60}" "$R/pri" "$R/sec" || echo "(none)"
  echo "--- collector.log token/pair/Bearer mentions:"; grep -aci -e 'tl_' -e tlpair -e bearer "$R/pri/collector.log" "$R/sec/collector.log"
}
scan live
PRI $CLI stop >/dev/null; SEC $CLI stop >/dev/null
scan after-stop
echo "--- stdout/stderr captured from serve / install / import:"; grep -ac -e CANARY -e req_011 -e tl_ing_ -e tl_read_ "$R"/*.out
echo "--- export json keys:"; node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));const r=Array.isArray(j)?j:j.records;console.log(Object.keys(j), [...new Set(r.flatMap(Object.keys))].join(","), r.length)' "$R/sec/export.json"
echo "--- export csv:"; cat "$R/sec/export.csv"
echo "--- sec config.json (tokens masked):"; sed -E 's/(tl_(ing|read)_.{4})[A-Za-z0-9_-]+/\1…/' "$R/sec/config.json"
echo "--- sec collector.log:"; cat "$R/sec/collector.log"
echo "--- db strings sample (sec):"; strings -n 6 "$R/sec/ledger.db" | grep -v -E '^(CREATE|INDEX|sqlite|table)' | head -20
echo "--- backups:"; ls -la "$R/sec/backups"
