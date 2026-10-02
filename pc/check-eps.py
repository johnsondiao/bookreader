#!/usr/bin/env python3
"""模拟手机端「按句切字节」播放，量出句边界的时间偏移 ε。

做法：
  1. 从音频包里取出某章 mp3 + manifest
  2. 整章解码成 PCM（参考）
  3. 按手机端 chapterChunks.ts 的算法算每句的 [byteStart, byteEnd)
  4. 把每句的字节切片单独解码成 PCM
  5. 把切片解码结果与参考 PCM 在 [startMs, endMs) 附近做互相关，最佳位移就是 ε

ε < 0 = 切早了（会把下一句开头念进上一句，正是用户听到的毛病）
ε ≈ 0 = 边界精确
"""
import json, os, subprocess, sys, zipfile
import numpy as np

SR = 16000
MS_PER_FRAME_DEFAULT = 36.0


def read_pcm(path):
    n = os.path.getsize(path) // 2
    return np.fromfile(path, dtype='<i2', count=n).astype(np.float64)


def decode(mp3_bytes, out_path):
    with open(out_path + '.mp3', 'wb') as f:
        f.write(mp3_bytes)
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', out_path + '.mp3',
                    '-ar', str(SR), '-ac', '1', '-f', 's16le', out_path], check=True)
    return read_pcm(out_path)


def envelope(x, win_ms=10):
    w = int(win_ms * SR / 1000)
    n = len(x) // w
    if n < 4:
        return None
    e = np.sqrt((x[:n * w].reshape(n, w) ** 2).mean(axis=1))
    return e


def xcorr_offset(chunk, ref, max_shift_ms=400):
    """用 10ms 能量包络做互相关，返回 chunk 相对 ref 起点的位移（ms，负=切早了）"""
    a = envelope(chunk)
    b = envelope(ref)
    if a is None or b is None or len(b) < len(a) + 8:
        return 0.0, 0.0
    a = a - a.mean()
    max_shift = int(max_shift_ms / 10)
    best, best_v = 0, -1e30
    for s in range(0, max_shift + 1):
        r = b[s:s + len(a)]
        r = r - r.mean()
        v = float(np.dot(a, r) / (np.linalg.norm(a) * np.linalg.norm(r) + 1e-9))
        if v > best_v:
            best_v, best = v, s
    return best * 10.0, best_v


BR_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
BR_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]


def parse(mp3_bytes, off):
    """复刻 mp3.FrameHead：返回 (frameLen, spf, sr)"""
    if off + 4 > len(mp3_bytes):
        return None
    b = mp3_bytes
    if b[off] != 0xff or (b[off + 1] & 0xe0) != 0xe0:
        return None
    ver = (b[off + 1] >> 3) & 3
    layer = (b[off + 1] >> 1) & 3
    if layer != 1:
        return None
    bit = (b[off + 2] >> 4) & 0xf
    sr_i = (b[off + 2] >> 2) & 3
    pad = (b[off + 2] >> 1) & 1
    if bit in (0, 15) or sr_i == 3:
        return None
    if ver == 3:
        sr = [44100, 48000, 32000][sr_i]; spf = 1152; br = BR_V1[bit]
    elif ver == 2:
        sr = [22050, 24000, 16000][sr_i]; spf = 576; br = BR_V2[bit]
    else:
        sr = [11025, 12000, 8000][sr_i]; spf = 576; br = BR_V2[bit]
    if br == 0 or sr == 0:
        return None
    fl = spf * br * 1000 // (8 * sr) + pad
    if fl < 24:
        return None
    return fl, spf, sr


def is_xing(mp3_bytes, off, fl):
    end = min(off + fl, len(mp3_bytes), off + 64)
    return b'Xing' in mp3_bytes[off:end] or b'Info' in mp3_bytes[off:end]


def find_first_frame(mp3_bytes):
    off = 0
    if len(mp3_bytes) > 10 and mp3_bytes[0:3] == b'ID3':
        size = ((mp3_bytes[6] & 0x7f) << 21 | (mp3_bytes[7] & 0x7f) << 14 |
                (mp3_bytes[8] & 0x7f) << 7 | (mp3_bytes[9] & 0x7f))
        off = 10 + size
    for i in range(off, min(len(mp3_bytes) - 4, off + 8192)):
        if parse(mp3_bytes, i):
            return i
    return -1


