#!/usr/bin/env bash
# Check 2: dedup / durability
. "$(dirname "$0")/common.sh"
fresh c2 47402; serve_bg || exit 1
tot() { sleep 1.2; echo "total=$(sumj | jqn .total) requests=$(sumj | jqn .requests)"; }
B=$(otlp_body "$(otlp_rec req_D1 10 20 30 40 30 0)")
echo "== replay same body 5x (expect 100/1)"; for i in 1 2 3 4 5; do printf '%s ' "$(post "$B")"; done; echo; tot
echo "== two different request ids, identical counts (expect 300/3)"
post "$(otlp_body "$(otlp_rec req_D2 10 20 30 40)")"; post "$(otlp_body "$(otlp_rec req_D3 10 20 30 40)")"; echo; tot
echo "== 20 parallel POSTs of one new body (expect +1000 -> 1300/4)"
P=$(otlp_body "$(otlp_rec req_PAR 1000 0 0 0)"); echo "$P" > "$V/c2/par.json"
seq 20 | xargs -P 20 -I{} curl -s -o /dev/null -w '%{http_code} ' -H 'Content-Type: application/json' --data-binary @"$V/c2/par.json" "http://127.0.0.1:$TOKEN_LEDGER_PORT/v1/logs"; echo; tot
echo "== kill -9 immediately after 200 (expect record durable: 1307/5)"
code=$(post "$(otlp_body "$(otlp_rec req_K9 7 0 0 0)")"); kill -9 $SPID; echo "http=$code killed"; wait $SPID 2>/dev/null
ls -la "$TOKEN_LEDGER_HOME"
echo "direct summary after kill (collector down): total=$(sumj | jqn .total) requests=$(sumj | jqn .requests) status=$(sumj | jqn .status)"
echo "== kill -9 mid-stream: 200 sequential posts in background, kill during"
serve_bg || exit 1
( for i in $(seq 1 200); do c=$(post "$(otlp_body "$(otlp_rec req_S$i 1 0 0 0)")"); echo "$i $c"; done > "$V/c2/stream.log" 2>&1 ) &
LP=$!; sleep 0.6; kill -9 $SPID; wait $LP 2>/dev/null
ACK=$(grep -c ' 200$' "$V/c2/stream.log"); echo "acked(200)=$ACK of 200 before/after kill"
T=$(sumj | jqn .total); echo "total after kill=$T expected>=$((1307+ACK)) (acked must all be present)"
[ "$T" -ge $((1307+ACK)) ] && [ "$T" -le $((1307+ACK+1)) ] && echo DURABLE_OK || echo DURABLE_MISMATCH
serve_bg || exit 1
echo "== replay whole stream after restart (expect total=1307+200=1507)"
for i in $(seq 1 200); do post "$(otlp_body "$(otlp_rec req_S$i 1 0 0 0)")" >/dev/null; done; tot
echo "== transcript import twice + overlap with live"
P="$V/c2/projects/-proj"; mkdir -p "$P/sess1/subagents"
mk() { echo "{\"type\":\"assistant\",\"timestamp\":\"2026-11-10T02:00:00.000Z\",\"sessionId\":\"sess1\",\"requestId\":\"$1\",\"message\":{\"model\":\"claude-opus-5-5\",\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"x\"}],\"usage\":{\"input_tokens\":$2,\"output_tokens\":$3,\"cache_creation_input_tokens\":$4,\"cache_read_input_tokens\":$5,\"cache_creation\":{\"ephemeral_5m_input_tokens\":$4,\"ephemeral_1h_input_tokens\":0}}}}"; }
{ mk req_D1 10 20 30 40; mk req_T1 5 5 5 5; mk req_T1 5 5 5 5; mk req_T1 5 5 5 5; mk req_T2 1 1 1 1; } > "$P/sess1.jsonl"
{ mk req_SUB1 100 0 0 0; } > "$P/sess1/subagents/agent-a.jsonl"
$CLI import --dry-run --projects "$V/c2/projects"
$CLI import --yes --projects "$V/c2/projects"; tot
echo "-- second import (expect unchanged 1507+20+4+100=1631)"
$CLI import --yes --projects "$V/c2/projects"; tot
echo "-- live OTel for an already-imported request id (req_T1) (expect unchanged)"; post "$(otlp_body "$(otlp_rec req_T1 5 5 5 5)")"; echo; tot
echo "-- conflicting counts for same rid from other origin (expect unchanged, conflicts diag)"; post "$(otlp_body "$(otlp_rec req_T2 999 1 1 1)")"; echo; tot
sumj | jqn '.diagnostics'
echo "== A5: delete transcripts, total unchanged"; rm -rf "$V/c2/projects"; tot
echo "== restart collector, total unchanged"; kill $SPID; wait $SPID 2>/dev/null; serve_bg; tot
grep -c . "$TOKEN_LEDGER_HOME/collector.log"; tail -3 "$TOKEN_LEDGER_HOME/collector.log"
kill $SPID
