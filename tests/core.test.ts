/**
 * 核心纯函数单元测试（vitest 风格）。
 *
 * 覆盖：
 *  - chapterParser: isSentenceEnd, splitSentences（句子切分——阅读器高亮与 TTS 分段对齐的基石）
 *  - minimaxTts: estimateTtsCost（费用计算，直接影响"今日花费"数字）
 *  - charStats: countSpeakableChars / withCharStats（导入时的字数统计与整本、单章费用预估）
 *  - audioFileStore: safeName（文件名消毒——决定索引重建是否能找回音频）
 *  - tts: classifyTtsError（错误分类——决定是否自动重试）
 *
 * 运行：npm test / npx vitest run tests/core.test.ts
 */
import { describe, expect, it } from 'vitest'
import { isSentenceEnd, splitSentences, parseChapters, splitParagraphTexts } from '../src/utils/chapterParser'
import { estimateTtsCost } from '../src/utils/minimaxTts'
import {
  CHAR_STATS_VERSION,
  countBillableChars,
  countSpeakableChars,
  costOfBillable,
  estimateBillableChars,
  formatCharCount,
  formatCostEstimate,
  withCharStats,
} from '../src/utils/charStats'
import { safeName } from '../src/utils/audioFileStore'
import { classifyTtsError } from '../src/utils/tts'
import { autoChapterizeIfNeeded, useAppStore } from '../src/store/useAppStore'
import { addSynthChars, getTodayBillable, getTodayChars, getTodayCostYuan } from '../src/utils/costTracker'
import { getClip, putClip, type ChapterAudio } from '../src/utils/audioCache'
import type { Book } from '../src/types'

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

