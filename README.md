# 朗阅 · BookReader

本地电子书阅读 + 语音朗读（系统 TTS，免费）。网页可预览 UI，GitHub Actions 自动编译 Android APK。

## 功能

- 书架多书管理（参考起点三列封面）
- 阅读器：目录 / 记位置 / 设置 / 听书
- 朗读使用系统 TTS（小米建议装讯飞语记并设为默认引擎）
- 足迹记录每次阅读与朗读位置
- 导入 TXT

## 本地网页预览

```bash
npm install
npm run dev
```

打开 http://localhost:5173

## Android 编译（GitHub Actions）

推送到 `main` 或在 Actions 里手动 **Run workflow**，完成后在对应 run 的 **Artifacts** 下载 `bookreader-debug-apk`。

仓库：https://github.com/johnsondiao/bookreader

## 本地 Capacitor（可选）

需本机 Android SDK：

```bash
npm run cap:sync
npx cap open android
```
