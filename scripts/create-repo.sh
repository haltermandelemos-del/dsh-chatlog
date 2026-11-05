#!/usr/bin/env bash
# 在 GitHub 上建一个空仓库（只需要一次）。
#   GITHUB_TOKEN=xxx [GITHUB_USER=你的用户名] ./scripts/create-repo.sh [仓库名]
# GITHUB_USER 省略时按 token 的属主来建。
set -euo pipefail
: "${GITHUB_TOKEN:?请先设置 GITHUB_TOKEN（GitHub → Settings → Developer settings → Personal access tokens，勾 repo）}"
REPO="${1:-dsh-chatlog}"
if [ -n "${GITHUB_USER:-}" ]; then
  URL="https://api.github.com/repos/${GITHUB_USER}/${REPO}"
  BODY="{\"name\":\"${REPO}\",\"private\":false,\"description\":\"DSH 会话导出成本地纯文本：活着的在 DshChat，归档/已消失的在 DshChat/DeletedChat\"}"
else
  URL="https://api.github.com/user/repos"
  BODY="{\"name\":\"${REPO}\",\"private\":false,\"description\":\"DSH 会话导出成本地纯文本：活着的在 DshChat，归档/已消失的在 DshChat/DeletedChat\"}"
fi
code=$(curl -sS -o /tmp/gh-create.json -w '%{http_code}' -X POST "$URL" \
  -H "Authorization: Bearer ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -d "$BODY") || { echo "请求失败"; exit 1; }
if [ "$code" = "201" ]; then
  node -e 'const j=require("/tmp/gh-create.json");console.log("已创建: "+j.full_name+"  →  "+j.html_url)'
elif [ "$code" = "422" ]; then
  echo "仓库已存在（422），直接推就行。"
else
  echo "HTTP $code"; head -c 400 /tmp/gh-create.json; echo
  exit 1
fi
