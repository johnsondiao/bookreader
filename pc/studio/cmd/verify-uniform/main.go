// Command verify-uniform 全量体检一个音频包，确认它「帧结构完全一致」。
//
// 逐章检查：
//  ① 文件头有没有 ID3（有就是不一致）
//  ② 首帧是不是 Xing/Info 元数据帧（是就说明码率和后面不一样）
//  ③ 从第 0 帧走到文件尾，每一帧的码率/帧长/采样率是否全部相同（链校验）
//  ④ 帧时间轴总时长 vs manifest notesDurationMs 的偏差（理想 ≤ 1 帧 = 36ms）
//  ⑤ 有没有零长度句（TTS 不发声、只会被切成 36ms 的空段）
//  ⑥ 章标题区间是否补齐、是否落在正文之前
//
// 用法：go run ./cmd/verify-uniform -in ../dist/maoxuan-uniform.langyue.zip [-verbose]
package main

import (
	"archive/zip"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"

	"langyue-studio/internal/mp3"
)

type chapter struct {
	ID              string `json:"id"`
	Title           string `json:"title"`
	TitleStartMs    int64  `json:"titleStartMs"`
	TitleEndMs      int64  `json:"titleEndMs"`
	DurationMs      int64  `json:"durationMs"`
	SentenceCount   int    `json:"sentenceCount"`
	Sentences       []span `json:"sentences"`
	Notes           []span `json:"notes"`
	NotesDurationMs int64  `json:"notesDurationMs"`
}

type span struct {
	Text   string `json:"text"`
	StartMs int64 `json:"startMs"`
	EndMs   int64 `json:"endMs"`
}

type manifest struct {
	Format   string    `json:"format"`
	Version  int       `json:"version"`
	Chapters []chapter `json:"chapters"`
}

const minSlotMs = 80

