# 朗阅 · 产品需求文档（PRD）

> 版本：1.1 · 更新日期：2026-08-09

---

## 一、产品概述

### 1.1 产品定位

朗阅是一款面向中文阅读场景的**本地电子书阅读 + 在线语音朗读**移动应用。用户导入 TXT / EPUB 文件后，可阅读正文、收听 MiniMax 高质量语音合成朗读，并管理已合成的音频文件。

### 1.2 核心价值

- **本地优先**：书籍文件导入后本地存储，阅读无需联网
- **高质量朗读**：MiniMax speech-2.8-turbo 在线语音合成，支持多音色切换
- **音频持久化**：已合成音频独立存储，软件升级不丢失，重复朗读不扣费
- **花费可控**：逐句计费、预算上限、多维度花费统计

### 1.3 平台

- **主平台**：Android（Capacitor 打包原生 APK）
- **兼容**：Web 浏览器可预览 UI（TTS 功能需配置环境变量）

---

## 二、目标用户与使用场景

### 2.1 目标用户

- 中文长文本阅读爱好者（文学、历史、哲学类选集）
- 通勤/运动时倾向听书而非看屏幕的用户
- 对朗读质量有要求、不接受系统 TTS 机械发音的用户

### 2.2 典型场景

| 场景 | 描述 |
|------|------|
| 导入书籍 | 用户从文件管理器选择 TXT/EPUB，App 自动切分章节并生成目录 |
| 阅读正文 | 翻页阅读，支持字号/行距/主题调整，点击句子可定位 |
| 听书 | 点击"听书"，App 在线合成语音并播放，合成后缓存，重复听不扣费 |
| 通勤续读 | 打开 App 自动恢复上次阅读位置，可从指定句子开始朗读 |
| 管理音频 | 在"我的"页面查看已合成音频，按书浏览、播放、删除 |
| 控制花费 | 设置每日预算上限，在"花费"页查看日/周/月/书维度统计 |

---

## 三、产品架构

### 3.1 页面结构

应用采用状态驱动的两层路由（非 URL 路由）：

```
phone-shell（手机外壳）
└── phone-screen
    ├── Home（始终挂载）
    │   ├── ShelfPage（书架，默认首页）
    │   ├── HistoryPage（足迹）
    │   ├── CostPage（花费）
    │   ├── MePage（我的）
    │   └── BottomNav（底部 4 Tab 导航）
    └── ReaderPage（阅读器，覆盖在 Home 之上的全屏层）
```

### 3.2 底部导航

| Tab | 图标 | 标签 | 功能 |
|-----|------|------|------|
| shelf | 書 | 书架 | 书籍列表、导入电子书 |
| history | 迹 | 足迹 | 阅读进度历史、一键恢复 |
| cost | 费 | 花费 | TTS 费用统计（日/周/月/书） |
| me | 我 | 我的 | 设置、已合成音频管理、书籍管理 |

### 3.3 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| UI 框架 | React | 19.2 |
| 语言 | TypeScript | 6.0 |
| 构建工具 | Vite | 8.2 |
| 状态管理 | Zustand + persist（IndexedDB） | 5.0 |
| 移动端 | Capacitor | 8.4 |
| EPUB 解压 | JSZip | 3.10 |
| 测试 | Vitest | 3.1 |
| Lint | OxLint | 1.75 |
| Android | minSdk 24 / targetSdk 36 (AGP 8.13) | — |

---

## 四、功能需求

### 4.1 书架管理

#### 4.1.1 导入书籍

- **支持格式**：TXT、EPUB
- **TXT 解析**：三级章节切分策略（见 4.1.2），自动猜测书名
- **EPUB 解析**：JSZip 解压 → OPF/Spine 章节顺序 → nav/NCX 目录 → 逐章提取正文
- **大文件友好**：解析过程中 `yieldToMain()` 让出主线程，显示实时进度
- **导入后自动打开**：直接跳转阅读器
- **错误处理**：配额超限、格式不支持给出友好提示

#### 4.1.2 章节切分算法（三级识别）

| 级别 | 规则 | 示例 |
|------|------|------|
| 第 1 级 | 严格标题正则：第X章/节/回/卷/部/集/篇、Chapter N、Part N | "第三章 湖南农民运动" |
| 第 2 级 | 带括号的日期副标题，与上一行短标题合并 | "（一九二七年三月）" |
| 第 3 级 | 孤立短标题兜底（2-40字，前后空行，无句末标点，非数字开头）——仅在严格标题不足 2 个时启用 | "中国社会各阶级的分析" |

