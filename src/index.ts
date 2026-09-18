/**
 * dsh-identity-ops —— 数字身份运维工具
 *
 * 由临时脚本抽象而来（2026-09-16，主人指令「有效的临时工具脚本应该抽象成通用的插件工具」）。
 * 抽象的不只是代码，是**能力**：
 *   · 邮箱操作走 qrypty 的 API（纯 HTTP，零浏览器，~3 秒）
 *   · 站点知识存注册表 ⇒ 新增一个站点是**加一条记录**，不是加一个脚本（可成长）
 *   · HTTP 一律经 Clash 显式代理且 fail-closed（代理不通即失败，绝不裸连）
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

export const name = 'agent-identity-ops'
export const inject = ['tools'] as const

export interface Config { enabled: boolean; stateDir: string; proxy: string }
export const Config = z.object({
  enabled: z.boolean().default(true),
  /** 状态目录（存 session 与站点注册表） */
  stateDir: z.string().default('E:/alice/projects/self/alice-identity/state'),
  /** 出口代理：必须显式给，代理不通即失败（G6 fail-closed，不裸连） */
  proxy: z.string().default('http://127.0.0.1:16888'),
})

/** undici 用 cjs require 取，绕开 TS 类型解析（宿主已有） */
const req = createRequire(import.meta.url)
function undici(): any { return req('undici') }

type Mailbox = { statePath: string; apiBase: string; tokenKey: string }

function registryPath(stateDir: string): string { return stateDir + '/site-registry.json' }

function loadRegistry(stateDir: string): any {
  try {
    const p = registryPath(stateDir)
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { mailboxes: {}, sites: {} }
  } catch { return { mailboxes: {}, sites: {} } }
}

/** 邮箱配置来自注册表 ⇒ 换邮箱是改数据，不是改代码 */
function mailboxOf(stateDir: string): Mailbox {
  const reg = loadRegistry(stateDir)
  const m = reg?.mailboxes?.qrypty
  return m && m.statePath ? m : { statePath: stateDir + '/qrypty-session.json', apiBase: 'https://qrypty.com', tokenKey: 'qrypty_token' }
}

/** 从 Playwright storageState 里取会话 token（token 一直躺在那里，不必开浏览器） */
function sessionToken(mb: Mailbox): string {
  const st = JSON.parse(readFileSync(mb.statePath, 'utf8'))
  for (const o of (st.origins || [])) {
    for (const kv of (o.localStorage || [])) if (kv.name === mb.tokenKey) return String(kv.value)
  }
  throw new Error('token not found in storageState: ' + mb.tokenKey)
}

async function mailGet(mb: Mailbox, proxy: string, path: string): Promise<any> {
  const { fetch: ufetch, ProxyAgent } = undici()
  const r = await ufetch(mb.apiBase + path, {
    headers: { Authorization: 'Bearer ' + sessionToken(mb), Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
    dispatcher: new ProxyAgent(proxy),
    signal: AbortSignal.timeout(40000),
  })
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + path)
  return await r.json()
}

function pickEmail(emails: any[], match: string): any {
  const rx = new RegExp(match, 'i')
  const hit = (emails || []).filter((x: any) =>
    rx.test([x.subject, x.from_address, x.from_name, x.snippet].filter(Boolean).join(' ')))
  if (!hit.length) throw new Error('no email matching: ' + match)
  return hit[0]
}

const textOut: any = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string', required: true } },
  } as const,
  render: (_a: unknown, v: any) => [{ type: 'text', text: String(v?.text ?? '') }],
}

