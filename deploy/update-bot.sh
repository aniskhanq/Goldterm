#!/bin/bash
# Update the forward-test bot on the EC2 server (goldterm-web) from a git ref, through SSM Run Command.
# Usage (Git Bash, from anywhere):  bash deploy/update-bot.sh [git-ref]      default ref: release-1.1.x
# Copies strategies.js + tools/forward-test.mjs into /opt/goldterm (keeps owner/mode, backs up the old files as *.bak),
# checks the syntax, restarts goldterm-bot and prints its status and last log lines. State in /opt/goldterm/forward is kept.
set -euo pipefail
export MSYS_NO_PATHCONV=1
REF=${1:-release-1.1.x}; R=ap-southeast-2; I=i-0ea0cdb7f850de571
REPO=$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))   # Windows path: MSYS_NO_PATHCONV stops /c/... conversion
b64() { git -C "$REPO" -c core.autocrlf=false show "$REF:$1" | base64 -w0; }
S=$(b64 strategies.js); F=$(b64 tools/forward-test.mjs)
P=$(cygpath -m "$(mktemp)" 2>/dev/null || mktemp)
cat > "$P" <<JSON
{"commands":["set -e","cd /opt/goldterm","cp -p strategies.js strategies.js.bak","cp -p tools/forward-test.mjs tools/forward-test.mjs.bak",
"echo $S | base64 -d > strategies.js","echo $F | base64 -d > tools/forward-test.mjs",
"node --check tools/forward-test.mjs && node -e \"require('vm').runInThisContext(require('fs').readFileSync('strategies.js','utf8')); if (typeof GoldStrategies.paperAccount !== 'function') process.exit(1)\" || { cp -p strategies.js.bak strategies.js; cp -p tools/forward-test.mjs.bak tools/forward-test.mjs; echo 'check failed - old files restored'; exit 1; }",
"echo config: \$(cat forward/config.json)","systemctl restart goldterm-bot","sleep 12","echo bot: \$(systemctl is-active goldterm-bot)",
"journalctl -u goldterm-bot -n 4 --no-pager -o cat | cut -c1-220"]}
JSON
if [ -n "${DRY:-}" ]; then cat "$P"; rm -f "$P"; exit 0; fi   # DRY=1: print the SSM payload only
echo "== updating bot from $REF"
id=$(aws ssm send-command --region $R --instance-ids $I --document-name AWS-RunShellScript --parameters "file://$P" --query Command.CommandId --output text)
rm -f "$P"
for i in $(seq 1 30); do st=$(aws ssm get-command-invocation --region $R --command-id "$id" --instance-id $I --query Status --output text 2>/dev/null || echo Pending)
  case $st in Success|Failed|Cancelled|TimedOut) break;; esac; sleep 2; done
aws ssm get-command-invocation --region $R --command-id "$id" --instance-id $I --query '[StandardOutputContent,StandardErrorContent]' --output text | iconv -t ascii//TRANSLIT
echo "== $st"
