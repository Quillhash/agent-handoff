#!/usr/bin/env bash
# Stand-in for `claude -p ... --output-format json` used by the e2e test.
prompt="$2"; resume=""
mode=""
for ((i=1;i<=$#;i++)); do j=$((i+1)); [[ "${!i}" == "--resume" ]] && resume="${!j}"; [[ "${!i}" == "--permission-mode" ]] && mode="${!j}"; done
echo "$(date +%s) cwd=$PWD mode=$mode resume=$resume prompt=$(printf %s "${prompt:0:80}" | tr "\n" " ")" >> "${FAKE_CLAUDE_LOG:-/tmp/fake-claude.log}"
if [[ "$prompt" == *SIMULATE_COMMIT* ]]; then
  echo "fix" > fix.txt && git add fix.txt && git commit -qm "Fix" && git push -q -u origin HEAD 2>/dev/null
  printf '{"type":"result","is_error":false,"session_id":"sess-c","result":"Committed and pushed. PR: https://github.com/Quillhash/demo/pull/8","permission_denials":[]}\n'; exit 0
fi
if [[ "$prompt" == *SIMULATE_DENIAL* ]]; then
  echo "half done" > fix.txt
  printf '{"type":"result","is_error":false,"session_id":"sess-d","result":"Made fixes 1-4 but could not commit: git needs approval.","permission_denials":[{"tool_name":"Bash","tool_input":{"command":"git commit -am fix"}}]}\n'; exit 0
fi
if [[ "$prompt" == *SIMULATE_LIMIT* ]]; then
  echo '{"type":"result","is_error":true,"result":"Claude AI usage limit reached|1763600000"}'; exit 1
fi
sid="${resume:-sess-$RANDOM}"
if [[ -n "$resume" ]]; then
  printf '{"type":"result","is_error":false,"session_id":"%s","result":"Resumed and handled the follow-up."}\n' "$sid"
else
  printf '{"type":"result","is_error":false,"session_id":"%s","result":"Fixed it. PR: https://github.com/Quillhash/demo/pull/7"}\n' "$sid"
fi