- 章节总数不足 3 时不拆分，整本作为单章
- 支持中英文章节标题、罗马数字

#### 4.1.3 书架展示

- 三列封面网格，参考起点风格
- 封面：动态颜色（8 色循环）+ emoji（书名首字）+ 书名 + 进度条
- 卡片信息：书名、已读 X% · X 分钟前
- 入场动画：前 4 张有递增延迟

#### 4.1.4 移除书籍

- BookCard 右上角圆形 × 按钮（桌面 hover 显示，触屏始终显示）
- 点击后显示确认层："从书架移除？删除/取消"，覆盖封面
- **硬性约束**：移除仅从 IndexedDB 过滤 books 数组并清理快照，**不删除原始导入文件**，**不删除已合成音频文件**
- 措辞使用"移除"而非"删除"

### 4.2 阅读器

#### 4.2.1 正文渲染

- 章节标题 + 分段显示（初始 40 段，滚动接近底部自动加载 40 段）
- 段落分类型：`text`（正文）、`note`（注释，左侧蓝色边框区分）
- 注释识别：标题（注释/注解/备注）、前缀（*, [1], 1.）、延续段
- 长段（>600字）二次切分，避免 DOM 卡顿
- **句子级渲染**：每段按句末标点切分为可点击的 span

#### 4.2.2 手势交互

| 手势 | 作用 |
|------|------|
| 点击屏幕中部（28%-72%） | 唤出/隐藏菜单栏 |
| 点击屏幕上部（≤28%） | 上一句 |
| 点击屏幕下部（≥72%） | 下一句 |
| 左右滑动 | 上一章 / 下一章 |
| 点击句子 | 定位到该句，TTS 播放中则跳转播放 |

#### 4.2.3 菜单栏

**顶部栏**：返回按钮、书名、进度百分比

**底部栏**（4 个按钮）：
- 目录：弹出 TocPanel（搜索、折叠、三态着色、定位当前）
- 记位置：手动书签，记录当前阅读位置
- 设置：弹出 ReaderSettingsPanel
- 听书：开启/关闭 TTS 朗读

**章节滑动条**：range input 直接拖动跳转任意章节

#### 4.2.4 阅读设置

| 设置项 | 范围 | 说明 |
|--------|------|------|
| 背景主题 | 日间 / 护眼 / 夜间 | 三色块切换 |
| 字号 | 14-28 | 步进 1 |
| 语速 | 0.6-1.8x | 步进 0.1 |
| 中文音色 | 6 种 MiniMax 音色 | 下拉选择 |
| 注释音色 | 6 种 MiniMax 音色 | 注释段自动切换 |
| 每日预算 | 0-10 元（0=不限制） | 步进 0.5 |
| 调试面板 | 开/关 | 默认关 |

#### 4.2.5 目录面板（TocPanel）

- 层级折叠显示（按 `level` 分层）
- 搜索框按标题模糊匹配
- 三态着色：已读（灰）、在读（红）、未读（默认）
- 无正文的目录项可展开子项但不可跳转
- 顶部统计：已读 X/Y 章 · 进度 X%
- 工具栏：全部展开 / 全部折叠 / 定位当前

#### 4.2.6 进度管理

- 进度计算：`(章索引/总章 + 段索引/总段/总章) × 100`，上限 99.9%
- 进度来源：`read`（手动翻页）、`tts`（朗读触发）
- 已读判定：段索引 > 0 或来源为 tts 或标记为手动书签/点击定位/下翻定位
- 进度快照：最多 500 条，每条含书名、章节、段号、来源标签、备注、时间
- 恢复位置：从足迹页点击记录可一键恢复

### 4.3 语音朗读（TTS）

#### 4.3.1 合成引擎

- **模型**：MiniMax speech-2.8-turbo（T2A v2 同步模式）
- **计价**：¥2/万字（¥200/百万字符）
- **音色**：6 种精选中文音色（男女各 3），支持中英双语
- **输出**：MP3, 32kHz, 128kbps, 单声道

#### 4.3.2 音色目录

| key | 名称 | 性别 |
|-----|------|------|
| minimax-news-female | 新闻女声·沉稳播报（推荐） | 女 |
| minimax-warm-girl | 温暖少女·亲切 | 女 |
| minimax-gentleman | 温润男声·讲述 | 男 |
| minimax-announcer-male | 播报男声·浑厚 | 男 |
| minimax-shaonv | 少女·经典 | 女 |
| minimax-jingying | 精英青年·经典（默认注释音色） | 男 |