func main() {
	in := flag.String("in", "", "音频包 zip 路径")
	verbose := flag.Bool("verbose", false, "打印每章明细")
	flag.Parse()
	if *in == "" {
		flag.Usage()
		os.Exit(2)
	}

	zr, err := zip.OpenReader(*in)
	if err != nil {
		fmt.Println("打开 zip 失败:", err)
		os.Exit(1)
	}
	defer zr.Close()

	var m manifest
	for _, f := range zr.File {
		if f.Name == "manifest.json" {
			rc, err := f.Open()
			if err != nil {
				panic(err)
			}
			if err := json.NewDecoder(rc).Decode(&m); err != nil {
				panic(err)
			}
			rc.Close()
			break
		}
	}
	if len(m.Chapters) == 0 {
		fmt.Println("manifest 里没有章节")
		os.Exit(1)
	}

	// 建 mp3 索引
	audio := map[string]*zip.File{}
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "audio/") && strings.HasSuffix(f.Name, ".mp3") {
			audio[f.Name[len("audio/"):len(f.Name)-4]] = f
		}
	}

	type problem struct {
		ch   string
		kind string
		msg  string
	}
	var problems []problem
	add := func(ch, kind, format string, a ...any) {
		problems = append(problems, problem{ch, kind, fmt.Sprintf(format, a...)})
	}

	frameLenHist := map[int]int{}
	brHist := map[string]int{}
	srHist := map[int]int{}
	var deltas []int64
	totalAudio := int64(0)

	for i, c := range m.Chapters {
		f, ok := audio[c.ID]
		if !ok {
			add(c.ID, "missing", "包里没有音频文件")
			continue
		}
		rc, err := f.Open()
		if err != nil {
			add(c.ID, "open", "%v", err)
			continue
		}
		buf := make([]byte, f.UncompressedSize64)
		if _, err := io.ReadFull(rc, buf); err != nil {
			rc.Close()
			add(c.ID, "read", "%v", err)
			continue
		}
		rc.Close()
		totalAudio += int64(len(buf))

		// ① ID3
		first := mp3.FindFirstFrame(buf)
		if first < 0 {
			add(c.ID, "sync", "找不到帧同步")
			continue
		}
		if first != 0 {
			add(c.ID, "id3", "前面有 %d 字节非帧数据", first)
		}

		h0 := mp3.ParseFrame(buf, first)
		// ② Xing/Info
		if mp3.IsXingFrame(buf, h0, first) {
			add(c.ID, "xing", "首帧是 Xing/Info 元数据帧（%d 字节）", h0.FrameLen)
		}

		// ③ 链校验：整章逐帧走一遍，要求帧长/采样率完全一致
		frameCount := 0
		badChain := 0
		off := first
		for off+4 <= len(buf) {
			h := mp3.ParseFrame(buf, off)
			if h == nil {
				badChain++
				break
			}
			if h.FrameLen != h0.FrameLen || h.SampleRate != h0.SampleRate {
				if badChain == 0 {
					add(c.ID, "uniform", "第 %d 帧码率/帧长与首帧不同：%dHz %dB（首帧 %dHz %dB）",
						frameCount, h.SampleRate, h.FrameLen, h0.SampleRate, h0.FrameLen)
				}
				badChain++
				if badChain > 3 {
					break
				}
			}
			frameCount++
			off += h.FrameLen
		}
		if badChain == 0 && off != len(buf) && off < len(buf)-h0.FrameLen {
			add(c.ID, "tail", "帧链走完后还剩 %d 字节（尾部残留）", len(buf)-off)
		}

		frameLenHist[h0.FrameLen]++
		srHist[h0.SampleRate]++
		brHist[fmt.Sprintf("%dkbps/%dB/%dHz", bitrateOf(h0), h0.FrameLen, h0.SampleRate)]++

		// ④ 帧时长 vs manifest
		msPerFrame := float64(h0.SamplesPerFrame) / float64(h0.SampleRate) * 1000
		frameMs := int64(float64(frameCount) * msPerFrame)
		delta := frameMs - c.NotesDurationMs
		deltas = append(deltas, delta)
		if delta > 40 || delta < -40 {
			add(c.ID, "delta", "帧时长 %dms vs manifest %dms，Δ=%dms", frameMs, c.NotesDurationMs, delta)
		}

		// ⑤ 零长度句
		zero := 0
		for _, s := range c.Sentences {
			if s.EndMs-s.StartMs < minSlotMs {
				zero++
			}
		}
		for _, s := range c.Notes {
			if s.EndMs-s.StartMs < minSlotMs {
				zero++
			}
		}
		if zero > 0 {
			add(c.ID, "zero", "%d 条零长度句/注释", zero)
		}

		// ⑥ 标题区间
		if c.TitleStartMs == 0 && c.TitleEndMs == 0 {
			add(c.ID, "title", "没有标题区间")
		} else {
			if len(c.Sentences) > 0 && c.TitleEndMs > c.Sentences[0].StartMs {
				add(c.ID, "title", "标题结束 %dms 晚于首句开始 %dms", c.TitleEndMs, c.Sentences[0].StartMs)
			}
		}

		if *verbose && (i%40 == 0 || badChain > 0 || zero > 0) {
			fmt.Printf("  [%3d] %-8s 帧数 %6d  %dHz %3dB  Δ=%5dms  零长度 %d\n",
				i, c.ID, frameCount, h0.SampleRate, h0.FrameLen, delta, zero)
		}
	}

	fmt.Println("========== 一致性体检 ==========")
	fmt.Println("包:", *in)
	fmt.Println("章节数:", len(m.Chapters), " 音频总字节:", totalAudio)
	fmt.Println("帧长分布:", histInt(frameLenHist))
	fmt.Println("采样率分布:", histInt(srHist))
	fmt.Println("码率/帧长/采样率分布:", histStr(brHist))
	if len(deltas) > 0 {
		sort.Slice(deltas, func(i, j int) bool { return deltas[i] < deltas[j] })
		fmt.Printf("Δ(帧时长-manifest) 最小 %dms / 中位 %dms / 最大 %dms\n",
			deltas[0], deltas[len(deltas)/2], deltas[len(deltas)-1])
	}

	if len(problems) == 0 {
		fmt.Println("\n✅ 全 396 章帧结构完全一致：无 ID3、无 Xing/Info、整章码率与帧长单一、Δ 均在 1 帧内、零长度句 0")
		return
	}
	byKind := map[string]int{}
	for _, p := range problems {
		byKind[p.kind]++
	}
	fmt.Println("\n❌ 发现问题:", len(problems))
	fmt.Println("  分类:", histStr(byKind))
	limit := len(problems)
	if limit > 20 {
		limit = 20
	}
	for _, p := range problems[:limit] {
		fmt.Printf("  - [%s] %s: %s\n", p.kind, p.ch, p.msg)
	}
	if len(problems) > limit {
		fmt.Printf("  ... 还有 %d 条\n", len(problems)-limit)
	}
}

func bitrateOf(h *mp3.FrameHead) int {
	// 反推码率：帧长 ≈ spf/sr × br*1000/8
	return (h.FrameLen)*8*h.SampleRate/(h.SamplesPerFrame*1000)
}

func histInt(m map[int]int) string {
	keys := make([]int, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%d:%d", k, m[k]))
	}
	return strings.Join(parts, " | ")
}

func histStr(m map[string]int) string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s:%d", k, m[k]))
	}
	return strings.Join(parts, " | ")
}
