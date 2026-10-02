/**
 * 核心纯函数单元测试（vitest 风格）。
 *
 * 覆盖：
 *  - chapterParser: isSentenceEnd / splitSentences / splitParagraphs / isNoteParagraph / parseChapters
 *  - audioPackage: parseAudioManifest（音频包 manifest 校验与规整）
 *
 * 运行：npm test / npx vitest run tests/core.test.ts
 */
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { isSentenceEnd, splitSentences, splitParagraphs, isNoteParagraph, parseChapters } from '../src/utils/chapterParser'
import {
  parseAudioManifest,
  openAudioPackage,
  parseAudioPackage,
  formatBytes,
  AUDIO_PACKAGE_FORMAT,
  AUDIO_PACKAGE_VERSION,
  type ImportProgress,
} from '../src/utils/audioPackage'
import { activeSlotIndex, buildSegments } from '../src/utils/audioPlayer'

describe('isSentenceEnd', () => {
  it('中文标点', () => {
    for (const ch of ['。', '！', '？', '；', '…', '\n']) expect(isSentenceEnd(ch)).toBe(true)
  })
  it('英文标点', () => {
    for (const ch of ['.', '!', '?', ';']) expect(isSentenceEnd(ch)).toBe(true)
  })
  it('非句末字符', () => {
    for (const ch of ['，', '、', '：', 'a', '1', '中', ' ']) expect(isSentenceEnd(ch)).toBe(false)
  })
})

describe('splitSentences', () => {
  it('空输入', () => expect(splitSentences('')).toEqual([]))
  it('中文简单句', () =>
    expect(splitSentences('你好。我是小明。')).toEqual(['你好。', '我是小明。']))
  it('末尾残句', () => expect(splitSentences('第一句。第二句未完')).toEqual(['第一句。', '第二句未完']))
  it('换行断句', () => expect(splitSentences('line1\nline2')).toEqual(['line1\n', 'line2']))
})

describe('isNoteParagraph', () => {
  it('注释标题行', () => expect(isNoteParagraph('注释', undefined)).toBe('note'))
  it('星号前缀', () => expect(isNoteParagraph('* 见原注……', undefined)).toBe('note'))
  it('方括号编号', () => expect(isNoteParagraph('〔1〕湖南是当时全国农民运动的中心。', undefined)).toBe('note'))
  it('数字编号', () => expect(isNoteParagraph('1、在华北……', undefined)).toBe('note'))
  it('普通正文', () => expect(isNoteParagraph('农民运动的兴起是一个极大的问题。', undefined)).toBe('text'))
})

describe('splitParagraphs', () => {
  it('按换行拆分并带类型', () => {
    const paras = splitParagraphs('正文一段。\n注释\n* 注一\n* 注二')
    const kinds = paras.map((p) => p.kind)
    expect(kinds[0]).toBe('text')
    expect(kinds[1]).toBe('note')
    expect(kinds[2]).toBe('note')
  })
})

describe('parseChapters', () => {
  it('章节数不足 3 视为无明显结构', () => {
    const chs = parseChapters('只有一段内容。\n没有明显章节。')
    expect(chs.length).toBe(1)
    expect(chs[0].title).toBe('正文')
  })
})

describe('parseAudioManifest', () => {
  it('非法 format 抛错', () => {
    expect(() => parseAudioManifest({ format: 'xxx', version: 1, book: { title: 't' }, chapters: [] })).toThrow()
  })
  it('版本不匹配抛错', () => {
    expect(() => parseAudioManifest({ format: AUDIO_PACKAGE_FORMAT, version: 99, book: { title: 't' }, chapters: [] })).toThrow()
  })
  it('缺书名抛错', () => {
    expect(() => parseAudioManifest({ format: AUDIO_PACKAGE_FORMAT, version: AUDIO_PACKAGE_VERSION, chapters: [] })).toThrow()
  })
  it('合法 manifest 规整句子与注释', () => {
    const m = parseAudioManifest({
      format: AUDIO_PACKAGE_FORMAT,
      version: AUDIO_PACKAGE_VERSION,
      book: { id: 'b-1', title: '测试书', sourceFile: 'book/source.epub', sourceFormat: 'epub' },
      package: { mode: 'full', chapterIds: ['ch-0'], sourceChapterCount: 1 },
      chapters: [
        {
          id: 'ch-0',
          title: '第一章',
          durationMs: 3000,
          sentenceCount: 1,
          sentences: [{ index: 0, text: '你好①。', kind: 'text', startMs: 0, endMs: 1500, voiceStartMs: 100, voiceEndMs: 1300, noteRef: ['n0'] }],
          notes: [{ id: 'n0', index: 0, text: '① 注释', kind: 'note', startMs: 1600, endMs: 3000, voiceStartMs: 1600, voiceEndMs: 2900 }],
          notesDurationMs: 3000,
        },
      ],
    })
    expect(m.book.title).toBe('测试书')
    expect(m.chapters).toHaveLength(1)
    expect(m.chapters[0].sentences[0].noteRef).toEqual(['n0'])
    expect(m.chapters[0].notes[0].id).toBe('n0')
  })

  it('透传章标题朗读区间，旧包缺省为 0', () => {
    const base = {
      format: AUDIO_PACKAGE_FORMAT,
      version: AUDIO_PACKAGE_VERSION,
      book: { id: 'b-1', title: '测试书', sourceFile: 'book/source.epub', sourceFormat: 'epub' as const },
      package: { mode: 'full' as const, chapterIds: ['ch-0'], sourceChapterCount: 1 },
    }
    const withTitle = parseAudioManifest({
      ...base,
      chapters: [{ id: 'ch-0', title: '湖南农民运动考察报告', titleStartMs: 0, titleEndMs: 1600, durationMs: 5000, sentences: [], notes: [] }],
    })
    expect(withTitle.chapters[0].titleStartMs).toBe(0)
    expect(withTitle.chapters[0].titleEndMs).toBe(1600)

    const legacy = parseAudioManifest({
      ...base,
      chapters: [{ id: 'ch-0', title: '湖南农民运动考察报告', durationMs: 5000, sentences: [], notes: [] }],
    })
    expect(legacy.chapters[0].titleStartMs).toBe(0)
    expect(legacy.chapters[0].titleEndMs).toBe(0)
  })
})