describe('parseChapters', () => {
  it('网文数字编号标题（004 【xxx】风格）能自动切章', () => {
    const body = '这是正文内容，发生了一些事情。\n\n'
    const txt =
      '楔子\n\n开篇引子内容。\n\n' +
      '001 【穿越】\n' + body +
      '002 【初来驾到】\n' + body +
      '003 【风波起】\n' + body +
      '004 【杀人越货】\n' + body
    const chapters = parseChapters(txt)
    expect(chapters.length).toBeGreaterThanOrEqual(4)
    expect(chapters.some((c) => c.title.includes('杀人越货'))).toBe(true)
    // 每章正文都应非空
    for (const c of chapters) expect(c.content.trim().length).toBeGreaterThan(0)
  })
  it('编号不递增的数字行不采信（避免正文误切）', () => {
    const txt = '正文开头。\n\n5 他说。\n\n3 她说。\n\n4 大家说。\n\n正文结尾。'
    const chapters = parseChapters(txt)
    expect(chapters.length).toBe(1)
    expect(chapters[0].title).toBe('正文')
  })
  it('段落间无空行（单换行）的网文也能识别数字标题', () => {
    const txt =
      '楔子内容。\n' +
      '001 【穿越】\n正文一。\n' +
      '002 【初来驾到】\n正文二。\n' +
      '003 【风波起】\n正文三。\n' +
      '004 【杀人越货】\n正文四。'
    const chapters = parseChapters(txt)
    expect(chapters.length).toBeGreaterThanOrEqual(4)
    expect(chapters.some((c) => c.title.includes('杀人越货'))).toBe(true)
  })
  it('书首引子独立成序章；只有标题没正文的章被过滤', () => {
    const txt =
      '引子内容，崇祯元年夏。\n\n' +
      '001 【甲】\n正文一。\n\n' +
      '002 【乙】\n\n' +
      '003 【丙】\n正文三。\n\n' +
      '004 【丁】\n正文四。'
    const chapters = parseChapters(txt)
    expect(chapters[0].title).toBe('序章')
    // 每一章都有正文，"002 【乙】"（无正文）不在其中
    for (const c of chapters) expect(c.content.trim().length).toBeGreaterThan(0)
    expect(chapters.some((c) => c.title.includes('乙'))).toBe(false)
    expect(chapters.every((c) => c.id.length > 0)).toBe(true)
  })
  it('无明显章节结构的短文不拆分', () => {
    const txt = '这是一篇没有章节结构的短文，只有几个段落。\n\n第二段内容。\n\n第三段内容。'
    const chapters = parseChapters(txt)
    expect(chapters.length).toBe(1)
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

describe('charStats 显示字数', () => {
  it('口径与 TTS 发送的文本一致：段落 trim 后按 \n 拼接的长度', () => {
    const text = '  第一段。  \n\n\n  第二段！ \n'
    // tts.ts buildTextAndRanges 就是这么拼 fullText 的
    expect(countSpeakableChars(text)).toBe(splitParagraphTexts(text).join('\n').length)
  })
  it('缩进、空行、首尾空白不计入（直接用 content.length 会虚高）', () => {
    const text = '\n\n    正文六个字啊    \n\n\n    又六个字啊  \n'
    expect(countSpeakableChars(text)).toBe(6 + 1 + 5)
    expect(text.length).toBeGreaterThan(countSpeakableChars(text))
  })
  it('空文本 / 纯空白 => 0', () => {
    expect(countSpeakableChars('')).toBe(0)
    expect(countSpeakableChars('  \n \n\t\n ')).toBe(0)
  })
})

describe('charStats 计费字符（MiniMax：1 汉字 = 2 字符）', () => {
  it('汉字算 2，标点/英文/空格算 1', () => {
    expect(countBillableChars('你好')).toBe(4)
    expect(countBillableChars('你好，世界！')).toBe(10) // 4 汉字×2 + 2 标点
    expect(countBillableChars('Hello 世界')).toBe(10) // 5 字母 + 1 空格 + 2 汉字×2
    expect(countBillableChars('')).toBe(0)
  })
  it('代理对汉字（扩展 B 区）也是 2：JS 长度本就 2、不落在 BMP 范围里', () => {
    expect(countBillableChars('\u{20000}')).toBe(2)
  })
  it('整章预估：显示字数与计费字符分开，金额由计费字符算', () => {
    const text = '你好，世界。\nHello world'
    expect(countSpeakableChars(text)).toBe(18)
    expect(estimateBillableChars(text)).toBe(22) // 18 + 4 个汉字
    expect(costOfBillable(estimateBillableChars(text))).toBeCloseTo(0.0044, 10)
  })
  it('纯中文正文计费字符约为字数的 1.9 倍（旧口径按字数算会少一半）', () => {
    const text = '这是一个纯中文的句子，用来验证计费口径。'.repeat(10)
    const ratio = estimateBillableChars(text) / countSpeakableChars(text)
    expect(ratio).toBeGreaterThan(1.8)
    expect(ratio).toBeLessThan(2.01)
  })
  it('withCharStats 同时给出两套口径并汇总，旧值一律重算', () => {
    const r = withCharStats([
      { id: 'a', content: '一千个字'.repeat(3) },
      // 旧口径留下的错值必须被重算覆盖，否则金额继续算错
      { id: 'b', content: '  两段\n\n文字  ', charCount: 999, billableChars: 999 },
    ])
    expect(r.chapters[0].charCount).toBe(12)
    expect(r.chapters[0].billableChars).toBe(24) // 全汉字
    expect(r.chapters[1].charCount).toBe(5) // 两段(2) + \n(1) + 文字(2)
    expect(r.chapters[1].billableChars).toBe(9) // 5 + 4 个汉字
    expect(r.totalChars).toBe(17)
    expect(r.totalBillable).toBe(33)
  })
})

describe('charStats 费用与展示格式', () => {
  it('1 万计费字符 => ¥2（Turbo 单价）', () => expect(costOfBillable(10_000)).toBe(2))
  it('负数按 0 计，不出现负金额', () => expect(costOfBillable(-5)).toBe(0))
  it('formatCharCount 万/亿进位，可换单位', () => {
    expect(formatCharCount(999)).toBe('999字')
    expect(formatCharCount(15_000)).toBe('1.5万字')
    expect(formatCharCount(1_234_567)).toBe('123万字')
    expect(formatCharCount(120_000_000)).toBe('1.20亿字')
    expect(formatCharCount(15_000, '字符')).toBe('1.5万字符')
  })
  it('formatCostEstimate 小额保留三位，大额千分位', () => {
    expect(formatCostEstimate(0)).toBe('¥0')
    expect(formatCostEstimate(0.0005)).toBe('<¥0.001')
    expect(formatCostEstimate(0.6)).toBe('¥0.600')
    expect(formatCostEstimate(12.3456)).toBe('¥12.35')
    expect(formatCostEstimate(2469.4)).toBe('¥2,469')
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

describe('autoChapterizeIfNeeded', () => {
  it('旧算法（v2）切出的多章书会还原文本重切，淘汰垃圾章', () => {
    const chapters = [
      { id: 'ch-0', title: '001 【穿越】', startIndex: 0, content: '赵瀚迷迷糊糊，并未彻底醒来。' },
      // v2 垃圾章：正文就是标题行本身
      { id: 'ch-1', title: '002 【空章】', startIndex: 0, content: '002 【空章】' },
      { id: 'ch-2', title: '003 【风波起】', startIndex: 0, content: '正文三，发生了一些事情。' },
      { id: 'ch-3', title: '004 【杀人越货】', startIndex: 0, content: '正文四，继续往下写。' },
    ]
    const book = {
      id: 'b1', title: '朕', author: '', coverColor: '', coverEmoji: '',
      content: '', chapters, toc: [], addedAt: 0, lastReadAt: 0,
      chapterId: 'ch-2', paragraphIndex: 0, charOffset: 0, progressPercent: 0,
      furthestChapterIndex: 2, readChapterIds: ['ch-0', 'ch-1', 'ch-2'],
      chapterizeTryVersion: 2,
    } as Book
    const r = autoChapterizeIfNeeded(book)
    expect(r).not.toBeNull()
    // 垃圾章被淘汰，剩下的章都有正文
    expect(r!.chapters.some((c) => c.title.includes('空章'))).toBe(false)
    expect(r!.chapters.length).toBeGreaterThanOrEqual(3)
    for (const c of r!.chapters) expect(c.content.trim().length).toBeGreaterThan(0)
    // 进度仍落在原来的「风波起」章
    const cur = r!.chapters.find((c) => c.id === r!.chapterId)
    expect(cur?.title.includes('风波起')).toBe(true)
    expect(r!.chapterizeTryVersion).toBe(4)
    // 重分章后字数统计跟着重算（否则 totalChars 仍是旧值）
    expect(r!.totalChars).toBe(r!.chapters.reduce((s, c) => s + (c.charCount ?? -1), 0))
    expect(r!.totalBillable).toBe(r!.chapters.reduce((s, c) => s + (c.billableChars ?? -1), 0))
    expect(r!.chapters.every((c) => typeof c.charCount === 'number' && c.charCount > 0)).toBe(true)
    expect(r!.charStatsVersion).toBe(CHAR_STATS_VERSION)
    // 中文正文：计费字符必然多于显示字数
    expect(r!.totalBillable!).toBeGreaterThan(r!.totalChars!)
    // v4 结果不会再被重切
    expect(autoChapterizeIfNeeded(r!)).toBeNull()
  })
})

describe('importTextBook（TXT 导入）', () => {
  it('导入当场目录就绑好 chapterId、字数已统计，且不会被重切', () => {
    const txt =
      '引子内容，崇祯元年夏。\n\n' +
      '第一章 甲\n正文一。\n\n' +
      '第二章 乙\n正文二。\n\n' +
      '第三章 丙\n正文三。'
    const id = useAppStore.getState().importTextBook(txt, '测试书.txt')
    const book = useAppStore.getState().getBook(id)
    try {
      expect(book).toBeTruthy()
      expect(book!.chapters.length).toBeGreaterThanOrEqual(4)
      // 坏目录（chapterId=null）会让刚导入的书目录整排「无正文」且无法跳转，
      // 以前靠下次启动的 normalizeBook 才修好，现在必须当场就是好的
      expect(book!.toc.length).toBe(book!.chapters.length)
      expect(book!.toc.every((t) => !!t.chapterId)).toBe(true)
      // 导入即统计：每章有两套口径，全书汇总 = 各章之和
      expect(book!.chapters.every((c) => (c.charCount ?? 0) > 0)).toBe(true)
      expect(book!.chapters.every((c) => (c.billableChars ?? 0) > 0)).toBe(true)
      expect(book!.totalChars).toBe(book!.chapters.reduce((s, c) => s + (c.charCount ?? 0), 0))
      expect(book!.totalBillable).toBe(book!.chapters.reduce((s, c) => s + (c.billableChars ?? 0), 0))
      expect(book!.charStatsVersion).toBe(CHAR_STATS_VERSION)
      // 金额必须由计费字符算：中文书比「按字数算」高出近一倍
      expect(estimateTtsCost(book!.totalBillable!)).toBeGreaterThan(estimateTtsCost(book!.totalChars!) * 1.5)
      // 已是最新切章规则：下次启动不再全文重切（避免字数漂移与白耗水合时间）
      expect(autoChapterizeIfNeeded(book!)).toBeNull()
    } finally {
      useAppStore.getState().removeBook(id)
    }
  })
})

describe('costTracker 双口径记账', () => {
  it('金额由计费字符算，显示字数单独记（只记字数会让花费/预算少一半）', async () => {
    await addSynthChars(1000, 1900, '测试书')
    expect(await getTodayChars()).toBe(1000)
    expect(await getTodayBillable()).toBe(1900)
    expect(await getTodayCostYuan()).toBeCloseTo((1900 / 1_000_000) * 200, 10)
  })
})

describe('audioCache 内存快照（消除“刚合成完就重开本章”的重复合成）', () => {
  const makeClip = (n: number, textHash = 'abc'): ChapterAudio => ({
    chunks: Array.from({ length: n }, (_, i) => ({
      charStart: i,
      charEnd: i + 1,
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }),
    })),
    textHash,
    voiceKey: 'zh|note',
    createdAt: Date.now(),
  })

  it('putClip 后不提交事务也能立即 getClip 拿到（否则已付费的段会被重新合成）', async () => {
    await putClip('snap-a', makeClip(3), undefined, { skipFile: true })
    const got = await getClip('snap-a')
    expect(got?.chunks.length).toBe(3)
    expect(got?.textHash).toBe('abc')
  })

  it('同一 key 后写的快照更新：分段变多后读到的是更全的那份', async () => {
    await putClip('snap-b', makeClip(2), undefined, { skipFile: true })
    await putClip('snap-b', makeClip(5), undefined, { skipFile: true })
    expect((await getClip('snap-b'))?.chunks.length).toBe(5)
  })

  it('内存快照只留最近 3 条（测试环境 IDB 不可用，最老那条就读不到了）', async () => {
    for (const k of ['lru-1', 'lru-2', 'lru-3', 'lru-4']) {
      await putClip(k, makeClip(1), undefined, { skipFile: true })
    }
    expect(await getClip('lru-4')).not.toBeNull()
    expect(await getClip('lru-1')).toBeNull()
  })
})

describe('classifyTtsError', () => {
  it('媒体元素加载失败（Android WebView blob: URL 问题）归类为音频播放失败且可重试', () => {
    const r = classifyTtsError(new Error('The element has no supported sources.'))
    expect(r.title).toBe('音频播放失败')
    expect(r.retryable).toBe(true)
  })
  it('网络错误可重试', () => {
    expect(classifyTtsError(new Error('Failed to fetch')).retryable).toBe(true)
  })
  it('主动停止不重试', () => {
    const r = classifyTtsError(new Error('aborted'))
    expect(r.title).toBe('已停止')
    expect(r.retryable).toBe(false)
  })
})
