// Command patch-titles 给已有音频包补上「章标题朗读」段。
//
// 背景：早期版本合成时章标题只用于显示、不参与朗读，整本书听不到章标题。
// 而正文音频早已全部合成完成（1GB+ 的 zip），为了几百毫秒的标题重跑全书要数小时，
// 本工具因此复用旧包里的全部正文 mp3，只做两件事：
//  1. 用正文音色把每章标题单独合成一段 PCM，前置到该章 mp3 开头（标题后接一段静音）；
//  2. 把该章句子/注释的时间轴整体后移，并写入 titleStartMs/titleEndMs。
//
// 用法：
//
//	go run ./cmd/patch-titles -in ../dist/maoxuan-full.langyue.zip -out ../dist/maoxuan-title.langyue.zip
//
// 注意：只会读旧包，不会修改旧包；失败时该章保持不朗读标题（与旧包行为一致）。
package main

import (
	"archive/zip"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"langyue-studio/internal/pack"
	"langyue-studio/internal/synth"
)

func main() {
	in := flag.String("in", "", "旧音频包 zip（只读）")
	out := flag.String("out", "", "输出音频包 zip")
	envPath := flag.String("env", ".env", "凭据文件（TENCENT_APPID/SECRET_ID/SECRET_KEY）")
	voice := flag.Int64("voice", 101011, "章标题音色（默认正文音色 101011 智燕）")
	rate := flag.Int64("rate", 16000, "采样率")
	speed := flag.Float64("speed", 0, "语速 [-2,6]")
	gap := flag.Int("gap", synth.DefaultGapMs, "标题与正文之间的静音毫秒")
	concurrency := flag.Int("concurrency", 6, "并发路数")
	retries := flag.Int("retries", 3, "标题合成失败重试次数")
	work := flag.String("work", "", "临时工作目录（缺省用系统临时目录）")
	bitrate := flag.String("bitrate", synth.DefaultBitrate, "mp3 CBR 码率")
	flag.Parse()

	if *in == "" || *out == "" {
		fmt.Println("❌ 请用 -in 指定旧音频包、-out 指定输出包")
		os.Exit(1)
	}
	if !synth.HasFFmpeg() {
		fmt.Println("❌ 未检测到 ffmpeg")
		os.Exit(1)
	}

	if *work != "" {
		if err := os.MkdirAll(*work, 0o755); err != nil {
			fmt.Println("❌ 创建工作目录失败：", err)
			os.Exit(1)
		}
	}
	tmp, err := os.MkdirTemp(*work, "patch-titles-*")
	if err != nil {
		fmt.Println("❌ 创建临时目录失败：", err)
		os.Exit(1)
	}
	defer os.RemoveAll(tmp)
	audioDir := filepath.Join(tmp, "audio")
	newDir := filepath.Join(tmp, "new")
	titleDir := filepath.Join(tmp, "title")
	for _, d := range []string{audioDir, newDir, titleDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			fmt.Println("❌ 创建目录失败：", err)
			os.Exit(1)
		}
	}

	// ---- 1. 打开旧包 ----
	zr, err := zip.OpenReader(*in)
	if err != nil {
		fmt.Println("❌ 打开旧包失败：", err)
		os.Exit(1)
	}
	defer zr.Close()

	m := &pack.Manifest{}
	var sourcePath string
	var bookEntry string
	srcEntries := make(map[string]*zip.File)
	for _, f := range zr.File {
		if f.Name == "manifest.json" {
			b, err := readAll(zr, f)
			if err != nil {
				fmt.Println("❌ 读取 manifest 失败：", err)
				os.Exit(1)
			}
			if err := json.Unmarshal(b, m); err != nil {
				fmt.Println("❌ 解析 manifest 失败：", err)
				os.Exit(1)
			}
		} else if len(f.Name) > 6 && f.Name[:6] == "audio/" {
			srcEntries[f.Name] = f
		} else if len(f.Name) > 5 && f.Name[:5] == "book/" {
			sourcePath = filepath.Join(tmp, "source"+filepath.Ext(f.Name))
			bookEntry = f.Name
			srcEntries[f.Name] = f
		}
	}
	if len(m.Chapters) == 0 {
		fmt.Println("❌ manifest 里没有章节，无法补标题")
		os.Exit(1)
	}
	fmt.Printf("📦 旧包：%d 章 / %d 个包内文件\n", len(m.Chapters), len(srcEntries))

	// ---- 2. 抽出旧 mp3（ffmpeg 需要真实文件）----
	needChapters := map[string]bool{}
	for _, ch := range m.Chapters {
		needChapters[ch.ID] = true
	}
	totalBytes := int64(0)
	for name, f := range srcEntries {
		if len(name) < 6 || name[:6] != "audio/" {
			continue
		}
		id := name[6 : len(name)-4] // audio/{id}.mp3
		if !needChapters[id] {
			continue
		}
		dst := filepath.Join(audioDir, id+".mp3")
		if err := extract(zr, f, dst); err != nil {
			fmt.Println("❌ 抽出", name, "失败：", err)
			os.Exit(1)
		}
		totalBytes += int64(f.UncompressedSize64)
	}
	if bookEntry != "" {
		if err := extract(zr, srcEntries[bookEntry], sourcePath); err != nil {
			fmt.Println("⚠️ 抽出源文件失败（不影响标题补丁）：", err)
		}
	}
	fmt.Printf("📤 已抽出 %d 个章节音频（%.2f GB）\n", len(needChapters), float64(totalBytes)/1024/1024/1024)

	// ---- 3. 凭据 ----
	env := loadEnv(*envPath)
	cred := synth.Credential{
		AppID:     envInt(env, "TENCENT_APPID"),
		SecretID:  env["TENCENT_SECRET_ID"],
		SecretKey: env["TENCENT_SECRET_KEY"],
	}
	if cred.AppID == 0 || cred.SecretID == "" || cred.SecretKey == "" {
		fmt.Printf("❌ 凭据缺失（%s）：需要 TENCENT_APPID / TENCENT_SECRET_ID / TENCENT_SECRET_KEY，且必须是主账号密钥\n", *envPath)
		os.Exit(1)
	}

	// ---- 4. 并发合成章标题（前置 PCM + 尾部静音，落盘为 s16le）----
	fmt.Printf("🔊 开始合成 %d 条章标题（并发 %d）\n", len(m.Chapters), *concurrency)
	type titleResult struct {
		id       string
		title    string
		pcmPath  string
		durMs    int64
		hasAudio bool
		err      error
	}
	results := make([]titleResult, len(m.Chapters))
	var wg sync.WaitGroup
	sem := make(chan struct{}, *concurrency)
	for i, ch := range m.Chapters {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, ch pack.ChapterEntry) {
			defer wg.Done()
			defer func() { <-sem }()
			r := titleResult{id: ch.ID, title: ch.Title}
			res, err := synth.SynthBatch(cred, ch.Title,
				synth.Options{VoiceType: *voice, SampleRate: *rate, Speed: *speed},
				60*time.Second)
			if err != nil {
				// 重试（账号并发超限 10002 等瞬时错误）
				for k := 1; k <= *retries; k++ {
					time.Sleep(time.Duration(k) * 800 * time.Millisecond)
					res, err = synth.SynthBatch(cred, ch.Title,
						synth.Options{VoiceType: *voice, SampleRate: *rate, Speed: *speed},
						60*time.Second)
					if err == nil {
						break
					}
				}
			}
			if err != nil {
				r.err = err
				results[i] = r
				fmt.Printf("   ⚠️ %s「%s」标题合成失败，本章保持不朗读标题：%v\n", ch.ID, ch.Title, err)
				return
			}
			if len(res.PCM) == 0 {
				results[i] = r
				fmt.Printf("   ⚠️ %s「%s」无音频返回，本章保持不朗读标题\n", ch.ID, ch.Title)
				return
			}
			r.durMs = synth.PCMDurationMs(res.PCM, *rate)
			pcm := append([]byte{}, res.PCM...)
			pcm = append(pcm, synth.SilencePCM(*gap, *rate)...)
			p := filepath.Join(titleDir, ch.ID+".pcm")
			if err := os.WriteFile(p, pcm, 0o644); err != nil {
				r.err = err
				results[i] = r
				fmt.Println("   ⚠️ 写标题 PCM 失败：", err)
				return
			}
			r.pcmPath = p
			r.hasAudio = true
			results[i] = r
		}(i, ch)
	}
	wg.Wait()
	synthOK := 0
	for _, r := range results {
		if r.hasAudio {
			synthOK++
		}
	}
	fmt.Printf("✅ 标题合成完成：%d/%d 章有标题语音\n", synthOK, len(m.Chapters))

	// ---- 5. 逐章拼接：标题 PCM + 旧正文 mp3 → 新 mp3 ----
	fmt.Printf("🎛️ 开始拼接 %d 个章节音频（并发 %d）\n", len(m.Chapters), *concurrency)
	sem2 := make(chan struct{}, min(4, *concurrency))
	jobs := make(chan int, len(m.Chapters))
	for i := range m.Chapters {
		jobs <- i
	}
	close(jobs)
	var mu sync.Mutex
	var okCount int
	var wg2 sync.WaitGroup
	for i := 0; i < len(m.Chapters); i++ {
		idx, ok := <-jobs
		if !ok {
			break
		}
		wg2.Add(1)
		sem2 <- struct{}{}
		go func(idx int) {
			defer wg2.Done()
			defer func() { <-sem2 }()
			ch := &m.Chapters[idx]
			r := results[idx]
			old := filepath.Join(audioDir, ch.ID+".mp3")
			nv := filepath.Join(newDir, ch.ID+".mp3")
			if !r.hasAudio {
				copyFile(old, nv)
				shiftChapter(ch, 0, 0)
				return
			}
			if err := concatTitle(r.pcmPath, old, nv, *rate, *bitrate); err != nil {
				// 拼接失败则保留旧音频，时间轴不平移（本章不朗读标题）
				copyFile(old, nv)
				shiftChapter(ch, 0, 0)
				fmt.Printf("   ⚠️ %s「%s」拼接失败，本章不朗读标题：%v\n", ch.ID, ch.Title, err)
				return
			}
			// 时间轴：标题 [0, titleDur)，正文/注释整体后移 titleDur + gap
			shiftChapter(ch, r.durMs, r.durMs+int64(*gap))
			mu.Lock()
			okCount++
			mu.Unlock()
			fmt.Printf("   ✅ [%d/%d] %s「%s」标题 %.2fs\n", idx+1, len(m.Chapters), ch.ID, ch.Title, float64(r.durMs)/1000)
		}(idx)
	}
	wg2.Wait()
	fmt.Printf("🎛️ 拼接完成：%d 章已补标题，%d 章保持原样\n", okCount, len(m.Chapters)-okCount)

	// ---- 6. 重算 integrity 并导出新包 ----
	var audioFiles map[string]string
	audioFiles = make(map[string]string, len(m.Chapters))
	for _, ch := range m.Chapters {
		audioFiles[ch.ID] = filepath.Join(newDir, ch.ID+".mp3")
	}
	newTotal := int64(0)
	for _, ch := range m.Chapters {
		fi, err := os.Stat(audioFiles[ch.ID])
		if err == nil {
			newTotal += fi.Size()
		}
	}
	// 清掉「零长度句」：… 、”、〔2〕、）、* * * 这类纯标点/标记被切成了独立句子，
	// TTS 对它们不发声所以 StartMs == EndMs。留着它们播放器会给它切一段，只能
	// 切出 1 帧，播出来是「下一句开头的一小截」+ 一次切段停顿。
	dropped := dropZeroSlots(m)
	fmt.Printf("🧹 清理零长度句：%d 条\n", dropped)

	m.Integrity.TotalBytes = newTotal
	m.Generator = "pc-tts+patch-titles"
	m.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := pack.ExportZip(*out, m, sourcePath, audioFiles); err != nil {
		fmt.Println("❌ 导出新包失败：", err)
		os.Exit(1)
	}
	fi, _ := os.Stat(*out)
	fmt.Printf("🎉 已输出 %s（%.2f GB，%d 章标题已朗读）\n", *out, float64(fi.Size())/1024/1024/1024, synthOK)
}

