/* eslint-disable no-console */
// 版本一致性校验脚本（作为 build / cap:sync 的前置钩子）：
//  1. package.json version 必须 == android/app/build.gradle versionName（文件存在时）
//  2. capacitor.config.ts 若显式声明 version 字段，则必须 == package.json version
// 任何一项不满足 → exit(1)，阻断构建，避免发布时版本号错位。
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const pkgPath = path.join(ROOT, 'package.json')
const gradlePath = path.join(ROOT, 'android', 'app', 'build.gradle')
const capPath = path.join(ROOT, 'capacitor.config.ts')

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const pkgVersion = pkg.version

let ok = true
const msgs = []

if (!pkgVersion) {
  msgs.push('package.json 缺少 version 字段')
  ok = false
}

if (fs.existsSync(gradlePath)) {
  const g = fs.readFileSync(gradlePath, 'utf8')
  // 兼容两种 gradle 风格：
  //   versionName "1.0"   (build.gradle 老 Groovy DSL)
  //   versionName = "1.0" (新 KTS 风格)
  const re = /versionName\s*(?:=)?\s*["']([^"']+)["']/
  const m = g.match(re)
  if (!m) {
    msgs.push('build.gradle 未找到 versionName（请确认 defaultConfig 块中写了 versionName "x.y"）')
    ok = false
  } else if (m[1] !== pkgVersion) {
    msgs.push(
      `版本号不一致：package.json = "${pkgVersion}"，android/app/build.gradle versionName = "${m[1]}"，` +
        '请保持两者完全一致再构建。'
    )
    ok = false
  }
}

if (fs.existsSync(capPath)) {
  const c = fs.readFileSync(capPath, 'utf8')
  // capacitor.config.ts 可选显式声明 version: "x.y"，未声明时 Capacitor 默认读 package.json
  const m = c.match(/version\s*:\s*["']([^"']+)["']/)
  if (m && m[1] !== pkgVersion) {
    msgs.push(
      `capacitor.config.ts 声明了显式 version "${m[1]}"，与 package.json "${pkgVersion}" 不一致，` +
        '请二选一：要么删掉 capacitor.config.ts 里的 version（让它默认读 package.json），要么改成相同值。'
    )
    ok = false
  }
}

if (!ok) {
  console.error('\n[版本校验失败]')
  for (const m of msgs) console.error('  - ' + m)
  console.error('')
  process.exit(1)
}

console.log(`[版本校验通过] package.json version = ${pkgVersion}`)