// ─────────────────────── 章标题朗读段（audioPlayer） ───────────────────────

describe('buildSegments 标题段', () => {
  const chapter = {
    id: 'ch-0',
    title: '湖南农民运动考察报告',
    titleStartMs: 0,
    titleEndMs: 1600,
    durationMs: 9000,
    sentenceCount: 2,
    // 正文整体排在标题之后（与 PC 端合成结果一致）
    sentences: [
      { index: 0, text: '甲。', kind: 'text' as const, startMs: 3150, endMs: 6000, voiceStartMs: 3200, voiceEndMs: 5900 },
      { index: 1, text: '乙。', kind: 'text' as const, startMs: 6000, endMs: 9000, voiceStartMs: 6050, voiceEndMs: 8800 },
    ],
    notes: [],
    notesDurationMs: 9000,
  }

  it('章首先插标题段，正文段整体后移', () => {
    const segs = buildSegments(chapter, true)
    expect(segs).toHaveLength(3)
    expect(segs[0]).toMatchObject({ kind: 'title', start: 0, end: 1600, index: -1 })
    expect(segs[1]).toMatchObject({ kind: 'body', start: 3150, sentenceIndex: 0 })
    expect(segs[2]).toMatchObject({ kind: 'body', start: 6000, sentenceIndex: 1 })
  })

  it('旧包（无标题区间）不插标题段', () => {
    const legacy = { ...chapter, titleStartMs: undefined, titleEndMs: undefined }
    const segs = buildSegments(legacy, true)
    expect(segs[0]).toMatchObject({ kind: 'body', start: 3150 })
  })

  it('从中间某句起播时跳过标题（不重复念）', () => {
    const segs = buildSegments(chapter, false)
    expect(segs[0]).toMatchObject({ kind: 'body', start: 3150 })
  })
})

// ───────────────── 整章顺序播放：时间轴推导高亮（进度途中零 seek） ─────────────────

describe('activeSlotIndex 位置推导', () => {
  const chapter = {
    id: 'ch-0',
    title: '章标题',
    titleStartMs: 0,
    titleEndMs: 1600,
    durationMs: 9000,
    sentenceCount: 2,
    sentences: [
      { index: 0, text: '甲。', kind: 'text' as const, startMs: 3150, endMs: 6000, voiceStartMs: 3200, voiceEndMs: 5900 },
      { index: 1, text: '乙。', kind: 'text' as const, startMs: 6000, endMs: 9000, voiceStartMs: 6050, voiceEndMs: 8800 },
    ],
    notes: [{ id: 'n0', index: 0, kind: 'note' as const, text: '注', startMs: 12000, endMs: 14000 }],
    notesDurationMs: 14000,
  }
  const segs = buildSegments(chapter, true)

  it('章标题区间 → 高亮标题', () => {
    expect(activeSlotIndex(segs, 0)).toBe(0)
    expect(activeSlotIndex(segs, 1599)).toBe(0)
  })
  it('标题与正文的静音空档不吃掉高亮（停在上一句标题）', () => {
    expect(activeSlotIndex(segs, 2000)).toBe(0)
    expect(activeSlotIndex(segs, 3000)).toBe(0)
  })
  it('正文按区间落到对应句', () => {
    expect(activeSlotIndex(segs, 3150)).toBe(1)
    expect(activeSlotIndex(segs, 5999)).toBe(1)
    expect(activeSlotIndex(segs, 6000)).toBe(2)
    expect(activeSlotIndex(segs, 8999)).toBe(2)
  })
  it('注释排在正文之后，播到注释区才高亮注释', () => {
    expect(segs[3]).toMatchObject({ kind: 'note', start: 12000 })
    expect(activeSlotIndex(segs, 11000)).toBe(2) // 仍在正文第 2 句
    expect(activeSlotIndex(segs, 12000)).toBe(3)
    expect(activeSlotIndex(segs, 13999)).toBe(3)
  })
  it('越过章尾仍停在最后一个槽位（高亮不闪断，收尾交给 tick 的 end+500 判定）', () => {
    expect(activeSlotIndex(segs, 999999)).toBe(3)
    expect(activeSlotIndex(segs, -1)).toBe(-1)
  })

  it('时间轴严格按时间升序（保证顺序播放不跳转）', () => {
    const starts = segs.map((s) => s.start)
    expect(starts).toEqual([...starts].sort((a, b) => a - b))
    expect(starts).toEqual([0, 3150, 6000, 12000])
  })
})

