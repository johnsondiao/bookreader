// Package mp3 提供 CBR mp3 的帧级处理（供合成端与打包工具共用）。
//
// 背景：ffmpeg/libmp3lame 转码出来的 mp3 开头有两样「不含正文声音」的东西：
//
//  ① Xing/Info 元数据帧：ffmpeg 默认会写，占满一帧却只装表头。真包实测它用
//     40kbps / 180 字节，而后面十万余帧都是 32kbps / 144 字节 —— 文件里唯一
//     「波特率不一样」的地方就是它。转码加 `-write_xing 0` 可以彻底不写。
//
//  ② 编码器前导延迟（encoder delay）：LAME 固定会往音频前面垫一段静音。
//     实测（生成 1s 静音 + 脉冲的 PCM 转码再解码）是 69.1ms ≈ 2 帧。
//
// 这两样加起来约 108ms，会让「帧时间轴」比 manifest 的 PCM 时间轴早那么多，
// 播放器切句时每段都切早，段尾就把下一句的开头念进上一句里去了。
// 所以合成端导出 mp3 时要：不写 Xing + 剥掉前导帧，让文件里的第一帧就是正文第一个字。
package mp3

import "fmt"

// MPEG 码率 / 采样率表
var (
	bitrateV1 = []int{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0}
	bitrateV2 = []int{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0}
	sampleV1  = []int{44100, 48000, 32000, 0}
	sampleV2  = []int{22050, 24000, 16000, 0}
	sampleV25 = []int{11025, 12000, 8000, 0}
)

// FrameHead 一个 MPEG Layer III 帧头解出来的信息
type FrameHead struct {
	FrameLen        int // 本帧字节数（含 padding 位）
	SampleRate      int
	SamplesPerFrame int // MPEG1 Layer III = 1152，MPEG2/2.5 = 576
}

// ParseFrame 解析 off 处的帧头；不在帧同步上返回 nil
func ParseFrame(b []byte, off int) *FrameHead {
	if off < 0 || off+4 > len(b) {
		return nil
	}
	if b[off] != 0xff || b[off+1]&0xe0 != 0xe0 {
		return nil
	}
	versionBits := (b[off+1] >> 3) & 3
	layerBits := (b[off+1] >> 1) & 3
	if layerBits != 1 { // 只认 Layer III
		return nil
	}
	bitIdx := (b[off+2] >> 4) & 0xf
	srIdx := (b[off+2] >> 2) & 3
	padding := int((b[off+2] >> 1) & 1)
	if bitIdx == 0 || bitIdx == 15 || srIdx == 3 {
		return nil
	}
	mpeg1 := versionBits == 3
	br, sr := bitrateV2[bitIdx], sampleV25[srIdx]
	if mpeg1 {
		br, sr = bitrateV1[bitIdx], sampleV1[srIdx]
	} else if versionBits == 2 {
		sr = sampleV2[srIdx]
	}
	if br == 0 || sr == 0 {
		return nil
	}
	spf := 576
	if mpeg1 {
		spf = 1152
	}
	// 帧长（字节）= 帧时长(s) × 码率(字节/s) = (spf/sr) × (br*1000/8)。
	// 注意先乘后除：spf/sr 用整数除法会先归零（576/16000 = 0）。
	fl := spf*br*1000/(8*sr) + padding
	if fl < 24 {
		return nil
	}
	return &FrameHead{FrameLen: fl, SampleRate: sr, SamplesPerFrame: spf}
}

// FindFirstFrame 跳过 ID3v2 后定位第一个帧同步点；找不到返回 -1
func FindFirstFrame(b []byte) int {
	off := 0
	if len(b) > 10 && string(b[0:3]) == "ID3" {
		size := int(b[6]&0x7f)<<21 | int(b[7]&0x7f)<<14 | int(b[8]&0x7f)<<7 | int(b[9]&0x7f)
		off = 10 + size
	}
	for i := off; i+4 <= len(b) && i < off+8192; i++ {
		if ParseFrame(b, i) != nil {
			return i
		}
	}
	return -1
}

// IsXingFrame 首帧是不是 Xing/Info 元数据帧（帧里带 "Xing"/"Info" 字样）
func IsXingFrame(b []byte, head *FrameHead, off int) bool {
	end := off + head.FrameLen
	if end > len(b) {
		end = len(b)
	}
	if end-off > 64 {
		end = off + 64
	}
	for i := off; i+4 <= end; i++ {
		tag := string(b[i : i+4])
		if tag == "Xing" || tag == "Info" {
			return true
		}
	}
	return false
}

// StripLeadFrames 剥掉开头 frames 个音频帧（连同 ID3 与 Xing 元数据帧一起去掉），
// 返回纯音频帧。frames 通常取 EncoderDelayFrames。
func StripLeadFrames(b []byte, frames int) ([]byte, error) {
	first := FindFirstFrame(b)
	if first < 0 {
		return nil, fmt.Errorf("找不到 mp3 帧同步")
	}
	h0 := ParseFrame(b, first)
	second := first + h0.FrameLen
	h1 := ParseFrame(b, second)
	if h1 == nil {
		return nil, fmt.Errorf("第二个帧解析失败")
	}
	start := second + frames*h1.FrameLen
	if start+2 > len(b) || b[start] != 0xff || b[start+1]&0xe0 != 0xe0 {
		return nil, fmt.Errorf("剥 %d 帧后没落在帧同步上（偏移 %d）", frames, start)
	}
	return b[start:], nil
}

// EncoderDelayFrames 编码器前导延迟帧数。
// 标定方法：造一段「1s 静音 + 10ms 脉冲」的 PCM，转码再解码，看脉冲推迟了多少。
// 实测 ffmpeg/libmp3lame（32kbps / 16kHz / MPEG2 Layer III）= 69.1ms ≈ 2 帧。
const EncoderDelayFrames = 2