#### 4.3.3 句子级切分

- 句末标点：`。！？；…\n . ! ? ;`
- 每个句子 = 一次 API 调用 = 一个播放段（segment）
- ReaderPage 句子索引与 TTS segment 索引一一对应
- 段尾无结束标点的剩余部分也作为独立 segment

#### 4.3.4 生产者-消费者模型

```
生产者（synthesizeSegments）         消费者（playSegments）
    │                                     │
    ├── 从 startSegIdx 开始合成 ──→       ├── 从 startSegIdx 开始播放
    │   （环绕顺序：先向后，再回头）       │
    │                                     │
    ├── 每段合成完 → resolve(blobReady) →─┤ await seg.blobReady
    │                                     ├── 播放该段 MP3
    │                                     │
    └── 失败/中止 → reject 所有未完成 ──→  └── 消费者解除等待
```

- **首句秒播**：生产者从播放起点开始合成，首段就绪后消费者立即播放
- **环绕合成**：从 startSegIdx 向后到末尾，再回头合成 0 到 startSegIdx
- **串行化**：`currentPlayPromise` 确保同一时刻只有一次播放
- **中断机制**：`stop()` 三步中断（epoch+1、abort HTTP、reject deferreds）

#### 4.3.5 播放控制

- 播放/暂停/恢复
- 上一句 / 下一句跳转
- 显示当前句号 X/Y、语速、今日已耗金额
- 连章续读：本章播完自动跳到下一有内容的章节（跳过空章）

#### 4.3.6 预算控制

- 用户设置每日预算上限（0=不限制）
- 生产者每段合成前检查今日花费
- 超预算时抛出 `BudgetExceeded`，停止后续合成并提示用户
- 不需要合成前确认弹窗（直接开始）

#### 4.3.7 错误处理

| 错误类型 | 处理 | 是否可重试 |
|----------|------|-----------|
| 网络失败 | 提示检查网络 | 自动重试 1 次 |
| 限流/额度不足 | 提示等待 1-2 分钟 | 自动重试 1 次 |
| API Key 无效 | 提示重新解锁 | 否 |
| 参数错误 | 提示跳过或换音色 | 自动重试 1 次 |
| 服务端 5xx | 提示稍后重试 | 自动重试 1 次 |
| 音频解码失败 | 提示重试 | 自动重试 1 次 |
| 预算超限 | 停止合成 | 否 |
| 用户中止 | 正常返回 | — |

### 4.4 音频缓存与文件存储

#### 4.4.1 双写策略

| 存储 | 用途 | 生命周期 |
|------|------|----------|
| IndexedDB（主存储） | 分段 Blob + 字符边界，App 内精准播放 | LRU 淘汰（200MB→150MB） |
| 文件系统（持久存储） | 合并 MP3 整文件，跨升级保留 | 手动删除才消失 |

#### 4.4.2 IndexedDB 缓存

- 数据库名：`langyue-reader-audio`（v3）
- Store：`clips`（音频缓存）、`costs`（花费记录）
- 缓存键：`${bookId}__${chapterId}__${voiceKey}__${noteVoiceKey}`
- 校验：`textHash`（FNV-1a 32 位）验证正文是否变化
- 部分命中：按 `charStart/charEnd` 精确匹配，只重合成缺失段
- LRU 淘汰：总缓存超 200MB 时按 `lastUsedAt` 升序删除至 150MB

#### 4.4.3 文件系统存储

- 位置：Capacitor `Directory.Data`（Android: `/data/data/<pkg>/files/LangyueReader/audio/`）
- 文件名格式：`{书名}~~{章节名}~~{bookId}~~{chapterId}~~{voiceKey}~~{noteVoiceKey}~~{charStart}-{charEnd}~~{textHash}.mp3`
- 索引文件：`index.json` 记录所有音频元数据
- **索引自恢复**：index.json 丢失时扫描 .mp3 文件名重建索引
- **硬性约束**：已合成音频文件不得删除；有音频文件的章节不重复合成

#### 4.4.4 音频文件管理

- 入口："我的"页面 → 已合成音频
- 列表页：按书名分组，显示条数、总大小、"覆盖升级不会丢失"提示
- 详情页：某本书所有音频，每条可播放、查看路径、删除
- 播放：全局复用单一 `HTMLAudioElement`，避免并发
- 删除：二次确认，删除物理 mp3 文件 + 索引记录

