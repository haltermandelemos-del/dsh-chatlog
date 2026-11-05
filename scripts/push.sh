#!/usr/bin/env bash
# 把本地仓库推到 GitHub（含 tag）。
#   GITHUB_TOKEN=xxx GITHUB_USER=你的用户名 ./scripts/push.sh [仓库名]
# 推送完会把 remote 地址里的 token 抹掉，不会留在 .git/config 里。
set -euo pipefail
: "${GITHUB_TOKEN:?请先设置 GITHUB_TOKEN}"
: "${GITHUB_USER:?请先设置 GITHUB_USER（你的 GitHub 用户名）}"
REPO="${1:-dsh-chatlog}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

git remote remove origin 2>/dev/null || true
git remote add origin "https://${GITHUB_USER}:${GITHUB_TOKEN}@github.com/${GITHUB_USER}/${REPO}.git"
trap 'git remote set-url origin "https://github.com/${GITHUB_USER}/${REPO}.git" 2>/dev/null || true' EXIT

git push -u origin "$BRANCH"
git push origin --tags
echo "完成：https://github.com/${GITHUB_USER}/${REPO}"
