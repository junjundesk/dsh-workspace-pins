/**
 * dsh-workspace-pins — 宿主半边
 *
 * 负责插件唯一一件客户端做不到的事：**真正删除会话记录**。
 *
 * 宿主只暴露「归档会话」和「移除工作区注册」，没有删除会话的 API，而用户要的是
 * 「删掉工作区 + 它名下的对话记录」。所以这里补一条最小的宿主通道：
 *
 *   POST /dsh-workspace-pins/delete-sessions   { sessionIds: string[] }
 *
 * 处理方式是直接删除会话日志目录（JSONL 后端按 `sessions/<projectKey>/session-<id>/`
 * 存放，每个会话一个目录）。客户端在调用它之前会先归档这些会话，让宿主的写入句柄
 * 关闭，避免 Windows 上的占用。删除范围严格限制在 `<root>/<项目目录>/session-<id>`
 * 这一层，id 必须是白名单字符，绝不接受调用方传入路径。
 *
 * 其余功能（固定排序、面板 UI）都在客户端半边。
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 路由路径；客户端按同源相对路径 POST。 */
const ROUTE_PATH = '/dsh-workspace-pins/delete-sessions'
/** 一次请求最多删除的会话数，防止误传整表。 */
const MAX_BATCH = 500
/** 请求体上限。 */
const MAX_BODY_BYTES = 256 * 1024
/** 会话 id 只允许安全字符，杜绝路径穿越。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** 宿主等 Web 服务器就绪后再激活；没有它这个插件没有意义。 */
export const inject = ['webServer']

/**
 * 会话日志根目录：优先读生效配置里 JSONL 后端的 `root`，读不到再退回默认布局。
 * @param ctx - 含有可选 settings 服务的宿主上下文。
 * @returns 会话根目录的绝对路径。
 */
function resolveSessionsRoot(ctx) {
  try {
    const describe = ctx.settings?.describe
    if (typeof describe === 'function') {
      const entries = describe.call(ctx.settings) || []
      const entry = entries.find((item) => String(item?.ns ?? '').includes('session-persistence-jsonl'))
      const root = entry?.value?.root
      if (typeof root === 'string' && root.trim() !== '') return root
    }
  } catch {
    /* 设置服务不可用就走默认布局 */
  }
  return join(homedir(), '.dsh', 'sessions')
}

/** 读请求体文本，超过上限直接拒绝。 */
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** 回一个 JSON 响应。 */
function sendJson(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/**
 * 删除若干会话的日志目录。
 * 目录布局固定为 `<root>/<projectKey>/session-<id>/`，所以只需要在根下的一层项目
 * 目录里找同名会话目录；找不到记入 missing，删不掉记入 failed。
 * @param root - 会话根目录。
 * @param sessionIds - 已通过白名单校验的会话 id。
 * @returns 已删、没找到、删除失败三类结果，外加根目录是否缺失。
 */
async function removeSessionDirs(root, sessionIds) {
  const removed = []
  const missing = []
  const failed = []

  let projectDirs = []
  try {
    const entries = await readdir(root, { withFileTypes: true })
    projectDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch (error) {
    return {
      removed,
      missing: sessionIds,
      failed,
      rootMissing: true,
      error: String(error?.message ?? error),
    }
  }

  for (const sessionId of sessionIds) {
    const directoryName = `session-${sessionId}`
    let claimed = false
    for (const projectDir of projectDirs) {
      const candidate = join(root, projectDir, directoryName)
      try {
        const info = await stat(candidate)
        if (!info.isDirectory()) continue
      } catch {
        continue
      }
      try {
        await rm(candidate, { recursive: true, force: true })
        removed.push(sessionId)
      } catch (error) {
        failed.push({ sessionId, message: String(error?.message ?? error) })
      }
      claimed = true
      break
    }
    if (!claimed) missing.push(sessionId)
  }

  return { removed, missing, failed, rootMissing: false }
}

/**
 * 注册删除路由。参数与返回都是最小 JSON 形状，失败一律带可读原因。
 * @param ctx - 宿主上下文，需要 `webServer`。
 */
export function apply(ctx) {
  const handler = async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: 'method not allowed' })
      return
    }

    let payload
    try {
      const raw = await readBody(request)
      payload = raw ? JSON.parse(raw) : {}
    } catch (error) {
      sendJson(response, 400, { ok: false, error: String(error?.message ?? error) })
      return
    }

    const requested = Array.isArray(payload?.sessionIds) ? payload.sessionIds : null
    if (requested === null) {
      sendJson(response, 400, { ok: false, error: 'sessionIds must be an array' })
      return
    }
    if (requested.length > MAX_BATCH) {
      sendJson(response, 400, { ok: false, error: `at most ${MAX_BATCH} sessions per request` })
      return
    }

    const sessionIds = []
    for (const value of requested) {
      if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
        sendJson(response, 400, { ok: false, error: 'invalid session id' })
        return
      }
      sessionIds.push(value)
    }

    const root = resolveSessionsRoot(ctx)
    const result = await removeSessionDirs(root, sessionIds)
    sendJson(response, 200, { ok: true, root, ...result })
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler,
      }),
    'workspace-pins:delete-sessions-route'
  )
}
