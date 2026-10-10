/**
 * 朗读保活桥（仅 Android 原生环境生效）。
 *
 * 播放期间拉起 mediaPlayback 前台服务（PlaybackService）：
 * 系统看到「前台服务 + 活跃 MediaSession」就不再掐我们的音频，
 * 息屏后继续播放；通知栏常驻一条「正在朗读」。
 *
 * 网页预览（npm run dev）没有原生实现，isNativePlatform 短路成空操作。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

interface PlaybackKeepAlivePlugin {
  start(): Promise<void>
  stop(): Promise<void>
}

const raw = registerPlugin<PlaybackKeepAlivePlugin>('PlaybackKeepAlive')

export const playbackKeepAlive = {
  start(): Promise<void> {
    return Capacitor.isNativePlatform()
      ? raw.start().catch(() => {}) // 保活失败不该连累播放本身
      : Promise.resolve()
  },
  stop(): Promise<void> {
    return Capacitor.isNativePlatform()
      ? raw.stop().catch(() => {})
      : Promise.resolve()
  },
}
