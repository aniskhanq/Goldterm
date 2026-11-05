#!/bin/bash
# GoldTerm: keep the earlier site at http://<ip>/ and serve 1.2.0+ from /v2/ (what CloudFront shows).
# 1) server: html-v2 folder (copy of today's site), nginx /v2/ rule, deploy unit -> html-v2   (via SSM)
# 2) CloudFront: origin path /v2   (CloudFormation stack update)
# Stops at the first error. Touches neither /usr/share/nginx/html nor the bot.
set -euo pipefail
export MSYS_NO_PATHCONV=1
R=ap-southeast-2; I=i-0ea0cdb7f850de571; REPO=C:/Users/anisr/xauusd-terminal
N=$(base64 -w0 "$REPO/deploy/nginx-goldterm-v2.conf" | tr -d '\r'); U=$(base64 -w0 "$REPO/deploy/goldterm-deploy.service" | tr -d '\r')
P=$(cygpath -m "$(mktemp)")   # Windows aws.exe can't read MSYS /tmp paths
cat > "$P" <<EOF
{"commands":["set -e","install -d -m 755 /usr/share/nginx/html-v2","for f in index.html app.js strategies.js styles.css levels.js; do cp -p /usr/share/nginx/html/\$f /usr/share/nginx/html-v2/; done","chcon -R --reference=/usr/share/nginx/html /usr/share/nginx/html-v2 2>/dev/null || true","echo $N | base64 -d | tr -d '\\\\r' > /etc/nginx/default.d/goldterm-v2.conf","nginx -t 2>&1 | tail -1","systemctl reload nginx","echo $U | base64 -d | tr -d '\\\\r' > /etc/systemd/system/goldterm-deploy.service","systemctl daemon-reload","systemctl show goldterm-deploy.service -p Environment","echo root: \$(curl -fsS http://127.0.0.1/ | grep -o '?v=[0-9.]*' | sort -u)","echo v2: \$(curl -fsS http://127.0.0.1/v2/ | grep -o '?v=[0-9.]*' | sort -u)","echo v2 app.js \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/v2/app.js) v2 trades.json \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/v2/trades.json) root trades.json \$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/trades.json)"]}
EOF
echo "== 1/2 server"
id=$(aws ssm send-command --region $R --instance-ids $I --document-name AWS-RunShellScript --parameters "file://$P" --query Command.CommandId --output text)
rm -f "$P"
for i in $(seq 1 20); do
  st=$(aws ssm get-command-invocation --region $R --command-id "$id" --instance-id $I --query Status --output text 2>/dev/null || echo Pending)
  case $st in Success|Failed|Cancelled|TimedOut) break;; esac; sleep 2
done
aws ssm get-command-invocation --region $R --command-id "$id" --instance-id $I --query '[StandardOutputContent,StandardErrorContent]' --output text | iconv -t ascii//TRANSLIT
[ "$st" = Success ] || { echo "server step: $st - stopping before CloudFront"; exit 1; }
echo "== 2/2 CloudFront origin path /v2 (takes a few minutes)"
aws cloudformation deploy --region $R --stack-name goldterm-auth --template-file "$REPO/deploy/auth-stack.yaml" --capabilities CAPABILITY_IAM \
  --parameter-overrides SiteOriginDomain=ec2-3-107-25-107.ap-southeast-2.compute.amazonaws.com SiteOriginPath=/v2 --tags project=goldterm
echo "== done"
