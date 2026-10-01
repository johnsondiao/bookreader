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
import { isSentenceEnd, splitSentences, splitParagraphs, isNoteParagraph, parseChapters } from '../src/utils/chapterParser'
import { parseAudioManifest, AUDIO_PACKAGE_FORMAT, AUDIO_PACKAGE_VERSION } from '../src/utils/audioPackage'

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
})