### 4.5 花费统计

#### 4.5.1 总览

- 累计花费（元）、累计合成字数
- 刷新按钮重新计算

#### 4.5.2 四维度统计

| 维度 | 范围 | 展示内容 |
|------|------|----------|
| 按天 | 最近 30 天 | 日期（今天/昨天/X月X日）、字数、次数、金额 |
| 按周 | 最近 8 周 | 周起始日期、字数、金额 |
| 按月 | 最近 6 个月 | 月份、字数、金额 |
| 按书 | 全部 | 书名、字数、次数、最后日期、金额 |

#### 4.5.3 数据存储

- IndexedDB `costs` store（v3），内存缓存 + 防抖写入
- 每 10 次或 5 秒批量写一次
- 最多保留 5000 条记录
- 自动迁移 localStorage 旧数据

### 4.6 足迹（阅读历史）

- 展示所有阅读进度快照（最多 500 条）
- 每条：书名、章节、段号、进度、来源标签（朗读/阅读）、备注、时间
- 点击恢复：跳回历史位置（不再记新快照避免回声）
- 清空记录功能

### 4.7 系统交互

#### 4.7.1 Android 物理返回键

- 阅读器中：返回书架
- 书架中：退出 App

#### 4.7.2 语音解锁

- 首次朗读时弹出密码输入框
- 密码用于解密 MiniMax API Key（PBKDF2 10 万次 + AES-GCM 256）
- 解密后明文 Key 存入独立 IDB `langyue-reader-secure`
- 之后不再询问，除非手动重置

---

## 五、非功能需求

### 5.1 性能

| 指标 | 要求 |
|------|------|
| TTS 首句播放 | 首段合成完成后立即播放（生产者-消费者模型） |
| 大文件解析 | yieldToMain 让出主线程，不卡 UI |
| IDB 缓存 | LRU 淘汰，上限 200MB |
| 花费写入 | 内存缓存 + 防抖（5秒/10次），不阻塞合成 |
| 段落渲染 | 初始 40 段，按需加载 40 段 |

### 5.2 安全

| 威胁 | 防护措施 |
|------|----------|
| APK 反编译获取 Key | Key 以密文形式编译进 bundle，反编译只得密文 |
| Key 明文泄露 | 密文+IV+SALT 通过环境变量注入，不硬编码 |
| 设备 IDB 被读取 | 明文 Key 存独立 IDB，需用户输密码才写入 |
| CORS 阻断 | Android 原生用 CapacitorHttp 绕过浏览器 CORS |

### 5.3 可靠性

- 数据迁移：`normalizeBook` 逐本修复旧数据，单本损坏不影响其他
- 音频文件索引自恢复：index.json 丢失时从文件名重建
- 缓存部分命中：只重合成缺失段，不整章重合成
- 错误自动重试：网络/限流/5xx 类错误自动重试 1 次
- 音频保存失败提示："钱扣了但音频没保存"，引导用户检查存储空间

### 5.4 兼容性

- Android 7.0+（minSdk 24）
- Webkit/Chromium WebView
- 支持离线阅读（已导入书籍+已缓存音频）

---

## 六、数据模型

### 6.1 核心类型

```typescript
interface Book {
  id: string                    // UUID
  title: string
  author: string
  coverColor: string            // 8 色循环
  coverEmoji: string            // 书名首字
  chapters: Chapter[]
  toc: TocEntry[]               // 层级目录
  chapterId: string             // 当前章节
  paragraphIndex: number        // 当前段落
  progressPercent: number       // 整本进度
  furthestChapterIndex: number  // 读到过的最远章
  readChapterIds: string[]      // 实际打开过的章节
  addedAt: number
  lastReadAt: number
}

interface Chapter {
  id: string                    // 'ch-0', 'ch-1'...
  title: string
  content: string
  href?: string                 // EPUB spine 路径
}

interface TocEntry {
  id: string
  title: string
  level: number                 // 0=卷/部, 1=章, 2=节...
  chapterId: string | null
  href: string
}

interface ProgressSnapshot {
  id: string
  bookId: string
  chapterId: string
  chapterTitle: string
  paragraphIndex: number
  progressPercent: number
  source: 'read' | 'tts'
  note?: string
  createdAt: number
}

interface ReaderSettings {
  theme: 'day' | 'eye' | 'night'
  fontSize: number              // 14-28
  lineHeight: number
  ttsRate: number               // 0.6-1.8
  ttsVoiceZh: string            // 正文音色 key
  ttsVoiceNote: string          // 注释音色 key
  autoScroll: boolean
  dailyBudgetYuan: number       // 0=不限制
  ttsDebugPanel: boolean        // 默认 false
}
```

