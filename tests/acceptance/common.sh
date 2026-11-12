# Shared helpers for acceptance scripts. Source this file. Never touches ~/.claude or ~/.claude-token-ledger.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
V="${VERIFY_ROOT:-/tmp/claude-0/-home-user-Token-Ledger/98aa153d-dbc3-558c-9566-fe39b85eccde/scratchpad/verify}"
CLI="node $REPO/plugin/bin/token-ledger.mjs"
mkdir -p "$V"
# fresh <name> <port>: new isolated home + claude config dir, exports env
fresh() {
  export TOKEN_LEDGER_HOME="$V/$1/home" CLAUDE_CONFIG_DIR="$V/$1/claude" TOKEN_LEDGER_PORT="$2"
  rm -rf "$V/$1"; mkdir -p "$V/$1" "$CLAUDE_CONFIG_DIR"
  # guard: HOME also redirected so nothing can fall back to the real profile
  export HOME="$V/$1/fakehome"; mkdir -p "$HOME"
}
serve_bg() { # serve_bg [extra args]; sets SPID
  $CLI serve "$@" >"$TOKEN_LEDGER_HOME.serve.out" 2>&1 &
  SPID=$!
  for i in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:${LOCALPORT:-$TOKEN_LEDGER_PORT}/healthz" && return 0; sleep 0.1; done
  echo "collector did not start"; cat "$TOKEN_LEDGER_HOME.serve.out"; return 1
}
# otlp_rec <request_id|-> <in> <out> <cw> <cr> [w5] [w1]  -> one logRecord JSON (values inserted raw, so pass "\"5\"" for strings)
otlp_rec() {
  local rid="$1" attrs
  attrs='{"key":"event.name","value":{"stringValue":"api_request"}},{"key":"event.timestamp","value":{"stringValue":"2026-11-10T01:00:00.000Z"}},{"key":"model","value":{"stringValue":"claude-opus-5-5"}}'
  [ "$rid" != "-" ] && attrs="$attrs,{\"key\":\"request_id\",\"value\":{\"stringValue\":\"$rid\"}}"
  [ -n "$2" ] && attrs="$attrs,{\"key\":\"input_tokens\",\"value\":{\"intValue\":$2}}"
  [ -n "$3" ] && attrs="$attrs,{\"key\":\"output_tokens\",\"value\":{\"intValue\":$3}}"
  [ -n "$4" ] && attrs="$attrs,{\"key\":\"cache_creation_tokens\",\"value\":{\"intValue\":$4}}"
  [ -n "$5" ] && attrs="$attrs,{\"key\":\"cache_read_tokens\",\"value\":{\"intValue\":$5}}"
  [ -n "$6" ] && attrs="$attrs,{\"key\":\"cache_creation_5m_tokens\",\"value\":{\"intValue\":$6}}"
  [ -n "$7" ] && attrs="$attrs,{\"key\":\"cache_creation_1h_tokens\",\"value\":{\"intValue\":$7}}"
  echo "{\"timeUnixNano\":\"1794270797684000000\",\"body\":{\"stringValue\":\"claude_code.api_request\"},\"attributes\":[$attrs]}"
}
otlp_body() { local IFS=,; echo "{\"resourceLogs\":[{\"resource\":{\"attributes\":[]},\"scopeLogs\":[{\"scope\":{\"name\":\"com.anthropic.claude_code.events\"},\"logRecords\":[$*]}]}]}"; }
post() { curl -s -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "$1" "http://127.0.0.1:$TOKEN_LEDGER_PORT/v1/logs"; }
sumj() { $CLI summary --json; }
jqn() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify(eval("j"+process.argv[1])))})' "$1"; }