// shiftChapter 把一章的句子/注释时间轴整体后移，并写入标题区间。
// titleEndMs 为 0 表示「本章不朗读标题」；shift 为正文整体后移量。
func shiftChapter(ch *pack.ChapterEntry, titleEndMs, shift int64) {
	ch.TitleStartMs = 0
	ch.TitleEndMs = titleEndMs
	if shift == 0 {
		if ch.DurationMs == 0 {
			ch.DurationMs = titleEndMs
		}
		return
	}
	for i := range ch.Sentences {
		ch.Sentences[i].StartMs += shift
		ch.Sentences[i].EndMs += shift
		ch.Sentences[i].VoiceStartMs += shift
		ch.Sentences[i].VoiceEndMs += shift
	}
	for i := range ch.Notes {
		ch.Notes[i].StartMs += shift
		ch.Notes[i].EndMs += shift
		ch.Notes[i].VoiceStartMs += shift
		ch.Notes[i].VoiceEndMs += shift
	}
	ch.DurationMs += shift
	ch.NotesDurationMs += shift
}

// concatTitle 用 ffmpeg 把标题 PCM 与整章 mp3 拼成一份新的 CBR mp3。
//
// 标题 PCM 与正文 PCM 拼成**一整条**后再一次性转码，所以标题段和正文段共用
// 同一套编码参数（32kbps / 16kHz / 每帧 36ms），不存在「标题和后面不一样」。
//
// 另外 `-write_xing 0` 不写 Xing/Info 元数据帧、再剥掉编码器前导延迟帧，
// 保证文件里第一帧就是标题的第一个字 —— mp3 的帧时间轴与 manifest 的 PCM
// 时间轴严格重合，播放器按 ms 切句才不会切偏（否则每段都切早约 108ms，
// 段尾就把下一句开头念进上一句）。
func concatTitle(titlePCM, oldMP3, outMP3 string, sampleRate int64, bitrate string) error {
	cmd := exec.Command("ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
		"-f", "s16le", "-ar", fmt.Sprint(sampleRate), "-ac", "1", "-i", titlePCM,
		"-i", oldMP3,
		"-filter_complex", "[0:a][1:a]concat=n=2:v=0:a=1[a]",
		"-map", "[a]",
		"-codec:a", "libmp3lame", "-b:a", bitrate, "-ac", "1", "-ar", fmt.Sprint(sampleRate),
		"-write_xing", "0",
		outMP3,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("ffmpeg: %w\n%s", err, string(out))
	}
	return synth.NormalizeMP3(outMP3)
}