### 6.2 存储分布

| 存储 | 位置 | 用途 |
|------|------|------|
| IndexedDB `langyue-reader-v2` | Zustand persist | 书籍、快照、设置 |
| IndexedDB `langyue-reader-audio` (v3) | 独立 | 音频缓存（clips）、花费记录（costs） |
| IndexedDB `langyue-reader-secure` | 独立 | 解锁的明文 API Key |
| 文件系统 `Directory.Data` | Capacitor | 合并 MP3 文件 + index.json |

---

## 七、构建与部署

### 7.1 构建流水线

```
check-version → test:unit → tsc -b → vite build
```

任一环节失败即终止。

### 7.2 版本一致性检查

- `package.json` version 必须等于 `build.gradle` versionName
- `capacitor.config.ts` 若显式声明 version 也必须一致
- 当前版本：1.1（versionCode: 2）

### 7.3 Android APK 打包

```
npm run cap:sync    # 校验版本 → 构建 Web → cap sync android
npx cap open android # Android Studio 打开
./gradlew assembleRelease
```

- 签名：`keystore/bookreader-release.jks`
- ProGuard 混淆启用
- `noCompress 'data', 'mjs'` 防止 ES 模块压缩

### 7.4 CI/CD（GitHub Actions）

- 触发：push 到 main 或手动 Run workflow
- 流程：checkout → Node 22 → npm ci → build（注入 TTS Key 环境变量）→ Java 21 → Android SDK → cap sync → gradlew assembleRelease → 上传 Artifact（保留 30 天）→ 按 tag 发布 Release
- 产物：`朗阅-release.apk`

### 7.5 环境变量

| 变量 | 用途 | 注入方式 |
|------|------|----------|
| `VITE_TTS_KEY_CIPHER` | API Key 密文 | GitHub Secrets → build |
| `VITE_TTS_KEY_IV` | AES-GCM IV 向量 | GitHub Secrets → build |
| `VITE_TTS_KEY_SALT` | PBKDF2 盐值 | GitHub Secrets → build |

---

## 八、约束与约定

### 8.1 硬性约束

1. `removeBook` 只过滤 books 数组并清理快照，**不执行任何 IO 操作**删除原始文件
2. 移除书籍措辞使用"移除"而非"删除"
3. 在线语音合成必须使用 MiniMax speech-2.8-turbo（T2A v2）
4. API Key 加密注入，密码 `12345` 解密，首次运行需用户输入
5. 已合成音频文件不得删除；有音频的章节不重复合成
6. 本地音频模型和本地音频合成功能已移除
7. 音频文件独立存储，升级时保留
8. 调试面板默认不显示
9. TTS 按句切分（`。！？；…\n . ! ? ;`），一句一次 API 调用
10. 合成前无费用确认弹窗

### 8.2 工程约定

- BookCard 外层 `<div>` 包裹两个 `<button>`，避免嵌套 button 无效 HTML
- 删除按钮：桌面 hover 显示，触屏 `@media (hover: none)` 始终显示
- 音频缓存键：`bookId__chapterId__textVoice__noteVoice`
- 音频文件名：`{书名}~~{章节名}~~{bookId}~~{chapterId}~~{voiceKey}~~{noteVoiceKey}~~{charStart}-{charEnd}~~{textHash}.mp3`
- 句子切分共享 `isSentenceEnd` + `splitSentences` 逻辑，确保索引对齐
- 状态管理 Zustand persist 持久化到 IndexedDB，persist 时清空 `content` 字段

---

## 九、已知限制与改进方向

### 9.1 已知限制

- Web 预览环境无法使用文件系统存储（音频文件功能仅 Android 可用）
- 本地开发需手动配置 `.env.local` 提供 TTS Key 环境变量
- 段落高亮基于字符比例估算，非字级精确同步
- keystore 密码明文存放于仓库（建议迁移到 GitHub Secrets）

### 9.2 改进方向

- 支持更多电子书格式（PDF、MOBI）
- 音色试听功能
- 睡眠定时器
- 书签/笔记功能增强
- 云同步阅读进度
- 批量音频导出
