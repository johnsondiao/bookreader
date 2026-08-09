/**
 * 核心纯函数单元测试（vitest 风格）。
 *
 * 覆盖：
 *  - chapterParser: isSentenceEnd, splitSentences（句子切分——阅读器高亮与 TTS 分段对齐的基石）
 *  - minimaxTts: estimateTtsCost（费用计算，直接影响"今日花费"数字）
 *  - audioFileStore: safeName（文件名消毒——决定索引重建是否能找回音频）
 *
 * 运行：npm test / npx vitest run tests/core.test.ts
 */
import { describe, expect, it } from 'vitest'
import { isSentenceEnd, splitSentences } from '../src/utils/chapterParser'
import { estimateTtsCost } from '../src/utils/minimaxTts'
import { safeName } from '../src/utils/audioFileStore'

describe('isSentenceEnd', () => {
  it('中文标点', () => {
    expect(isSentenceEnd('。')).toBe(true)
    expect(isSentenceEnd('！')).toBe(true)
    expect(isSentenceEnd('？')).toBe(true)
    expect(isSentenceEnd('；')).toBe(true)
    expect(isSentenceEnd('…')).toBe(true)
    expect(isSentenceEnd('\n')).toBe(true)
  })
  it('英文标点', () => {
    expect(isSentenceEnd('.')).toBe(true)
    expect(isSentenceEnd('!')).toBe(true)
    expect(isSentenceEnd('?')).toBe(true)
    expect(isSentenceEnd(';')).toBe(true)
  })
  it('非句子末尾字符返回 false', () => {
    for (const ch of ['，', '、', '：', '"', '(', ')', 'a', '1', '中', ' ', '~']) {
      expect(isSentenceEnd(ch)).toBe(false)
    }
  })
})

describe('splitSentences', () => {
  it('空输入返回空数组', () => {
    expect(splitSentences('')).toEqual([])
  })
  it('中文简单句：每句包含句末标点', () => {
    expect(splitSentences('你好。我是小明。今天天气好！')).toEqual([
      '你好。',
      '我是小明。',
      '今天天气好！',
    ])
  })
  it('末尾没有标点的残句也作为一句', () => {
    expect(splitSentences('第一句。第二句未完')).toEqual(['第一句。', '第二句未完'])
  })
  it('换行也会断句', () => {
    expect(splitSentences('line1\nline2')).toEqual(['line1\n', 'line2'])
  })
  it('混合中英文标点', () => {
    expect(splitSentences('Hi! How are you? I am fine.')).toEqual([
      'Hi!',
      ' How are you?',
      ' I am fine.',
    ])
  })
  it('分号作为句末（; 与 ；）', () => {
    expect(splitSentences('其一；其二;其三')).toEqual(['其一；', '其二;', '其三'])
  })
  it('省略号（…）作为句末字符，遇到两个连续 … 会独立切分', () => {
    // 输入包含两个连续的省略号（U+2026 ……），每个都是独立句末标记
    const arr = splitSentences('沉默良久……终于开口了。')
    expect(arr[0]).toBe('沉默良久…')
    expect(arr[1]).toBe('…')
    expect(arr[2]).toBe('终于开口了。')
  })
})

describe('estimateTtsCost', () => {
  // Turbo: ¥200 / 百万字符
  it('0 字符 => 0 元', () => expect(estimateTtsCost(0)).toBe(0))
  it('100 万字符 => 200 元', () => expect(estimateTtsCost(1_000_000)).toBe(200))
  it('1 万字符 => 2 元（文档承诺值）', () => expect(estimateTtsCost(10_000)).toBe(2))
  it('1 字符非常接近 0（非负）', () => {
    const r = estimateTtsCost(1)
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThan(0.001)
  })
  it('负数取负（调用方负责非负，此处不钳制以暴露异常）', () => {
    expect(estimateTtsCost(-1)).toBeLessThan(0)
  })
})

describe('safeName', () => {
  it('保留小数点（P0 回归测试：毛选 2.0）', () => {
    expect(safeName('毛选 2.0')).toBe('毛选 2.0')
    expect(safeName('版本 3.14.159')).toBe('版本 3.14.159')
  })
  it('控制字符 \\t \\r \\n 视为非法字符转为 _，其余空格再压缩', () => {
    // 实现顺序：先替换 [\\/:*?"<>|\r\n\t~] → _，再替换 \s+ → ' '
    // 因此 \t\r\n 先变成 _，不会被后续空白压缩再改成空格
    expect(safeName('有\t制表\r符\n换行')).toBe('有_制表_符_换行')
    // 普通空格仍被压缩
    expect(safeName('字 A   B  C')).toBe('字 A B C')
  })
  it('文件名分隔符 ~~ 里的 ~ 被替换（确保 index 重建解析安全）', () => {
    expect(safeName('foo~~bar~baz')).toBe('foo__bar_baz')
  })
  it('多余空白压缩并 trim', () => {
    expect(safeName('   a   b  ')).toBe('a b')
  })
  it('超过 max 长度自动截断（默认 60）', () => {
    const long = '中'.repeat(100)
    const r = safeName(long)
    expect(r.length).toBe(60)
    expect(r).toBe('中'.repeat(60))
  })
  it('支持自定义 max', () => {
    expect(safeName('0123456789', 3)).toBe('012')
  })
  it('null/undefined 安全：返回空字符串', () => {
    // @ts-expect-error 故意传入非 string
    expect(safeName(null)).toBe('')
    // @ts-expect-error 故意传入非 string
    expect(safeName(undefined)).toBe('')
  })
  it('空串返回空串', () => {
    expect(safeName('')).toBe('')
  })
})
