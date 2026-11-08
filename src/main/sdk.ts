// 整个应用里唯一引入 Claude Agent SDK 的地方。
// SDK 只提供 ESM，主进程打包成 CJS，所以用动态 import 加载。
import { join } from 'node:path'
import { createRequire } from 'node:module'
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { app } from 'electron'
import { adoptLoginShellEnv } from './env'
import { proxyEnvironment, readSystemProxy } from './systemProxy'
import { temporaryQuery } from './temporaryQuery'
import * as store from './store'

export type Sdk = typeof import('@anthropic-ai/claude-agent-sdk')

let sdk: Promise<Sdk> | undefined

export async function loadSdk(): Promise<Sdk> {
  const [loaded, systemProxy] = await Promise.all([
    sdk ??= import('@anthropic-ai/claude-agent-sdk'),
    readSystemProxy(),
    app.isPackaged ? adoptLoginShellEnv() : undefined
  ])
  // 每个 CLI 入口共用代理继承，显式环境配置优先；不修改桌面主进程的环境。
  return {
    ...loaded,
    query: params => loaded.query({
      ...params,
      options: {
        ...params.options,
        env: proxyEnvironment(systemProxy, { ...process.env, ...params.options?.env })
      }
    })
  }
}

/**
 * claude 可执行文件路径：设置里的自定义路径优先；
 * 打包后 SDK 会把路径解析到 app.asar 里面（无法执行），要改指向解包出来的副本。
 */
export function claudeExecutable(): string | undefined {
  const custom = store.read().settings.claudePath
  if (custom) return custom
  if (!app.isPackaged) return undefined
  return join(
    process.resourcesPath,
    'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude'
  )
}

/** Resolve the same bundled engine for status/login commands, including development builds. */
export function claudeRuntime(): { path: string; source: 'custom' | 'bundled' } {
  const selected = claudeExecutable()
  return {
    path: selected ?? createRequire(join(app.getAppPath(), 'package.json')).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`),
    source: store.read().settings.claudePath ? 'custom' : 'bundled'
  }
}

/** 不发消息、不持久化，取得结果后立即释放查询。 */
export function withIdleQuery<T>(options: Options, fn: (q: Query) => Promise<T>): Promise<T> {
  return temporaryQuery(async (abortController, input) => {
    const sdk = await loadSdk()
    if (abortController.signal.aborted) throw new Error('临时查询已取消')
    return sdk.query({ prompt: input, options: { pathToClaudeCodeExecutable: claudeExecutable(), ...options, persistSession: false, abortController } })
  }, fn, options.abortController?.signal)
}