/** 薄包装：defineTool 的泛型推断对共享 output 对象不友好；此处只消解类型摩擦，运行时等价 */
const tool = (spec: any): any => defineTool(spec)

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger('agent-identity-ops')
  const DIR = config.stateDir
  const PROXY = config.proxy

  const list = async (folder: string) => mailGet(mailboxOf(DIR), PROXY, `/api/emails/?folder=${encodeURIComponent(folder)}&page=1`)

  // ── 邮箱：列 ──────────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'id_mail_list',
    description: '列出锚点邮箱的邮件（默认收件箱）。返回「id短码 | 发件人 | 主题 | 时间」，用于确认验证信是否到达。',
    parameters: {
      limit: { type: 'number', description: '条数（默认 15）' },
      folder: { type: 'string', description: '文件夹（默认 inbox）' },
    },
    output: textOut,
    async execute(args: { limit?: number; folder?: string }) {
      const folder = args.folder || 'inbox'
      const d = await list(folder)
      const es = (d.emails || []).slice(0, args.limit || 15)
      if (!es.length) return { text: `(no mail in ${folder})` }
      return {
        text: es.map((e: any) => [
          String(e.id).slice(0, 8),
          String(e.from_address || '?').slice(0, 34),
          String(e.subject || '').slice(0, 52),
          String(e.received_at || e.created_at || '').slice(0, 19),
        ].join(' | ')).join('\n'),
      }
    },
  }))

  // ── 邮箱：读 ──────────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'id_mail_read',
    description: '读匹配邮件的正文（按 subject/发件人/摘要 正则匹配最新一封）。',
    parameters: {
      match: { type: 'string', required: true, description: '匹配正则（对 subject+发件人+摘要）' },
      chars: { type: 'number', description: '正文截断长度（默认 1200）' },
    },
    output: textOut,
    async execute(args: { match: string; chars?: number }) {
      const d = await list('inbox')
      const e = pickEmail(d.emails, args.match)
      const body = String(e.body_text || e.body || e.snippet || '')
      return { text: `id=${e.id}\nsubject=${e.subject}\nfrom=${e.from_address}\n---\n` + body.slice(0, args.chars || 1200) }
    },
  }))

  // ── 邮箱：取码 ────────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'id_mail_code',
    description: '从匹配邮件中提取验证码。默认模式：code / verification code / entering the code below 之后的 4-10 位数字。',
    parameters: {
      match: { type: 'string', required: true, description: '匹配邮件的正则' },
      pattern: { type: 'string', description: '自定义提取正则（须含一个捕获组）' },
    },
    output: textOut,
    async execute(args: { match: string; pattern?: string }) {
      const d = await list('inbox')
      const e = pickEmail(d.emails, args.match)
      const body = String(e.body_text || e.body || e.snippet || '')
      const rx = new RegExp(args.pattern || '(?:code|verification code|verify|entering the code below)[^0-9]{0,80}([0-9]{4,10})', 'i')
      const m = rx.exec(body)
      if (!m) throw new Error('pattern not found in subject: ' + e.subject)
      return { text: m[1] }
    },
  }))

  // ── 邮箱：取链 ────────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'id_mail_link',
    description: '从匹配邮件中列出链接（可 pattern 过滤）。提示：确认信里通常直接给确认链接 —— 优先走链接，别跟 OTP 表单较劲。',
    parameters: {
      match: { type: 'string', required: true, description: '匹配邮件的正则' },
      pattern: { type: 'string', description: 'URL 过滤正则（可选）' },
    },
    output: textOut,
    async execute(args: { match: string; pattern?: string }) {
      const d = await list('inbox')
      const e = pickEmail(d.emails, args.match)
      const body = String(e.body_text || '') + ' ' + String(e.body_html || '')
      let urls = [...new Set((body.match(/https?:\/\/[^\s"'<>)]+/g) || []).map((u: string) => u.replace(/[.,;]$/, '')))]
      if (args.pattern) { const prx = new RegExp(args.pattern, 'i'); urls = urls.filter((u) => prx.test(u)) }
      return { text: `subject=${e.subject}\n` + (urls.slice(0, 20).join('\n') || '(no link)') }
    },
  }))

  // ── 站点知识：记（成长机制）────────────────────────────────
  ctx.tools.register(tool({
    name: 'id_site_remember',
    description: '记录一条站点知识（token 位置 / API 端点 / 坑点 / 账号状态）。这是插件的成长机制：接一个新站点靠加记录，不靠加脚本。',
    parameters: {
      site: { type: 'string', required: true, description: '站点标识（如 github.com）' },
      key: { type: 'string', required: true, description: '知识键（tokenPath / apiBase / pitfall / account …）' },
      value: { type: 'string', required: true, description: '值' },
      note: { type: 'string', description: '备注' },
    },
    output: textOut,
    async execute(args: { site: string; key: string; value: string; note?: string }) {
      mkdirSync(DIR, { recursive: true })
      const reg = loadRegistry(DIR)
      reg.sites = reg.sites || {}
      reg.sites[args.site] = reg.sites[args.site] || {}
      reg.sites[args.site][args.key] = { value: args.value, note: args.note || '', at: new Date().toISOString() }
      writeFileSync(registryPath(DIR), JSON.stringify(reg, null, 1))
      log.info('remember %s.%s', args.site, args.key)
      return { text: `remembered ${args.site}.${args.key} = ${String(args.value).slice(0, 90)}` }
    },
  }))

  // ── 站点知识：查 ──────────────────────────────────────────
  ctx.tools.register(tool({
    name: 'id_site_facts',
    description: '读取站点知识注册表（指定 site 看详情，不传则列全部站点）。',
    parameters: { site: { type: 'string', description: '站点标识（不传=列全部）' } },
    output: textOut,
    async execute(args: { site?: string }) {
      const reg = loadRegistry(DIR)
      const sites = reg.sites || {}
      if (args.site) {
        const s = sites[args.site]
        return { text: s ? JSON.stringify(s, null, 1) : `(no facts for ${args.site})` }
      }
      const keys = Object.keys(sites)
      return { text: keys.length ? keys.map((k) => `${k} (${Object.keys(sites[k]).length} facts)`).join('\n') : '(registry empty)' }
    },
  }))

  log.info('identity-ops ready (stateDir=%s)', DIR)
}