// dropZeroSlots 删掉时长为 0 的句子/注释（纯标点片段），返回删除条数
func dropZeroSlots(m *pack.Manifest) int {
	const minSlotMs = 80
	n := 0
	for ci := range m.Chapters {
		ch := &m.Chapters[ci]
		kept := ch.Sentences[:0]
		for _, s := range ch.Sentences {
			if s.EndMs-s.StartMs < minSlotMs {
				n++
				continue
			}
			kept = append(kept, s)
		}
		ch.Sentences = kept
		ch.SentenceCount = len(kept)
		keptNotes := ch.Notes[:0]
		for _, x := range ch.Notes {
			if x.EndMs-x.StartMs < minSlotMs {
				n++
				continue
			}
			keptNotes = append(keptNotes, x)
		}
		ch.Notes = keptNotes
	}
	return n
}

// ---------------------------------------------------------------- 工具

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func readAll(zr *zip.ReadCloser, f *zip.File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	return io.ReadAll(rc)
}

func extract(zr *zip.ReadCloser, f *zip.File, dst string) error {
	if f == nil {
		return fmt.Errorf("包内文件不存在")
	}
	rc, err := f.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, rc)
	return err
}

func copyFile(src, dst string) {
	b, err := os.ReadFile(src)
	if err != nil {
		return
	}
	_ = os.WriteFile(dst, b, 0o644)
}

