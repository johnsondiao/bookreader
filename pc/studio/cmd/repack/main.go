// Command repack 把已有的音频包「重打一遍」，产出一个帧结构完全一致的干净包。
//
// 做两件事（都不需要重新调 TTS，纯字节级 / manifest 级处理）：
//
//  ① 剥掉每章 mp3 的前导：
//     - 首帧是 ffmpeg 写的 Xing/Info 元数据帧（真包实测 180 字节 / 40kbps，
//       后面十万余帧才是 144 字节 / 32kbps），它占满一帧却不含声音；
//     - 再后面是 LAME/ffmpeg 的编码器前导延迟（2 帧）。
//     这两样加起来让「帧时间轴」比 manifest 的 PCM 时间轴早约 108ms，
//     播放器切句时每一段都会切早，段尾就把下一句的开头带进来念了。
//
//  ② 删掉 manifest 里的「零长度句」：… 、”、〔2〕、）、* * * 这类纯标点/标记
//     片段被当成了句子，TTS 对它们不发声所以 startMs == endMs。给它们切段
//     只能切出 1 帧，播出来是「下一句开头的一小截」+ 一次切段停顿。
//
// 用法：
//
//	go run ./cmd/repack -in 旧.zip -out 新.zip [-delay-frames 2]
package main

import (
	"archive/zip"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
)

// MPEG 帧头解析
var (
	bitrateV1 = []int{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0}
	bitrateV2 = []int{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0}
	srV1      = []int{44100, 48000, 32000, 0}
	srV2      = []int{22050, 24000, 16000, 0}
	srV25     = []int{11025, 12000, 8000, 0}
)

type frameHead struct {
	frameLen        int
	sampleRate      int
	samplesPerFrame int
}

func parseFrame(b []byte, off int) (*frameHead, bool) {
	if off+4 > len(b) {
		return nil, false
	}
	if b[off] != 0xff || b[off+1]&0xe0 != 0xe0 {
		return nil, false
	}
	vb := (b[off+1] >> 3) & 3
	lb := (b[off+1] >> 1) & 3
	if lb != 1 { // 只认 Layer III
		return nil, false
	}
	bi := (b[off+2] >> 4) & 0xf
	si := (b[off+2] >> 2) & 3
	padding := (b[off+2] >> 1) & 1
	if bi == 0 || bi == 15 || si == 3 {
		return nil, false
	}
	mpeg1 := vb == 3
	br := bitrateV2[bi]
	sr := srV25[si]
	if mpeg1 {
		br, sr = bitrateV1[bi], srV1[si]
	} else if vb == 2 {
		sr = srV2[si]
	}
	if br == 0 || sr == 0 {
		return nil, false
	}
	spf := 576
	if mpeg1 {
		spf = 1152
	}
	fl := spf*br*1000/(8*sr) + int(padding)
	if fl < 24 {
		return nil, false
	}
	return &frameHead{frameLen: fl, sampleRate: sr, samplesPerFrame: spf}, true
}

/** 剥掉 ID3 + 首帧(元数据帧) + delayFrames 帧编码器前导，返回纯音频帧 */
func stripLead(b []byte, delayFrames int) ([]byte, error) {
	off := 0
	if len(b) > 10 && string(b[0:3]) == "ID3" {
		size := int(b[6]&0x7f)<<21 | int(b[7]&0x7f)<<14 | int(b[8]&0x7f)<<7 | int(b[9]&0x7f)
		off = 10 + size
	}
	// 找第一个帧
	first := -1
	for i := off; i+4 <= len(b) && i < off+4096; i++ {
		if _, ok := parseFrame(b, i); ok {
			first = i
			break
		}
	}
	if first < 0 {
		return nil, fmt.Errorf("找不到 mp3 帧同步")
	}
	f0, _ := parseFrame(b, first)
	second := first + f0.frameLen
	f1, ok := parseFrame(b, second)
	if !ok {
		return nil, fmt.Errorf("第二帧解析失败")
	}
	start := second + delayFrames*f1.frameLen
	if start+2 > len(b) || b[start] != 0xff || b[start+1]&0xe0 != 0xe0 {
		return nil, fmt.Errorf("剥 %d 帧后没落在帧同步上（偏移 %d）", delayFrames+1, start)
	}
	return b[start:], nil
}

const minSlotMs = 80

func main() {
	in := flag.String("in", "", "输入音频包 zip")
	out := flag.String("out", "", "输出的干净包 zip")
	delayFrames := flag.Int("delay-frames", 2, "编码器前导延迟帧数（实测 ffmpeg/libmp3lame 为 2）")
	flag.Parse()
	if *in == "" || *out == "" {
		flag.Usage()
		os.Exit(2)
	}

	zr, err := zip.OpenReader(*in)
	if err != nil {
		panic(err)
	}
	defer zr.Close()

	tmp := *out + ".tmp"
	of, err := os.Create(tmp)
	if err != nil {
		panic(err)
	}
	zw := zip.NewWriter(of)

	stat := struct {
		chapters, stripped, zeroSents, zeroNotes, copied int
	}{}

	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			panic(err)
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			panic(err)
		}
		name := f.Name
		switch {
		case name == "manifest.json":
			var m map[string]any
			if err := json.Unmarshal(data, &m); err != nil {
				panic(err)
			}
			if chs, ok := m["chapters"].([]any); ok {
				for _, c := range chs {
					ch, ok := c.(map[string]any)
					if !ok {
						continue
					}
					stat.chapters++
					keep := func(list []any) []any {
						out := make([]any, 0, len(list))
						for _, it := range list {
							itm, ok := it.(map[string]any)
							if !ok {
								out = append(out, it)
								continue
							}
							s, _ := num(itm["startMs"])
							e, _ := num(itm["endMs"])
							if e-s < minSlotMs {
								continue
							}
							out = append(out, it)
						}
						return out
					}
					if ss, ok := ch["sentences"].([]any); ok {
						before := len(ss)
						kept := keep(ss)
						stat.zeroSents += before - len(kept)
						ch["sentences"] = kept
						ch["sentenceCount"] = len(kept)
					}
					if ns, ok := ch["notes"].([]any); ok {
						before := len(ns)
						kept := keep(ns)
						stat.zeroNotes += before - len(kept)
						ch["notes"] = kept
					}
				}
			}
			data, err = json.Marshal(m)
			if err != nil {
				panic(err)
			}
		case strings.HasPrefix(name, "audio/") && strings.HasSuffix(name, ".mp3"):
			stripped, err := stripLead(data, *delayFrames)
			if err != nil {
				fmt.Printf("  ! %s 跳过：%v\n", path.Base(name), err)
			} else {
				data = stripped
				stat.stripped++
			}
		default:
			stat.copied++
		}
		w, err := zw.Create(name)
		if err != nil {
			panic(err)
		}
		if _, err := w.Write(data); err != nil {
			panic(err)
		}
	}
	if err := zw.Close(); err != nil {
		panic(err)
	}
	of.Close()
	if err := os.Rename(tmp, *out); err != nil {
		panic(err)
	}
	fmt.Printf("完成：%s\n", *out)
	fmt.Printf("  章 %d 个，剥前导 %d 个，删掉零长度句 %d 条 / 注释 %d 条，原样复制 %d 个文件\n",
		stat.chapters, stat.stripped, stat.zeroSents, stat.zeroNotes, stat.copied)
}

func num(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}