def build_geometry(mp3_bytes):
    """复刻 chapterChunks.ts buildChapterGeometry + byteAtMs（含 leadMs 补偿）"""
    first = find_first_frame(mp3_bytes)
    if first < 0:
        return None
    fl0, spf, sr = parse(mp3_bytes, first)
    ms_per_frame = spf / sr * 1000
    # 链校验：从第二帧起用等距步长走到底
    second = first + fl0
    rest = None
    for cand in sorted({144, 180, fl0, 160, 208, 120, 96, 72, 216, 192, 240}):
        off, n = second, 0
        ok = True
        while off + 4 <= len(mp3_bytes):
            p = parse(mp3_bytes, off)
            if p is None:
                ok = False
                break
            off += cand
            n += 1
        if ok and abs(off - len(mp3_bytes)) <= cand:
            rest = cand
            break
    if rest is None:
        return None
    xing = is_xing(mp3_bytes, first, fl0)
    lead_ms = 3 * ms_per_frame if xing else 0.0
    total = 1 + (len(mp3_bytes) - second) // rest
    return dict(first=first, firstLen=fl0, frameLen=rest, spf=spf, sr=sr,
                msPerFrame=ms_per_frame, count=total, xing=xing, leadMs=lead_ms)


def main():
    pkg = sys.argv[1]
    ids = sys.argv[2].split(',')
    z = zipfile.ZipFile(pkg)
    man = json.loads(z.read('manifest.json'))
    tmp = 'pc/tmp-eps'
    os.makedirs(tmp, exist_ok=True)
    for cid in ids:
        ch = next((c for c in man['chapters'] if c['id'] == cid), None)
        if ch is None:
            print(f'{cid}: 不在包里')
            continue
        raw = z.read(f'audio/{cid}.mp3')
        geo = build_geometry(raw)
        if geo is None:
            print(f'{cid}: 解不出帧结构')
            continue
        ref = decode(raw, os.path.join(tmp, cid + '-ref.pcm'))
        fl = geo['frameLen']
        mpf = geo['spf'] / geo['sr'] * 1000
        total = geo['count']
        lead = geo['leadMs']

        def byte_at_ms(ms):
            """复刻 byteAtMs：绝对帧映射 + leadMs 补偿 + 首帧长度单独计入"""
            fi = max(0, min(round((ms + lead) / mpf), total - 1))
            if fi == 0:
                return geo['first']
            return geo['first'] + geo['firstLen'] + (fi - 1) * geo['frameLen']

        # 抽样：首句、1/4、1/2、3/4、末句 + 注释
        spans = list(ch['sentences']) + list(ch.get('notes', []))
        picks = []
        if spans:
            idx = sorted(set([0, len(ch['sentences']) // 4, len(ch['sentences']) // 2,
                              3 * len(ch['sentences']) // 4, len(ch['sentences']) - 1]))
            picks = [(i, ch['sentences'][i]) for i in idx if 0 <= i < len(ch['sentences'])]
        if ch.get('notes'):
            picks.append(('note0', ch['notes'][0]))
        print(f'  [{cid}] 起始偏移={geo["first"]} 首帧={geo["firstLen"]}B 其余={geo["frameLen"]}B '
              f'Xing={geo["xing"]} leadMs={geo["leadMs"]:.0f} 帧数={total}')
        eps = []
        for tag, s in picks:
            st, en = s['startMs'], s['endMs']
            if en - st < 300:
                continue
            bs, be = byte_at_ms(st), byte_at_ms(en)
            if be - bs < geo['frameLen'] * 2:
                continue
            seg = raw[bs:be]
            dec = decode(seg, os.path.join(tmp, f'{cid}-{tag}-seg.pcm'))
            pre = 400
            r0 = max(0, int((st - pre) * SR / 1000))
            r1 = min(len(ref), int(en * SR / 1000) + int(500 * SR / 1000))
            eps_off, score = xcorr_offset(dec, ref[r0:r1])
            eps_off -= pre if r0 > 0 else st
            eps.append(eps_off)
            print(f'    {str(tag):6s} [{st:8d},{en:8d})ms bytes[{bs},{be}) ε={eps_off:+7.1f}ms 相似度={score:.3f}')
        if eps:
            print(f'  ➜ {cid}: ε 平均={sum(eps)/len(eps):+.1f}ms 范围=[{min(eps):+.1f},{max(eps):+.1f}]ms\n')


if __name__ == '__main__':
    main()
