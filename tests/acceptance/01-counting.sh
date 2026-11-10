#!/usr/bin/env bash
# Check 1: counting math
. "$(dirname "$0")/common.sh"
fresh c1 47401; serve_bg || exit 1
echo "== A: known counts incl. 5m/1h (10+200+500+1000=1710), string ints (1+2+3+4=10)"
B=$(otlp_body "$(otlp_rec req_A1 10 200 500 1000 100 400)" "$(otlp_rec req_A2 '"1"' '"2"' '"3"' '"4"' '"1"' '"2"')")
echo "POST -> $(post "$B")"; sleep 1.3
sumj | jqn '.total'; sumj | jqn '.breakdown'; sumj | jqn '.requests'
echo "== B: invalid counts (each must be rejected -> gap, total unchanged at 1720)"
i=0
for bad in '-5' '2000000000' '1.5' '"NaN"' '"abc"' '1e400' '"-1"' '"1.5"' '"0x10"' '9007199254740993' 'true' '""'; do
  i=$((i+1))
  echo "bad=$bad POST -> $(post "$(otlp_body "$(otlp_rec req_BAD$i "$bad" 1 1 1)")")"
done
# NaN literal / doubleValue NaN / negative double
echo "doubleValue -3 -> $(post '{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"claude_code.api_request"},"attributes":[{"key":"request_id","value":{"stringValue":"req_BADD1"}},{"key":"input_tokens","value":{"doubleValue":-3}},{"key":"output_tokens","value":{"intValue":1}}]}]}]}]}')"
echo "doubleValue 2.5 -> $(post '{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"claude_code.api_request"},"attributes":[{"key":"request_id","value":{"stringValue":"req_BADD2"}},{"key":"input_tokens","value":{"doubleValue":2.5}},{"key":"output_tokens","value":{"intValue":1}}]}]}]}]}')"
echo "doubleValue \"NaN\" -> $(post '{"resourceLogs":[{"scopeLogs":[{"logRecords":[{"body":{"stringValue":"claude_code.api_request"},"attributes":[{"key":"request_id","value":{"stringValue":"req_BADD3"}},{"key":"input_tokens","value":{"doubleValue":"NaN"}},{"key":"output_tokens","value":{"intValue":1}}]}]}]}]}')"
echo "bad 5m only (-7) with good core 1+1+1+1 -> $(post "$(otlp_body "$(otlp_rec req_BAD5M 1 1 1 1 -7 3)")")"
echo "5m+1h > cache_write (cw=10,5m=500,1h=500) -> $(post "$(otlp_body "$(otlp_rec req_INCONS 0 0 10 0 500 500)")")"
echo "== C: no request_id (must not count, gap shown)"
echo "POST -> $(post "$(otlp_body "$(otlp_rec - 7 7 7 7)")")"
echo "empty request_id -> $(post "$(otlp_body "$(otlp_rec '' 7 7 7 7)")")"
sleep 1.3
sumj | jqn '.total'; sumj | jqn '.requests'; sumj | jqn '.breakdown'; sumj | jqn '.gaps'
$CLI summary; $CLI summary --details
kill $SPID