func loadEnv(path string) map[string]string {
	out := map[string]string{}
	b, err := os.ReadFile(path)
	if err != nil {
		return out
	}
	for i, line := range splitLines(string(b)) {
		_ = i
		s := trimSpace(line)
		if s == "" || s[0] == '#' {
			continue
		}
		for k := 0; k < len(s); k++ {
			if s[k] == '=' {
				out[trimSpace(s[:k])] = trimSpace(s[k+1:])
				break
			}
		}
	}
	return out
}

func envInt(m map[string]string, k string) int64 {
	v := trimSpace(m[k])
	var n int64
	for i := 0; i < len(v); i++ {
		if v[i] < '0' || v[i] > '9' {
			v = v[:i]
			break
		}
	}
	fmt.Sscanf(v, "%d", &n)
	return n
}

func splitLines(s string) []string {
	var out []string
	cur := ""
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' || s[i] == '\r' {
			out = append(out, cur)
			cur = ""
			continue
		}
		cur += string(s[i])
	}
	out = append(out, cur)
	return out
}

func trimSpace(s string) string {
	i, j := 0, len(s)
	for i < j && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	for j > i && (s[j-1] == ' ' || s[j-1] == '\t' || s[j-1] == '\r') {
		j--
	}
	return s[i:j]
}
