#!/usr/bin/env bash
# Stand-in for `claude -p ... --output-format json` used by the e2e test.
prompt="$2"; resume=""
for ((i=1;i<=$#;i++)); do [[ "${!i}" == "--resume" ]] && { j=$((i+1)); resume="${!j}"; }; done
echo "$(date +%s) cwd=$PWD resume=$resume prompt=$(printf %s "${prompt:0:80}" | tr "\n" " ")" >> "${FAKE_CLAUDE_LOG:-/tmp/fake-claude.log}"
if [[ "$prompt" == *SIMULATE_LIMIT* ]]; then
  echo '{"type":"result","is_error":true,"result":"Claude AI usage limit reached|1763600000"}'; exit 1
fi
sid="${resume:-sess-$RANDOM}"
if [[ -n "$resume" ]]; then
  printf '{"type":"result","is_error":false,"session_id":"%s","result":"Resumed and handled the follow-up."}\n' "$sid"
else
  printf '{"type":"result","is_error":false,"session_id":"%s","result":"Fixed it. PR: https://github.com/Quillhash/demo/pull/7"}\n' "$sid"
fi
