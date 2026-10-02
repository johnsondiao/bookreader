package synth

// PCM → mp3 转码（依赖 ffmpeg，CBR 以保证 seek 精度）。

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"

	"langyue-studio/internal/mp3"
)

// DefaultBitrate 语音 CBR 码率（16k 单声道，语音清晰且体积适中）
const DefaultBitrate = "32k"

// HasFFmpeg 检查 ffmpeg 是否可用
func HasFFmpeg() bool {
	_, err := exec.LookPath("ffmpeg")
	return err == nil
}

// PCMToMP3 把内存中的 PCM 转码为 mp3（CBR）
func PCMToMP3(pcm []byte, mp3Path string, sampleRate int64, bitrate string) error {
	if err := os.MkdirAll(filepath.Dir(mp3Path), 0o755); err != nil {
		return err
	}
	tmp := mp3Path + ".pcm"
	if err := os.WriteFile(tmp, pcm, 0o644); err != nil {
		return err
	}
	defer os.Remove(tmp)
	return PCMFileToMP3(tmp, mp3Path, sampleRate, bitrate)
}

// PCMFileToMP3 把 PCM 文件转码为 mp3（CBR，单声道）。
//
// 导出时做两件保证「文件里第一帧就是正文第一个字」的事：
//   - `-write_xing 0`：不写 Xing/Info 元数据帧（那玩意在真包里是 40kbps/180 字节，
//     是整份文件里唯一波特率跟别人不一样的一帧，而且它不出声）；
//   - 剥掉 EncoderDelayFrames 帧编码器前导延迟（实测 69ms → 2 帧）。
//
// 这样 mp3 的「帧时间轴」和 manifest 的 PCM 时间轴严格重合，播放器按 ms 切句才不会切偏。
func PCMFileToMP3(pcmPath, mp3Path string, sampleRate int64, bitrate string) error {
	if bitrate == "" {
		bitrate = DefaultBitrate
	}
	cmd := exec.Command("ffmpeg", "-y",
		"-f", "s16le",
		"-ar", strconv.FormatInt(sampleRate, 10),
		"-ac", "1",
		"-i", pcmPath,
		"-codec:a", "libmp3lame",
		"-b:a", bitrate,
		"-ac", "1",
		"-write_xing", "0",
		mp3Path,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ffmpeg 转码失败: %w\n%s", err, string(out))
	}
	return NormalizeMP3(mp3Path)
}

// NormalizeMP3 把转码产物标准化：剥掉编码器前导延迟帧（以及可能残留的 Xing 帧）。
func NormalizeMP3(mp3Path string) error {
	b, err := os.ReadFile(mp3Path)
	if err != nil {
		return err
	}
	first := mp3.FindFirstFrame(b)
	if first < 0 {
		return fmt.Errorf("%s: 找不到 mp3 帧同步", mp3Path)
	}
	// 元数据帧（如果有）自己要占一帧，剥前导时一并算进去
	extra := 0
	if h := mp3.ParseFrame(b, first); h != nil && mp3.IsXingFrame(b, h, first) {
		extra = 1
	}
	stripped, err := mp3.StripLeadFrames(b, extra+mp3.EncoderDelayFrames)
	if err != nil {
		return fmt.Errorf("%s: %w", mp3Path, err)
	}
	return os.WriteFile(mp3Path, stripped, 0o644)
}

// WriteWAV 把 PCM 写成带 WAV 头的音频（便于本地试听排查）
func WriteWAV(path string, pcm []byte, sampleRate int) error {
	const bits, ch = 16, 1
	dataLen := len(pcm)
	buf := make([]byte, 44+dataLen)
	copy(buf[0:4], "RIFF")
	putU32(buf[4:8], uint32(36+dataLen))
	copy(buf[8:12], "WAVE")
	copy(buf[12:16], "fmt ")
	putU32(buf[16:20], 16)
	putU16(buf[20:22], 1)
	putU16(buf[22:24], uint16(ch))
	putU32(buf[24:28], uint32(sampleRate))
	putU32(buf[28:32], uint32(sampleRate*ch*bits/8))
	putU16(buf[32:34], uint16(ch*bits/8))
	putU16(buf[34:36], bits)
	copy(buf[36:40], "data")
	putU32(buf[40:44], uint32(dataLen))
	copy(buf[44:], pcm)
	return os.WriteFile(path, buf, 0o644)
}

func putU32(b []byte, v uint32) {
	b[0] = byte(v)
	b[1] = byte(v >> 8)
	b[2] = byte(v >> 16)
	b[3] = byte(v >> 24)
}

func putU16(b []byte, v uint16) {
	b[0] = byte(v)
	b[1] = byte(v >> 8)
}