// ─────────────────────── 音频包流式解析（openAudioPackage） ───────────────────────

const PACKAGE_MANIFEST = {
  format: AUDIO_PACKAGE_FORMAT,
  version: AUDIO_PACKAGE_VERSION,
  book: { id: 'b-test', title: '测试书', sourceFile: 'book/source.txt', sourceFormat: 'txt' as const },
  package: { mode: 'full' as const, chapterIds: ['ch-0', 'ch-1'], sourceChapterCount: 2 },
  chapters: [
    {
      id: 'ch-0',
      title: '第一章',
      durationMs: 1000,
      sentenceCount: 1,
      sentences: [{ index: 0, text: '甲。', kind: 'text' as const, startMs: 0, endMs: 1000 }],
      notes: [],
      notesDurationMs: 1000,
    },
    {
      id: 'ch-1',
      title: '第二章',
      durationMs: 1000,
      sentenceCount: 1,
      sentences: [{ index: 0, text: '乙。', kind: 'text' as const, startMs: 0, endMs: 1000 }],
      notes: [],
      notesDurationMs: 1000,
    },
  ],
}

async function makePackageZip(compression: 'DEFLATE' | 'STORE' = 'DEFLATE'): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file('manifest.json', JSON.stringify(PACKAGE_MANIFEST))
  zip.file('book/source.txt', '原始文本')
  zip.file('audio/ch-0.mp3', new Uint8Array([1, 2, 3, 4]))
  zip.file('audio/ch-1.mp3', new Uint8Array([5, 6]))
  return await zip.generateAsync({ type: 'arraybuffer', compression })
}

describe('openAudioPackage', () => {
  it('只解析目录与 manifest，章节按需读取', async () => {
    const opened = await openAudioPackage(await makePackageZip())
    expect(opened.manifest.book.title).toBe('测试书')
    expect([...opened.audioChapterIds].sort()).toEqual(['ch-0', 'ch-1'])
    expect(opened.source).toEqual({ name: 'book/source.txt', ext: 'txt' })
    expect([...(await opened.readChapter('ch-0'))!]).toEqual([1, 2, 3, 4])
    expect([...(await opened.readChapter('ch-1'))!]).toEqual([5, 6])
    expect(await opened.readChapter('ch-missing')).toBeNull()
    const src = await opened.readSource()
    expect(new TextDecoder().decode(src!)).toBe('原始文本')
  })

  it('缺 manifest.json 时抛出可读错误', async () => {
    const zip = new JSZip()
    zip.file('audio/ch-0.mp3', new Uint8Array([1]))
    const buf = await zip.generateAsync({ type: 'arraybuffer' })
    await expect(openAudioPackage(buf)).rejects.toThrow(/manifest\.json/)
  })

  it('parseAudioPackage 兼容包装仍能全量取回', async () => {
    const pkg = await parseAudioPackage(await makePackageZip())
    expect(pkg.audio.size).toBe(2)
    expect(pkg.source?.ext).toBe('txt')
    expect(pkg.manifest.chapters).toHaveLength(2)
  })

  it('逐章上报导入进度', async () => {
    const events: ImportProgress[] = []
    await parseAudioPackage(await makePackageZip(), (p) => events.push(p))
    expect(events.some((e) => e.phase === 'manifest')).toBe(true)
    const unzip = events.filter((e) => e.phase === 'unzip')
    expect(unzip.map((e) => e.current)).toEqual([1, 2])
    expect(unzip.every((e) => e.total === 2)).toBe(true)
  })

  it('STORE（不压缩）条目也能正确读取', async () => {
    const opened = await openAudioPackage(await makePackageZip('STORE'))
    expect([...(await opened.readChapter('ch-0'))!]).toEqual([1, 2, 3, 4])
    expect(new TextDecoder().decode((await opened.readSource())!)).toBe('原始文本')
    await opened.close()
  })
})

describe('formatBytes', () => {
  it('按量级给出可读单位', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.0 MB')
    expect(formatBytes(Math.round(1024 ** 3 * 1.2))).toBe('1.20 GB')
  })
})
