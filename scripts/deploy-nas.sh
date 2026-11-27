#!/usr/bin/env bash
# OwnFlick 一键部署到私有 NAS（以群晖为例）：同步源码、构建镜像、更新容器并做健康检查。
#
# 用法：
#   scripts/deploy-nas.sh                  同步源码 → 备份镜像 → 构建 → 更新容器 → 健康检查
#   scripts/deploy-nas.sh --rollback       回滚到上一次部署时备份的镜像
#   scripts/deploy-nas.sh --rollback <tag> 回滚到指定备份镜像
#
# 首次使用前请按自己的环境配置（可写入 shell profile 或 .env 后 source）：
#   export NAS_HOST="user@nas-host"                  # SSH 目标（必填）
#   export NAS_DIR="/path/to/ownflick"               # NAS 上的构建上下文目录（必填）
#   export COMPOSE_DIR="/path/to/docker/ownflick"    # docker compose 项目目录（必填）
#   export NAS_DEPLOY_HELPER="/path/to/nas_deploy.py"# 可选：docker 需要 sudo 时的提权助手
#   export BASE_URL="http://nas-host:8010"            # 可选：对外访问地址（默认由 NAS_HOST 推导）
#
# 依赖：文件同步走免密 ssh；docker 命令可经提权助手以 sudo 执行。
set -euo pipefail

: "${NAS_HOST:?请设置 NAS_HOST，例如 user@nas-host}"
: "${NAS_DIR:?请设置 NAS_DIR，例如 /path/to/ownflick}"
: "${COMPOSE_DIR:?请设置 COMPOSE_DIR，例如 /path/to/docker/ownflick}"
HELPER="${NAS_DEPLOY_HELPER:-}"
IMAGE="ownflick-local:0.8.51"
BASE_URL="${BASE_URL:-http://${NAS_HOST#*@}:8010}"
MARKER="$COMPOSE_DIR/.ownflick-last-backup"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m错误：%s\033[0m\n' "$*" >&2; exit 1; }

remote() { ssh -o BatchMode=yes "$NAS_HOST" "$@"; }
priv() {
  [ -f "$HELPER" ] || die "找不到提权助手 ${HELPER}（可用 NAS_DEPLOY_HELPER 覆盖）"
  python3 "$HELPER" run "export PATH=/usr/local/bin:\$PATH; $1"
}

health_check() {
  # 应用启动时会全量扫描媒体库，期间不响应 HTTP；--noproxy 绕开本地代理
  # （代理会把连接失败伪装成 502）。最多等待 5 分钟。
  local code attempt
  for attempt in $(seq 1 30); do
    code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --connect-timeout 5 "$BASE_URL/login" || true)
    if [ "${code}" = "200" ]; then break; fi
    if [ "${attempt}" = "30" ]; then die "健康检查失败：等待 5 分钟后 $BASE_URL/login 仍返回 ${code}"; fi
    log "服务尚未就绪（${code}），10 秒后重试（${attempt}/30）…"
    sleep 10
  done
  code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$BASE_URL/static/base.css" || true)
  [ "${code}" = "200" ] || die "健康检查失败：静态资源返回 ${code}"
  local status
  # sed 去掉空行：helper 输出尾随空行会让 tail -1 取到空串而误报。
  status=$(priv "docker ps --filter name=ownflick --format '{{.Status}}'" | sed '/^[[:space:]]*$/d' | tail -1)
  case "$status" in
    Up*) log "容器状态：${status}" ;;
    *) die "容器未运行：${status}" ;;
  esac
}

rollback() {
  local tag="${1:-}"
  if [ -z "$tag" ]; then
    log "读取上次备份镜像标记"
    tag=$(priv "cat $MARKER 2>/dev/null" | tail -1)
    [ -n "$tag" ] || die "没有备份标记，可手动指定：deploy-nas.sh --rollback <tag>"
  fi
  log "回滚镜像：$tag → $IMAGE"
  priv "docker tag $tag $IMAGE && cd $COMPOSE_DIR && docker compose up -d"
  sleep 5
  health_check
  log "回滚完成。"
}

deploy() {
  log "同步源码到 $NAS_DIR"
  (cd "$PROJECT_DIR" && tar czf - --exclude='__pycache__' \
    spooly scripts pyproject.toml README.md LICENSE) \
    | remote "tar xzf - -C $NAS_DIR"

  local backup="$IMAGE-prev-$(date +%Y%m%d%H%M)"
  log "备份当前镜像：$IMAGE → $backup"
  priv "docker tag $IMAGE $backup && echo $backup > $MARKER"

  log "构建镜像（约 1–3 分钟）"
  priv "cd $COMPOSE_DIR && docker compose build"

  log "更新容器"
  priv "cd $COMPOSE_DIR && docker compose up -d"
  sleep 5

  log "健康检查"
  health_check
  log "部署完成。回滚命令：scripts/deploy-nas.sh --rollback"
}

case "${1:-deploy}" in
  --rollback) rollback "${2:-}" ;;
  deploy)     deploy ;;
  *)          die "未知参数：$1（支持 --rollback [tag]）" ;;
esac
