/**
 * 骨架冒烟测试（由 dsh-plugin-forge 生成，2026-09-14）。
 * 只断言结构、不依赖构建产物——`npm test` 在生成后立刻可跑；
 * 业务逻辑测试请另加 tests/<主题>.test.mjs（跑 lib/ 产物，与运行时同源）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

test('package.json 可解析且暴露 build/test 脚本', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, "dsh-identity-ops")
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.ok(pkg.scripts.build, '必须有 build 脚本')
  assert.ok(pkg.scripts.test, '必须有 test 脚本（回归能力）')
})

test('src/index.ts 暴露 name / inject / apply', () => {
  const src = readFileSync(join(root, 'src', 'index.ts'), 'utf8')
  assert.ok(src.includes('export const name = '), '必须导出 name')
  assert.ok(src.includes('export const inject = '), '必须导出 inject')
  assert.ok(src.includes('export function apply('), '必须导出 apply')
})

test('tsconfig.json 是 ESM/NodeNext 配置', () => {
  const ts = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'))
  assert.equal(ts.compilerOptions.module, 'NodeNext')
  assert.equal(ts.compilerOptions.outDir, 'lib')
})

test('语义文档存在（新能力开工前先落文档）', () => {
  assert.ok(existsSync(join(root, 'docs', 'semantic.md')), '缺 docs/semantic.md')
})

test('cordis.patch.yml 含组合行 id', () => {
  const yml = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.ok(yml.includes("agent-identity-ops"))
})
