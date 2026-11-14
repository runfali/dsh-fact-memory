/**
 * Settings card for dsh-fact-memory.
 *
 * The card owns three things and nothing else:
 *   1. the switches the host config exposes (data dir, injection, capture limits),
 *   2. a live status line read from POST /api/fact-memory/status,
 *   3. two maintenance actions (export JSONL, rebuild the BM25 index).
 *
 * Config writes go through configForms.get(ns) → set(key, value); the host
 * reloads the plugin config from that snapshot, so the card never caches values
 * beyond what the controller reports.
 *
 * Loader contract: this file is served as the plugin's `./client` export and is
 * executed by the host's client module loader, not by the host bundle pipeline.
 */
window.__ModuleLoader__.load({
  id: "dsh-fact-memory",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;

    const react = require("react");
    const jsxRuntime = require("react/jsx-runtime");
    const jsx = jsxRuntime.jsx;
    const jsxs = jsxRuntime.jsxs;

    const NS = "dsh-fact-memory";
    const WIRE_VERSION = 1;
    const NET_TIMEOUT_MS = 8000;
    // A credential is the user's data, but the library is also a screen that gets
    // shared: show it masked until asked for.
    const MASKED = "••••••••";
    const INJECT_SERVICES = ["slots", "locale", "configForms"];

    const zh = {
      "card.title": "事实记忆",
      "card.description": "跨会话事实记忆：SQLite 权威事实库 + 检索/写入/遗忘三工具 + 常驻目录。只记「下次会话仍成立」的事实。",
      "card.statusUnavailable": "不可用",
      "card.statusFacts": "{n} 条事实",
      "card.statusPending": "待处理 {n}",
      "card.statusConflict": "冲突 {n}",
      "readOnly": "当前配置为只读，无法修改。",
      "applyHint": "改动即时生效：保存后下一次请求就会用新配置，无需重启宿主。",
      "unsaved": "未保存",
      "save": "保存",
      "saving": "保存中…",
      "discard": "放弃改动",
      "saveFailed": "有字段未通过校验：把标红的那一项改到允许范围内再保存。",
      "saveRejected": "宿主拒绝了这次写入：该插件条目当前不是本配置层可写的（例如由启动参数临时注入）。请把插件装进配置文件后再改。",
      "reset": "恢复默认",
      "overridden": "已覆盖",
      "overriddenN": "已覆盖 {n} 项",
      "unit.off": "不跑（0）",
      "unit.ms": "≈ {n} 毫秒",
      "unit.sec": "≈ {n} 秒",
      "unit.min": "≈ {n} 分钟",
      "unit.hour": "≈ {n} 小时",
      "unit.day": "≈ {n} 天",
      "group.master": "总开关",
      "group.advanced": "高级设置（一般不用改）",
      "group.advancedHint": "预算、超时、时区、备份轮转、自动查重都收在这里；默认值按常见用法调好了，不确定就先别动。",
      "group.inject": "常驻目录与提醒",
      "group.capture": "写入与检索",
      "group.safety": "安全与隐私",
      "group.data": "数据位置与备份",
      "group.conflicts": "待裁决冲突",
      "hint.conflicts": "同一槽位出现了两个可信度不足分胜负的值。选一个保留，另一个会退役；不选的话检索会把它们报成「未裁决」。",
      "conflict.keep": "保留这个",
      "op.resolveRunning": "正在裁决…",
      "op.resolveDone": "已裁决：保留 1 条，退役 {n} 条",
      "field.injectDirectory": "注入常驻目录",
      "hint.injectDirectory": "在每次请求的动态上下文中放一段预算内的记忆目录（实体 · 属性: 值）。关掉后只能靠 memory_search 检索。",
      "field.directoryBudget": "目录预算（tokens）",
      "hint.directoryBudget": "100–4000，按 2 字符/token 折算成字符预算；超出后截断并提示剩余条数。",
      "field.injectReminder": "会话开始提醒",
      "hint.injectReminder": "每个会话的首轮（以及用户提到记忆线索时）注入一条提示，告诉模型本会话可以检索与写入记忆。",
      "field.autoCapture": "自动捕获用户陈述",
      "hint.autoCapture": "关闭时只由模型显式调用 memory_write 写入。打开后按规则从句子里抽事实，凭据与个人隐私一律跳过。默认关闭，因为误记比漏记更难纠正。",
      "field.searchLimit": "默认返回条数",
      "hint.searchLimit": "memory_search 未指定 limit 时的条数，1–10。",
      "field.refuseCredentials": "拒绝形似凭据的内容",
      "hint.refuseCredentials": "开启时直接拒写。关闭后仍按敏感事实保存，且永远不进入模型上下文。",
      "field.sensitiveModelVisible": "敏感事实对模型可见",
      "hint.sensitiveModelVisible": "默认关闭：手机号、邮箱等只入库，不进常驻目录与检索结果。打开后模型可以看到它们。",
      "field.dataDir": "数据目录",
      "hint.dataDir": "留空表示 <DSH_HOME>/fact-memory。事实库、WAL、备份与导出都放在这里；改目录等于换一个记忆库，旧库不会自动迁移。",
      "field.backupBeforeExport": "导出前备份",
      "hint.backupBeforeExport": "导出前先做一份 SQLite 一致性备份到 <数据目录>/backups。",
      "field.enabled": "启用事实记忆",
      "hint.enabled": "总开关。关掉后三个记忆工具直接回答「不可用」，提示词里不再注入目录和提醒，后台体检、查重、建向量全部停；数据一条不动，重新打开就恢复。",
      "field.reminderBudgetTokens": "提醒正文预算（tokens）",
      "hint.reminderBudgetTokens": "每轮提醒最多这么多 token，按 2 字符折 1 个算（300 ≈ 600 字）。设 0 就完全不注入提醒，记忆只在你主动问的时候出现。",
      "field.searchBudgetTokens": "检索回执预算（tokens）",
      "hint.searchBudgetTokens": "memory_search 最多渲染这么多 token（1200 ≈ 2400 字），超出部分用「还有 N 条」收尾。",
      "field.queryTimeoutMs": "检索超时（毫秒）",
      "hint.queryTimeoutMs": "整次检索最多等这么久；超时就把已经拿到的结果给你，不报错。向量与重排也要在这段时间里跑完。",
      "field.storeTimezone": "时区",
      "hint.storeTimezone": "把「昨天」「下周三」换算成具体日期时用。留空跟随宿主本地时区；要固定就填 IANA 名，例如 Asia/Shanghai。库里始终存 UTC。",
      "field.advanceIntervalMs": "到期事实推进间隔（毫秒）",
      "hint.advanceIntervalMs": "带生效时间的事实（例如「下个月开始」）隔多久检查一次是否到点，顺便退休过期的。0 = 关掉定时器；每次打开库仍会先推进一次。",
      "field.backupBeforeWipe": "清空前先备份",
      "hint.backupBeforeWipe": "「一键清空」之前先做一份 SQLite 备份放进 <数据目录>/backups。默认开着：真删错了还能捞回来。",
      "field.backupKeep": "备份保留份数",
      "hint.backupKeep": "备份目录最多留几份，超出的从最旧的开始删。0 = 一份都不删，目录会一直变大。",
      "group.semantic": "语义检索（向量与重排）",
      "group.graph": "事实图谱",
      "field.embeddingSource": "向量提供方",
      "hint.embeddingSource": "none = 不走向量通道；openai = 一个 OpenAI 兼容的 /embeddings 端点。宿主目前不提供 embedding 能力，所以要自己填基址与模型。没配置时检索只用精确通道 + BM25，结果里会标明「未使用向量」。",
      "field.embeddingBaseUrl": "向量基址",
      "hint.embeddingBaseUrl": "例如 https://api.example.com/v1；插件会向 <基址>/embeddings 发请求。",
      "field.embeddingModel": "向量模型",
      "hint.embeddingModel": "建库与查询必须同一个模型；换模型或维度后旧向量会停止参与查询，需要重新建索引。",
      "field.embeddingDim": "向量维度",
      "hint.embeddingDim": "0 表示接受提供方返回的维度；填了就会校验每条向量长度。",
      "field.embeddingApiKeyEnv": "向量密钥环境变量",
      "field.invalidRange": "请输入 {min}–{max} 之间的数字",
      "hint.embeddingApiKeyEnv": "这里只填密钥的名字；密钥本身在下面粘贴，存进宿主的凭据库。",
      "key.title.embedding": "嵌入密钥",
      "key.title.rerank": "重排密钥",
      "key.title.llm": "抽取模型密钥",
      "key.sourceFile": "已保存",
      "key.sourceEnv": "来自环境变量",
      "key.sourceDotenv": "来自 .env",
      "key.sourceNone": "未配置",
      "key.placeholder": "粘贴密钥，回车保存",
      "key.replaceHint": "粘贴新密钥可覆盖",
      "key.save": "保存",
      "key.clear": "清除",
      "key.saved": "已存进宿主凭据库。",
      "key.cleared": "已从凭据库移除。",
      "key.failed": "保存失败，请看宿主日志。",
      "key.noRef": "（先填密钥名）",
      "field.rerankSource": "重排提供方",
      "hint.rerankSource": "none = 不重排；json = Cohere/Jina 风格的 POST /rerank。重排失败或超时会退回词面顺序，不会硬凑结果。",
      "field.rerankBaseUrl": "重排基址",
      "hint.rerankBaseUrl": "插件会向 <基址>/rerank 发请求，请求体含 model/query/documents/top_n。",
      "field.rerankModel": "重排模型",
      "hint.rerankModel": "重排模型标识；换模型后需要重新校准。",
      "field.rerankApiKeyEnv": "重排密钥环境变量",
      "hint.rerankApiKeyEnv": "只存变量名，不存密钥本身。",
      "field.rerankScoreMode": "重排分数口径",
      "hint.rerankScoreMode": "unit_interval = 0–1；logit / native = 任意有限实数。与适配器声明不一致时整次重排作废。",
      "group.extraction": "自动抽取（模型）",
      "field.autoExtract": "每轮结束后自动抽取",
      "hint.autoExtract": "打开后，每轮对话结束会把这一轮的用户原话交给模型抽一次事实：只发文本，不给工具、不给写库权限；低置信的进提案，等你确认。默认关闭——每次抽取会用一次模型调用。",
      "field.llmSource": "抽取用哪个模型",
      "hint.llmSource": "host = 复用当前会话正在用的模型（不新增凭据、不新增出网目标）；custom = 单独的 OpenAI 兼容端点，意味着这一轮对话文本会发到那个地址。",
      "field.llmBaseUrl": "custom 基址",
      "hint.llmBaseUrl": "仅 llmSource=custom 时生效，例如 https://api.example.com/v1；插件向 <基址>/chat/completions 发请求。",
      "field.llmModel": "custom 模型",
      "hint.llmModel": "仅 llmSource=custom 时生效。",
      "field.llmApiKeyEnv": "custom 密钥环境变量",
      "hint.llmApiKeyEnv": "只存变量名，不存密钥本身。",
      "field.extractFallbackTurns": "信号词兜底轮数",
      "hint.extractFallbackTurns": "没命中信号词时，连续这么多轮后仍让模型看一次；0 表示只靠信号词。",
      "field.extractFallbackChars": "信号词兜底字数",
      "hint.extractFallbackChars": "没命中信号词时，累计到这么多字就直接让模型看一次。",
      "field.extractIncludeAssistant": "同时读取助手回复",
      "hint.extractIncludeAssistant": "事实常在助手查完、改完的回复里；关掉后只读用户原话。",
      "field.vectorIndexIntervalMs": "向量自动索引间隔（毫秒）",
      "hint.vectorIndexIntervalMs": "配置了向量模型时，每隔这么久为新增或改动的事实建向量；0 只保留手动重建。写入新事实后会立刻补一次。",
      "field.autoConsolidate": "自动查重",
      "hint.autoConsolidate": "后台自动查近重复：词法与向量取并集，是否同一件事由模型判，结论只进待审提案。不点采纳不会改库，所以默认开着。",
      "field.consolidateIntervalMs": "查重间隔（毫秒）",
      "hint.consolidateIntervalMs": "多久自动查一次近重复。0 = 只留设置卡按钮和 consolidate 接口；关掉 autoConsolidate 则彻底不跑。计时器在内存里，重启后会重新计。",
      "field.consolidateCosineFloor": "向量相似度门槛",
      "hint.consolidateCosineFloor": "向量余弦达到这个值才把这一对送去模型核验。调低能抓到更多换说法的重复，代价是更多模型调用；调高更保守。",
      "field.consolidateMaxPairs": "每轮最多判定几对",
      "hint.consolidateMaxPairs": "自动那一轮最多花几次模型调用；点按钮手动跑时按三倍预算。同一对事实在每个向量代际只判一次，所以没有新内容时几乎不花钱。",
      "field.autoAudit": "自动体检",
      "hint.autoAudit": "后台定期检查事实库：只复述自己属性的事实、只有日期不同的流水账、同一主体被拼成两个实体。每类只出一条聚合提案，明细列在里面可逐条剔除；不采纳不会改库。",
      "field.auditIntervalMs": "体检间隔（毫秒）",
      "hint.auditIntervalMs": "多久体检一次。0 = 只留设置卡按钮和 audit 接口；关掉 autoAudit 则彻底不跑。计时器在内存里，重启后重新计。",
      "field.extractDelayMs": "抽取延迟（毫秒）",
      "hint.extractDelayMs": "一轮结束后等这么久再抽取，期间用户继续说话就合并到下一次；0 表示立即。",
      "field.extractConfidenceMin": "写入置信度门槛",
      "hint.extractConfidenceMin": "低于这个分数的候选不会写成事实，而是进待审提案。",
      "field.extractMaxChars": "单次抽取字符上限",
      "hint.extractMaxChars": "超过就切段，每次处理若干段，剩下的下一轮继续；未处理的范围不会被标记为已消费。",
      "field.extractThinking": "让模型先思考",
      "hint.extractThinking": "抽取是机械活，思考会吃掉输出预算。默认关掉；只有模型非思考不可时才打开。",
      "field.extractMerge": "跨段糅合",
      "hint.extractMerge": "多段之间出现重复或同一属性两个值时，额外调一次模型归并；模型只能重排给定候选，越界即作废。",
      "field.extractChunksPerPass": "每次处理段数",
      "hint.extractChunksPerPass": "一轮最多处理几段（1–4）。段数越多一次覆盖越全，单次调用也越多。",
      "status.extraction": "自动抽取{state} · 待处理 {pending}",
      "status.extractionOff": "自动抽取未开启",
      "option.llmSource.host": "当前会话模型",
      "option.llmSource.custom": "自定义端点",
      "status.semantic": "向量 {vectors} 条 · 重排：{rerank}",
      "status.semanticOff": "语义通道未启用",
      "status.on": "已启用",
      "status.off": "未启用",
      "status.rerankCalibrated": "已校准",
      "status.rerankUncalibrated": "未校准，仅用于排序",
      "status.proposals": "提案 {n}",
      "action.indexVectors": "重建向量",
      "option.embeddingSource.none": "不启用",
      "option.embeddingSource.openai": "OpenAI 兼容",
      "option.rerankSource.none": "不启用",
      "option.rerankSource.json": "JSON /rerank",
      "option.rerankScoreMode.unit_interval": "0–1",
      "option.rerankScoreMode.logit": "logit",
      "option.rerankScoreMode.native": "原始分",
      "graph.hint": "输入一个主体名，查看它的一跳邻域；每条边都带支撑事实。默认只显示已确认关系，冲突关系在「全部」视图里。",
      "graph.placeholder": "主体名，留空看最活跃的",
      "graph.load": "加载图谱",
      "graph.all": "全部关系",
      "graph.contested": "未决",
      "graph.empty": "没有可显示的关系。",
      "graph.truncated": "已截断：还有 {nodes} 个节点 / {edges} 条边未显示。",
      "graph.edgeFacts": "支撑事实 {n} 条",
      "op.proposalRunning": "正在应用提案…",
      "op.proposalDone": "提案已采纳，写入事实 {id}",
      "op.proposalApplied": "体检提案已执行。",
      "op.proposalSkipped": "其中 {n} 行在体检之后被改动过，已跳过。",
      "op.proposalRejected": "已拒绝这条提案",
      "op.proposalRejectRunning": "正在拒绝提案…",
      "op.proposalStale": "提案已过期：{reason}",
      "op.vectorRunning": "正在建向量索引…",
      "op.vectorDone": "已建 {n} 条向量",
      "action.export": "导出 JSONL",
      "action.rebuild": "重建索引",
      "action.dedup": "查找近重复",
      "action.wipe": "一键清空",
      "action.wipeConfirm": "确认清空（不可撤销）",
      "action.cancel": "取消",
      "action.wipeHint": "清空所有事实、实体、提案、冲突、全文与向量索引，只保留配置项与抽取运行记录；清空前会自动备份一份数据库。",
      "op.wipeRunning": "正在清空…",
      "op.wipeDone": "已清空 {n} 条事实，其余数据与索引已重置，运行记录保留",
      "op.exportRunning": "正在导出…",
      "op.exportDone": "已导出 {n} 条到 {path}",
      "op.rebuildRunning": "正在重建索引…",
      "op.rebuildDone": "已重建 {n} 条索引",
      "op.dedupRunning": "正在比对近重复（会调用模型判定）…",
      "op.dedupDone": "比对 {pairs} 对候选，判定 {judged} 对（同义 {same} · 不同 {distinct}），写入 {n} 条归并提案",
      "op.dedupSkipped": "这轮没有需要比对的候选：{reason}",
      "action.audit": "体检",
      "op.auditRunning": "正在体检事实库…",
      "op.auditDone": "体检发现 {findings} 处问题，按类归并成 {n} 条待审提案",
      "op.auditClean": "体检通过：没发现需要处理的问题",
      "op.auditSkipped": "这轮没有跑体检：{reason}",
      "op.auditReason.disabled": "功能已关闭",
      "op.auditReason.not_due": "距上次体检还不到设定间隔",
      "op.auditReason.busy": "上一轮体检还没结束",
      "op.auditReason.no_store": "数据库没有打开",
      "op.auditReason.unknown": "未知原因",
      "page.proposalKind.audit": "体检整理",
      "page.review.digest": "自你上次查看后新增 {n} 条提案",
      "page.review.kind": "{kind} {n}",
      "page.audit.more": "同批还有 {n} 条明细",
      "page.audit.keepTag": "保留这条",
      "page.audit.canonicalTag": "归并到这里",
      "page.audit.prune": "剔除这条",
      "page.audit.noDetails": "这条提案没有可显示的明细",
      "op.dedupReason.no_candidate_pairs": "库里没有达到阈值的近重复对",
      "op.dedupReason.no_vector_generation": "还没有向量索引，只能按词法比对，没发现重复",
      "op.dedupReason.no_model": "没有可用的模型，判定已排队等下一轮",
      "op.dedupReason.not_due": "还没到下一轮的时间，点按钮会强制跑一次",
      "op.dedupReason.disabled": "插件已关闭",
      "op.dedupReason.unknown": "原因未知",
      "op.failed": "操作失败：{error}",
      "op.unavailable": "宿主未注册记忆路由，无法执行该操作。",
      "integrity.bad": "完整性检查未通过：{error}",
      "integrity.index": "检索索引需要重建（不影响事实库）：{error}",
      "meta.schema": "库格式 v{v}",
      "meta.generation": "数据版本 {g}",
      "meta.fineprint": "库格式 v{v} · 数据版本 {g} · 仅诊断用",
      "meta.vectorAuto": "向量自动索引 · 每 {m} 分钟 · 上次 {time}，新增 {n} 条",
      "meta.vectorWaiting": "向量自动索引 · 每 {m} 分钟 · 等待首次扫描",
      "meta.vectorManual": "向量自动索引已关闭 · 只能手动重建",
    };

    const en = {
      "card.title": "Fact memory",
      "card.description": "Cross-session fact memory: a SQLite truth source, search/write/forget tools, and a resident directory. Only facts that still hold next session.",
      "card.statusUnavailable": "Unavailable",
      "card.statusFacts": "{n} facts",
      "card.statusPending": "{n} pending",
      "card.statusConflict": "{n} conflicts",
      "readOnly": "This configuration is read-only.",
      "applyHint": "Changes apply immediately: the next request uses them, no restart needed.",
      "unsaved": "Unsaved",
      "save": "Save",
      "saving": "Saving…",
      "discard": "Discard",
      "saveFailed": "A field failed validation: bring the highlighted one into its allowed range, then save.",
      "saveRejected": "The host refused the write: this plugin entry is not writable from the current config layer (for example it was injected by a launch flag). Install the plugin into the profile first.",
      "reset": "Reset",
      "overridden": "overridden",
      "overriddenN": "{n} overridden",
      "unit.off": "off (0)",
      "unit.ms": "≈ {n} ms",
      "unit.sec": "≈ {n} s",
      "unit.min": "≈ {n} min",
      "unit.hour": "≈ {n} h",
      "unit.day": "≈ {n} d",
      "group.master": "Master switch",
      "group.advanced": "Advanced (usually leave alone)",
      "group.advancedHint": "Budgets, timeouts, the time zone, backup rotation and the duplicate check live here. The defaults are tuned for everyday use; leave them alone unless you know you need a change.",
      "group.inject": "Directory and notices",
      "group.capture": "Capture and retrieval",
      "group.safety": "Safety and privacy",
      "group.data": "Storage and backup",
      "group.conflicts": "Unsettled conflicts",
      "hint.conflicts": "Two values compete for one slot and neither outranks the other. Keep one and the other is retired; until then recall reports them as undecided.",
      "conflict.keep": "Keep this one",
      "op.resolveRunning": "Settling…",
      "op.resolveDone": "Settled: kept 1, retired {n}",
      "field.injectDirectory": "Inject the directory",
      "hint.injectDirectory": "Put a budgeted memory directory (entity · property: value) into every request's dynamic context. Off means recall only through memory_search.",
      "field.directoryBudget": "Directory budget (tokens)",
      "hint.directoryBudget": "100–4000, converted at 2 characters per token; overflow is truncated with a count of what was left out.",
      "field.injectReminder": "Session-start notice",
      "hint.injectReminder": "Inject one notice on a session's first turn (and when the user mentions memory), telling the model it can search and write.",
      "field.autoCapture": "Auto-capture user statements",
      "hint.autoCapture": "Off means only an explicit memory_write call stores anything. On runs the rule extractor; credentials and personal data are always skipped. Off by default: a wrong memory is harder to correct than a missing one.",
      "field.searchLimit": "Default result count",
      "hint.searchLimit": "Used by memory_search when the call omits limit; 1–10.",
      "field.refuseCredentials": "Refuse credential-shaped writes",
      "hint.refuseCredentials": "On: the write is refused. Off: it is stored as a sensitive fact and still never enters model context.",
      "field.sensitiveModelVisible": "Sensitive facts visible to the model",
      "hint.sensitiveModelVisible": "Off by default: phone numbers and emails stay in the store, out of the directory and out of search results. On: the model can see them.",
      "field.dataDir": "Data directory",
      "hint.dataDir": "Empty means <DSH_HOME>/fact-memory. Database, WAL, backups and exports live here; changing it switches to a different store (no migration).",
      "field.backupBeforeExport": "Back up before export",
      "hint.backupBeforeExport": "Take a consistent SQLite backup into <data dir>/backups before writing the JSONL.",
      "field.enabled": "Enable fact memory",
      "hint.enabled": "The master switch. Off means the three memory tools answer “unavailable”, no directory or notice is injected, and the background health check, duplicate check and vector sweeps stop. Nothing is deleted; switch it back on and everything returns.",
      "field.reminderBudgetTokens": "Notice budget (tokens)",
      "hint.reminderBudgetTokens": "Tokens of reminder text per turn, two characters each (300 ≈ 600 characters). 0 injects no reminder; memory then appears only when you ask for it.",
      "field.searchBudgetTokens": "Search reply budget (tokens)",
      "hint.searchBudgetTokens": "How much of a memory_search reply is rendered (1200 ≈ 2400 characters); the rest is summarised as “N more”.",
      "field.queryTimeoutMs": "Search timeout (ms)",
      "hint.queryTimeoutMs": "Whole-search deadline. Past it you get the hits found so far instead of an error; the embedding and rerank hops have to fit inside it.",
      "field.storeTimezone": "Time zone",
      "hint.storeTimezone": "Used to turn “yesterday” or “next Wednesday” into a real date. Empty follows the host's local zone; to pin it, use an IANA name such as Asia/Shanghai. Dates are always stored in UTC.",
      "field.advanceIntervalMs": "Scheduled-fact tick (ms)",
      "hint.advanceIntervalMs": "How often facts with a future start date are promoted and expired ones retired. 0 disables the timer; opening the store still advances once.",
      "field.backupBeforeWipe": "Back up before clearing",
      "hint.backupBeforeWipe": "Take a SQLite backup into <data dir>/backups before “Clear everything”. On by default, so a real mistake stays recoverable.",
      "field.backupKeep": "Backups to keep",
      "hint.backupKeep": "How many backups stay in the folder; the oldest go first. 0 keeps all of them and the folder keeps growing.",
      "group.semantic": "Semantic retrieval (vectors and reranking)",
      "group.graph": "Fact graph",
      "field.embeddingSource": "Embedding provider",
      "hint.embeddingSource": "none = no vector channel; openai = an OpenAI-compatible /embeddings endpoint. The host does not supply an embedding model, so base URL and model are yours to fill in. Without it, recall uses the exact channel plus BM25 and says so.",
      "field.embeddingBaseUrl": "Embedding base URL",
      "hint.embeddingBaseUrl": "For example https://api.example.com/v1; the plugin calls <base>/embeddings.",
      "field.embeddingModel": "Embedding model",
      "hint.embeddingModel": "Indexing and querying must use the same model; after a model or dimension change the old vectors drop out and the index must be rebuilt.",
      "field.embeddingDim": "Vector dimension",
      "hint.embeddingDim": "0 accepts whatever the provider returns; a non-zero value is checked against every vector.",
      "field.embeddingApiKeyEnv": "Embedding key env var",
      "field.invalidRange": "Enter a number between {min} and {max}",
      "hint.embeddingApiKeyEnv": "Put the key NAME here; paste the secret below and it is stored in the host credential store.",
      "key.title.embedding": "Embedding key",
      "key.title.rerank": "Rerank key",
      "key.title.llm": "Extraction model key",
      "key.sourceFile": "Saved",
      "key.sourceEnv": "From environment",
      "key.sourceDotenv": "From .env",
      "key.sourceNone": "Not set",
      "key.placeholder": "Paste the key, Enter to save",
      "key.replaceHint": "Paste a new key to replace it",
      "key.save": "Save",
      "key.clear": "Clear",
      "key.saved": "Saved to the host credential store.",
      "key.cleared": "Removed from the credential store.",
      "key.failed": "Save failed; check the host log.",
      "key.noRef": "(fill the key name first)",
      "field.rerankSource": "Reranker provider",
      "hint.rerankSource": "none = no reranking; json = a Cohere/Jina style POST /rerank. A failed or timed-out rerank falls back to lexical order rather than padding results.",
      "field.rerankBaseUrl": "Rerank base URL",
      "hint.rerankBaseUrl": "The plugin calls <base>/rerank with model/query/documents/top_n.",
      "field.rerankModel": "Rerank model",
      "hint.rerankModel": "Rerank model id; changing it requires recalibration.",
      "field.rerankApiKeyEnv": "Rerank key env var",
      "hint.rerankApiKeyEnv": "Only the variable name is stored, never the key.",
      "field.rerankScoreMode": "Rerank score mode",
      "hint.rerankScoreMode": "unit_interval = 0–1; logit / native = any finite number. A mismatch with the adapter invalidates the whole rerank result.",
      "group.extraction": "Automatic extraction (model)",
      "field.autoExtract": "Extract after every turn",
      "hint.autoExtract": "When on, the user text of each finished turn is sent to a model once: text only, no tools, no write access. Low-confidence candidates become proposals. Off by default — every extraction costs one model call.",
      "field.llmSource": "Which model extracts",
      "hint.llmSource": "host reuses the model this session already runs (no new credential, no new outbound destination); custom is a separate OpenAI-compatible endpoint, which means the turn's text leaves the machine for that address.",
      "field.llmBaseUrl": "Custom base URL",
      "hint.llmBaseUrl": "Only with llmSource=custom, e.g. https://api.example.com/v1; requests go to <base>/chat/completions.",
      "field.llmModel": "Custom model",
      "hint.llmModel": "Only with llmSource=custom.",
      "field.llmApiKeyEnv": "Custom key env var",
      "hint.llmApiKeyEnv": "Only the variable name is stored, never the key.",
      "field.extractFallbackTurns": "Signal-free fallback turns",
      "hint.extractFallbackTurns": "Keep asking turns without a signal word this long, then let the model read them anyway; 0 = prefilter only.",
      "field.extractFallbackChars": "Signal-free fallback chars",
      "hint.extractFallbackChars": "Signal-free text this long skips the wait and goes to the model at once.",
      "field.extractIncludeAssistant": "Read the assistant's replies too",
      "hint.extractIncludeAssistant": "Facts often land in the reply after the work; off = only the user's own words.",
      "field.vectorIndexIntervalMs": "Vector index interval (ms)",
      "hint.vectorIndexIntervalMs": "When an embedding model is configured, rebuild vectors for new or changed facts this often; 0 keeps it manual. A new fact triggers one immediately.",
      "field.autoConsolidate": "Automatic duplicate check",
      "hint.autoConsolidate": "Look for near-duplicates in the background: lexical and vector recall are unioned, a model decides whether two rows say the same thing, and every verdict becomes a pending proposal. Nothing changes until you accept one, so it is on by default.",
      "field.consolidateIntervalMs": "Duplicate-check interval (ms)",
      "hint.consolidateIntervalMs": "How often to look for near-duplicates. 0 leaves the settings button and the consolidate route as the only triggers; turning off autoConsolidate stops it entirely. The clock is in memory, so a restart starts it over.",
      "field.consolidateCosineFloor": "Vector similarity floor",
      "hint.consolidateCosineFloor": "Vector cosine at or above which a pair is worth asking the model about. Lower catches more re-phrasings at the cost of more calls; higher is more conservative.",
      "field.consolidateMaxPairs": "Pairs per sweep",
      "hint.consolidateMaxPairs": "Model calls one automatic sweep may spend; the settings button runs with triple that budget. Each pair is judged once per vector generation, so an unchanged library costs nothing.",
      "field.autoAudit": "Automatic health check",
      "hint.autoAudit": "Check the library in the background for facts that only restate their own property, pipelines that differ only by date, and one subject spelled as two entities. Each class becomes one aggregated proposal whose details you can strike out; nothing changes unless you accept.",
      "field.auditIntervalMs": "Health check interval (ms)",
      "hint.auditIntervalMs": "How often to run the check. 0 leaves the settings button and the audit route as the only triggers; turning off autoAudit stops it entirely. The clock is in memory, so a restart starts it over.",
      "field.extractDelayMs": "Extraction delay (ms)",
      "hint.extractDelayMs": "Wait this long after a turn ends; more user text in the meantime is merged into the next pass. 0 runs immediately.",
      "field.extractConfidenceMin": "Write confidence floor",
      "hint.extractConfidenceMin": "Below this score a candidate is not written as a fact; it becomes a proposal.",
      "field.extractMaxChars": "Chars per extraction",
      "hint.extractMaxChars": "Longer text is split into segments, a few per pass; unconsumed text is never marked consumed.",
      "field.extractThinking": "Let the model think first",
      "hint.extractThinking": "Extraction is mechanical and thinking eats the answer budget. Off by default; turn it on only if the model cannot work otherwise.",
      "field.extractMerge": "Merge across segments",
      "hint.extractMerge": "When segments repeat or disagree on one attribute, one extra model call consolidates them; it may only recombine the given candidates.",
      "field.extractChunksPerPass": "Segments per pass",
      "hint.extractChunksPerPass": "How many segments one pass covers (1–4). More coverage per pass, more calls.",
      "status.extraction": "Extraction {state} · {pending} pending",
      "status.extractionOff": "Automatic extraction off",
      "option.llmSource.host": "Session model",
      "option.llmSource.custom": "Custom endpoint",
      "status.semantic": "{vectors} vectors · rerank: {rerank}",
      "status.semanticOff": "Semantic channels off",
      "status.on": "on",
      "status.off": "off",
      "status.rerankCalibrated": "calibrated",
      "status.rerankUncalibrated": "uncalibrated, ordering only",
      "status.proposals": "{n} proposals",
      "action.indexVectors": "Rebuild vectors",
      "option.embeddingSource.none": "Off",
      "option.embeddingSource.openai": "OpenAI-compatible",
      "option.rerankSource.none": "Off",
      "option.rerankSource.json": "JSON /rerank",
      "option.rerankScoreMode.unit_interval": "0–1",
      "option.rerankScoreMode.logit": "logit",
      "option.rerankScoreMode.native": "native",
      "graph.hint": "Name a subject to see its one-hop neighborhood; every edge carries its supporting facts. Only confirmed relations show by default; contested ones appear under All.",
      "graph.placeholder": "Subject name, empty for the busiest",
      "graph.load": "Load graph",
      "graph.all": "All relations",
      "graph.contested": "contested",
      "graph.empty": "No relations to show.",
      "graph.truncated": "Truncated: {nodes} more nodes / {edges} more edges.",
      "graph.edgeFacts": "{n} supporting facts",
      "op.proposalRunning": "Applying the proposal…",
      "op.proposalDone": "Proposal accepted, wrote fact {id}",
      "op.proposalApplied": "The health-check proposal ran.",
      "op.proposalSkipped": "{n} rows changed after the check and were skipped.",
      "op.proposalRejected": "Proposal rejected",
      "op.proposalRejectRunning": "Rejecting the proposal…",
      "op.proposalStale": "The proposal went stale: {reason}",
      "op.vectorRunning": "Building the vector index…",
      "op.vectorDone": "Indexed {n} vectors",
      "action.export": "Export JSONL",
      "action.rebuild": "Rebuild index",
      "action.dedup": "Find near-duplicates",
      "action.wipe": "Clear everything",
      "action.wipeConfirm": "Confirm clear (cannot be undone)",
      "action.cancel": "Cancel",
      "action.wipeHint": "Removes every fact, entity, proposal, conflict, full-text and vector index; settings and the run history stay. A database backup is written first.",
      "op.wipeRunning": "Clearing…",
      "op.wipeDone": "Cleared {n} facts; everything else was reset, run history kept",
      "op.exportRunning": "Exporting…",
      "op.exportDone": "Exported {n} records to {path}",
      "op.rebuildRunning": "Rebuilding the index…",
      "op.rebuildDone": "Reindexed {n} facts",
      "op.dedupRunning": "Comparing near-duplicates (one model call per pair)…",
      "op.dedupDone": "Compared {pairs} pairs, judged {judged} (same {same} · distinct {distinct}), filed {n} merge proposals",
      "op.dedupSkipped": "Nothing to compare this round: {reason}",
      "action.audit": "Health check",
      "op.auditRunning": "Checking the library…",
      "op.auditDone": "Found {findings} problems, filed as {n} proposals to review",
      "op.auditClean": "Clean: nothing needs attention",
      "op.auditSkipped": "Nothing ran this round: {reason}",
      "op.auditReason.disabled": "the feature is off",
      "op.auditReason.not_due": "the interval has not elapsed",
      "op.auditReason.busy": "the previous run is still going",
      "op.auditReason.no_store": "the store is not open",
      "op.auditReason.unknown": "unknown reason",
      "page.proposalKind.audit": "health check",
      "page.review.digest": "{n} new proposals since you last looked",
      "page.review.kind": "{kind} {n}",
      "page.audit.more": "{n} more in this batch",
      "page.audit.keepTag": "keep",
      "page.audit.canonicalTag": "merge into this",
      "page.audit.prune": "drop this row",
      "page.audit.noDetails": "this proposal carries no rows to show",
      "op.dedupReason.no_candidate_pairs": "no pair reaches the threshold",
      "op.dedupReason.no_vector_generation": "no vector index yet, so the lexical leg alone found nothing",
      "op.dedupReason.no_model": "no model available; the pairs are queued for the next round",
      "op.dedupReason.not_due": "the interval has not elapsed; the button forces a sweep",
      "op.dedupReason.disabled": "the plugin is switched off",
      "op.dedupReason.unknown": "unknown reason",
      "op.failed": "Failed: {error}",
      "op.unavailable": "The host did not register the memory routes.",
      "integrity.bad": "Integrity check failed: {error}",
      "integrity.index": "The search index needs a rebuild (the fact store is fine): {error}",
      "meta.schema": "store format v{v}",
      "meta.generation": "data revision {g}",
      "meta.fineprint": "store format v{v} · data revision {g} · diagnostic only",
      "meta.vectorAuto": "vectors auto-indexed every {m} min · last {time}, {n} new",
      "meta.vectorWaiting": "vectors auto-indexed every {m} min · waiting for the first sweep",
      "meta.vectorManual": "vector auto-index is off · manual rebuild only",
    };

    // ── fields ─────────────────────────────────────────────────────────────
    // Top to bottom, in the order the card draws them. `enabled` is the master
    // switch and always comes first; the tuning keys share one "advanced" group
    // that the card folds away, so opening the card never becomes a wall of
    // numbers.
    const FIELDS = [
      { key: "enabled", type: "bool", group: "master" },
      { key: "injectDirectory", type: "bool", group: "inject" },
      { key: "directoryBudget", type: "number", min: 100, max: 4000, step: 50, group: "inject" },
      { key: "injectReminder", type: "bool", group: "inject" },
      { key: "autoCapture", type: "bool", group: "capture" },
      { key: "searchLimit", type: "number", min: 1, max: 10, step: 1, group: "capture" },
      { key: "refuseCredentials", type: "bool", group: "safety" },
      { key: "sensitiveModelVisible", type: "bool", group: "safety" },
      { key: "embeddingSource", type: "enum", options: ["none", "openai"], group: "semantic" },
      { key: "embeddingBaseUrl", type: "text", group: "semantic" },
      { key: "embeddingModel", type: "text", group: "semantic" },
      { key: "embeddingDim", type: "number", min: 0, max: 8192, step: 1, group: "semantic" },
      { key: "embeddingApiKeyEnv", type: "text", group: "semantic" },
      { key: "rerankSource", type: "enum", options: ["none", "json"], group: "semantic" },
      { key: "rerankBaseUrl", type: "text", group: "semantic" },
      { key: "rerankModel", type: "text", group: "semantic" },
      { key: "rerankApiKeyEnv", type: "text", group: "semantic" },
      { key: "rerankScoreMode", type: "enum", options: ["unit_interval", "logit", "native"], group: "semantic" },
      { key: "autoExtract", type: "bool", group: "extraction" },
      { key: "llmSource", type: "enum", options: ["host", "custom"], group: "extraction" },
      { key: "llmBaseUrl", type: "text", group: "extraction" },
      { key: "llmModel", type: "text", group: "extraction" },
      { key: "llmApiKeyEnv", type: "text", group: "extraction" },
      { key: "extractDelayMs", type: "number", min: 0, max: 600000, step: 100, unit: "ms", group: "extraction" },
      { key: "extractConfidenceMin", type: "number", min: 0, max: 1, step: 0.05, group: "extraction" },
      { key: "extractMaxChars", type: "number", min: 500, max: 200000, step: 500, group: "extraction" },
      { key: "extractThinking", type: "bool", group: "extraction" },
      { key: "extractMerge", type: "bool", group: "extraction" },
      { key: "extractChunksPerPass", type: "number", min: 1, max: 4, step: 1, group: "extraction" },
      { key: "extractFallbackTurns", type: "number", min: 0, max: 20, step: 1, group: "extraction" },
      { key: "extractFallbackChars", type: "number", min: 0, max: 20000, step: 100, group: "extraction" },
      { key: "extractIncludeAssistant", type: "bool", group: "extraction" },
      { key: "vectorIndexIntervalMs", type: "number", min: 0, max: 86400000, step: 60000, unit: "ms", group: "semantic" },
      { key: "autoAudit", type: "bool", group: "data" },
      { key: "auditIntervalMs", type: "number", min: 0, max: 604800000, step: 60000, unit: "ms", group: "data" },
      { key: "dataDir", type: "text", group: "data" },
      { key: "backupBeforeExport", type: "bool", group: "data" },
      { key: "reminderBudgetTokens", type: "number", min: 0, max: 4000, step: 50, group: "advanced" },
      { key: "searchBudgetTokens", type: "number", min: 200, max: 6000, step: 100, group: "advanced" },
      { key: "queryTimeoutMs", type: "number", min: 200, max: 10000, step: 100, unit: "ms", group: "advanced" },
      { key: "storeTimezone", type: "text", group: "advanced" },
      { key: "advanceIntervalMs", type: "number", min: 0, max: 3600000, step: 1000, unit: "ms", group: "advanced" },
      { key: "backupBeforeWipe", type: "bool", group: "advanced" },
      { key: "backupKeep", type: "number", min: 0, max: 60, step: 1, group: "advanced" },
      { key: "autoConsolidate", type: "bool", group: "advanced" },
      { key: "consolidateIntervalMs", type: "number", min: 0, max: 604800000, step: 60000, unit: "ms", group: "advanced" },
      { key: "consolidateCosineFloor", type: "number", min: 0.5, max: 1, step: 0.01, group: "advanced" },
      { key: "consolidateMaxPairs", type: "number", min: 1, max: 50, step: 1, group: "advanced" },
    ];
    const GROUPS = ["master", "inject", "capture", "safety", "semantic", "extraction", "data"];
    const DEFAULTS = {
      injectDirectory: true,
      directoryBudget: 800,
      injectReminder: true,
      autoCapture: false,
      searchLimit: 5,
      refuseCredentials: true,
      sensitiveModelVisible: false,
      embeddingSource: "none",
      embeddingBaseUrl: "",
      embeddingModel: "",
      embeddingDim: 0,
      embeddingApiKeyEnv: "FACT_MEMORY_EMBEDDING_KEY",
      rerankSource: "none",
      rerankBaseUrl: "",
      rerankModel: "",
      rerankApiKeyEnv: "FACT_MEMORY_RERANK_KEY",
      rerankScoreMode: "unit_interval",
      autoExtract: false,
      llmSource: "host",
      llmBaseUrl: "",
      llmModel: "",
      llmApiKeyEnv: "FACT_MEMORY_LLM_KEY",
      extractDelayMs: 5000,
      extractConfidenceMin: 0.6,
      extractMaxChars: 24000,
      extractThinking: false,
      extractMerge: true,
      extractChunksPerPass: 2,
      extractFallbackTurns: 3,
      extractFallbackChars: 800,
      extractIncludeAssistant: true,
      vectorIndexIntervalMs: 600000,
      autoAudit: true,
      auditIntervalMs: 21600000,
      dataDir: "",
      backupBeforeExport: true,
      enabled: true,
      reminderBudgetTokens: 300,
      searchBudgetTokens: 1200,
      queryTimeoutMs: 2500,
      storeTimezone: "",
      advanceIntervalMs: 60000,
      backupBeforeWipe: true,
      backupKeep: 7,
      autoConsolidate: true,
      consolidateIntervalMs: 21600000,
      consolidateCosineFloor: 0.85,
      consolidateMaxPairs: 8,
    };

    /**
     * Intervals and timeouts are stored in milliseconds because that is what the
     * host reads; nobody thinks in 21600000. One quiet line under the input says
     * the same number in units a person can picture.
     */
    function durationText(t, raw) {
      const ms = Number(raw);
      if (!Number.isFinite(ms) || ms <= 0) return t("unit.off");
      const round1 = (value) => String(Math.round(value * 10) / 10);
      if (ms < 1000) return t("unit.ms", { n: Math.round(ms) });
      if (ms < 60_000) return t("unit.sec", { n: round1(ms / 1000) });
      if (ms < 3_600_000) return t("unit.min", { n: round1(ms / 60_000) });
      if (ms < 86_400_000) return t("unit.hour", { n: round1(ms / 3_600_000) });
      return t("unit.day", { n: round1(ms / 86_400_000) });
    }

    function parseField(field, raw) {
      if (field.type === "bool") return { value: raw === true };
      if (field.type === "enum") {
        const text = String(raw ?? "");
        return field.options.includes(text) ? { value: text } : { invalid: true };
      }
      if (field.type === "number") {
        const text = String(raw === undefined || raw === null ? "" : raw).trim();
        if (text === "") return { invalid: true };
        const n = Number(text);
        if (!Number.isFinite(n)) return { invalid: true };
        // A fractional step means the field is a decimal (0.05 for a confidence
        // threshold); rounding it to an integer would silently reject every
        // value the user can type.
        const decimals = Number.isInteger(field.step ?? 1) ? 0 : 2;
        const value = decimals === 0 ? Math.round(n) : Math.round(n * 100) / 100;
        if (value < field.min || value > field.max) return { invalid: true };
        return { value };
      }
      return { value: String(raw === undefined || raw === null ? "" : raw) };
    }

    function sameValue(field, left, right) {
      if (field.type === "number") return Number(left) === Number(right);
      if (field.type === "bool") return (left === true) === (right === true);
      return String(left === undefined || left === null ? "" : left) === String(right === undefined || right === null ? "" : right);
    }

    function projectionOf(scope, staged, saving, failed, failureReason, status, op, conflicts, graph) {
      const snapshot = scope && typeof scope.getSnapshot === "function" ? scope.getSnapshot() : null;
      const values = snapshot && snapshot.value && typeof snapshot.value === "object" ? snapshot.value : {};
      const user = snapshot && snapshot.user && typeof snapshot.user === "object" ? snapshot.user : {};
      const fields = {};
      let dirty = false;
      let invalid = false;
      FIELDS.forEach((field) => {
        const stagedEntry = staged.get(field.key);
        const current = values[field.key];
        let state;
        if (stagedEntry === undefined) {
          const shown = current === undefined ? DEFAULTS[field.key] : current;
          state = { value: shown, overridden: Object.prototype.hasOwnProperty.call(user, field.key), invalid: false };
        } else if (stagedEntry.invalid) {
          state = { value: current === undefined ? DEFAULTS[field.key] : current, overridden: true, invalid: true };
          dirty = true;
          invalid = true;
        } else {
          state = { value: stagedEntry.value, overridden: true, invalid: false };
          const base = current === undefined ? DEFAULTS[field.key] : current;
          if (!sameValue(field, base, stagedEntry.value)) dirty = true;
        }
        fields[field.key] = state;
      });
      return {
        shell: {
          available: Boolean(snapshot) && snapshot.status === "ready",
          writable: Boolean(snapshot) && snapshot.writable === true,
          dirty,
          invalid,
          saving,
          failed,
          failureReason,
        },
        fields,
        status,
        conflicts,
        graph,
        op,
      };
    }

    // Set by apply() once the page and surface controllers exist: a factory reset
    // from the settings card has to refresh them, and they are created after this
    // controller. A module-level hook keeps the wiring in one place.
    let onWipeHook = null;

    function createFormController(scope) {
      const listeners = new Set();
      const staged = new Map();
      let saving = false;
      let failed = false;
      let failureReason = "";
      let status = { loaded: false, ok: false, facts: 0, pending: 0, conflicts: 0, proposals: 0, semantic: null, extraction: null, dataDir: "", error: "" };
      let op = null;
      let conflicts = { loaded: false, groups: [] };
      // The graph loads lazily: it can be large and does not change on a timer.
      let graph = { loaded: false, entity: "", view: "current", nodes: [], edges: [], truncated: null, totals: null, error: "" };
      let state = projectionOf(scope, staged, saving, failed, failureReason, status, op, conflicts, graph);
      const publish = () => {
        state = projectionOf(scope, staged, saving, failed, failureReason, status, op, conflicts, graph);
        listeners.forEach((fn) => fn());
      };
      const fieldOf = (key) => FIELDS.find((field) => field.key === key);

      const post = (path, body, options) => {
        if (typeof fetch !== "function") return Promise.resolve({ ok: false, error: "no-fetch" });
        const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : NET_TIMEOUT_MS;
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        const init = {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
          credentials: "same-origin",
        };
        if (controller) init.signal = controller.signal;
        const timer = setTimeout(() => {
          if (controller) controller.abort();
        }, timeoutMs);
        return fetch(`/api/fact-memory/${path}`, init)
          .then((response) => {
            if (response.status === 401 || response.status === 404) return { ok: false, unavailable: true, error: `http-${response.status}` };
            return response.json().then((payload) => {
              if (!payload || typeof payload !== "object") return { ok: false, error: "bad-payload" };
              return payload;
            });
          })
          .catch((error) => ({ ok: false, error: String((error && error.message) || error) }))
          .finally(() => clearTimeout(timer));
      };

      const refreshConflicts = (open) => {
        if (!open) {
          conflicts = { loaded: true, groups: [] };
          publish();
          return Promise.resolve();
        }
        return post("conflicts", {}).then((payload) => {
          conflicts =
            payload && payload.ok
              ? { loaded: true, groups: Array.isArray(payload.groups) ? payload.groups : [] }
              : { loaded: true, groups: [], error: String(payload?.error || "unavailable") };
          publish();
        });
      };

      const refreshStatus = () =>
        post("status", {}).then((payload) => {
          if (payload && payload.ok) {
            status = {
              loaded: true,
              ok: true,
              // Total rows, the same number the page header shows. Live-only
              // counts are still visible on the page as a hint.
              facts: Number(payload.stats?.facts ?? 0),
              total: Number(payload.stats?.facts ?? 0),
              pending: Number(payload.stats?.pending ?? 0),
              conflicts: Number(payload.stats?.conflict ?? payload.stats?.conflicts ?? 0),
              proposals: Number(payload.proposals?.pending ?? 0),
              semantic: payload.semantic && typeof payload.semantic === "object" ? payload.semantic : null,
              extraction: payload.extraction && typeof payload.extraction === "object" ? payload.extraction : null,
              audit: payload.audit && typeof payload.audit === "object" ? payload.audit : null,
              review: payload.review && typeof payload.review === "object" ? payload.review : null,
              // Which credential slots are filled. Booleans and source names
              // only — the host never hands the secret back.
              keys: payload.keys && typeof payload.keys === "object" ? payload.keys : null,
              dataDir: String(payload.dataDir ?? ""),
              schema: Number(payload.schemaVersion ?? 0),
              generation: Number(payload.meta?.generation ?? 0),
              integrity: payload.integrity || { ok: true },
              error: "",
            };
          } else {
            status = {
              loaded: true,
              ok: false,
              facts: 0,
              total: 0,
              pending: 0,
              conflicts: 0,
              proposals: 0,
              semantic: null,
              extraction: null,
              dataDir: String(payload?.dataDir ?? ""),
              error: String(payload?.error || "unavailable"),
            };
          }
          publish();
          return refreshConflicts(status.ok && status.conflicts > 0);
        });

      const runOp = (kind, path, body, doneKey) => {
        if (op && op.status === "running") return Promise.resolve();
        op = { kind, status: "running" };
        publish();
        // Vector rebuilds, exports and wipes are server-side batches over the
        // whole store; the 8s default would abort a healthy run.
        // A duplicate sweep waits on up to `consolidateMaxPairs` model calls, so it
        // needs the long budget too — the 8s default would abort a healthy run.
        // The health check walks every live row and every entity pair locally, which
        // is fast but not free on a large library.
        const options =
          kind === "vectors" || kind === "export" || kind === "wipe" || kind === "dedup" || kind === "audit" ? { timeoutMs: 120000 } : undefined;
        return post(path, body, options).then((payload) => {
          if (payload && payload.ok) {
            const n =
              kind === "export"
                ? Number(payload.count ?? 0)
                : kind === "wipe"
                  ? Number(payload.facts ?? 0)
                  : kind === "dedup" || kind === "audit"
                    ? Number(payload.proposals ?? 0)
                    : Number(payload.indexed ?? 0);
            // A sweep that judged nothing must say why, or "0 proposals" reads as
            // "the button is broken" instead of "there was nothing to fold".
            const detail =
              kind === "dedup"
                ? {
                    result: String(payload.status ?? ""),
                    reason: String(payload.reason ?? ""),
                    pairs: Number(payload.pairs ?? 0),
                    judged: Number(payload.judged ?? 0),
                    same: Number(payload.same ?? 0),
                    distinct: Number(payload.distinct ?? 0),
                    unsure: Number(payload.unsure ?? 0),
                  }
                : kind === "audit"
                  ? {
                      result: String(payload.status ?? ""),
                      reason: String(payload.reason ?? ""),
                      findings: Number(payload.findings ?? 0),
                    }
                  : null;
            op = { kind, status: "done", count: n, path: String(payload.path ?? ""), detail };
          } else if (payload && payload.unavailable) {
            op = { kind, status: "failed", errorKey: "op.unavailable" };
          } else {
            op = { kind, status: "failed", error: String(payload?.error || "unknown") };
          }
          publish();
          // A factory reset stales every cached projection the other surfaces
          // hold (facts, graph, drawer, turn cards). Refreshing only this card's
          // counters is what left the graph tab drawing a library that was gone.
          if (kind === "wipe" && typeof onWipeHook === "function") onWipeHook();
          return refreshStatus();
        });
      };

      return {
        store: {
          getSnapshot: () => state,
          subscribe: (fn) => {
            listeners.add(fn);
            return () => listeners.delete(fn);
          },
        },
        refreshStatus,
        actions: {
          edit: (key, raw) => {
            const field = fieldOf(key);
            if (!field) return;
            staged.set(key, parseField(field, raw));
            failed = false;
            failureReason = "";
            publish();
          },
          resetField: (key) => {
            staged.delete(key);
            failed = false;
            failureReason = "";
            publish();
          },
          discard: () => {
            staged.clear();
            failed = false;
            failureReason = "";
            publish();
          },
          save: async () => {
            if (saving) return;
            const plan = [];
            let hasInvalid = false;
            staged.forEach((entry, key) => {
              if (entry.invalid) hasInvalid = true;
              else plan.push({ key, value: entry.value });
            });
            if (hasInvalid) {
              failed = true;
              failureReason = "invalid";
              publish();
              return;
            }
            saving = true;
            failureReason = "";
            publish();
            const results = [];
            for (const item of plan) {
              try {
                // set() resolves to whether the HOST accepted the write; a refused
                // write must not leave the card looking saved.
                results.push((await scope.set(item.key, item.value)) !== false);
              } catch {
                results.push(false);
              }
            }
            saving = false;
            failed = results.some((ok) => !ok);
            failureReason = failed ? "rejected" : "";
            if (!failed) staged.clear();
            publish();
            return refreshStatus();
          },
          exportNow: () => runOp("export", "export", {}),
          rebuildNow: () => runOp("rebuild", "rebuild", {}),
          indexVectorsNow: () => runOp("vectors", "index-vectors", {}),
          // One sweep of the near-duplicate review. It only files proposals, so
          // the button is safe to press without reading the diff first.
          dedupNow: () => runOp("dedup", "consolidate", { force: true }),
          // The health check only reads the library and files proposals, so it is
          // as safe to press as the dedupe sweep.
          auditNow: () => runOp("audit", "audit", { force: true }),
          // The one destructive action on the card. The confirm token travels in
          // the body, so only this exact click can trigger a wipe.
          wipeNow: () => runOp("wipe", "wipe", { confirm: "wipe" }),
          // Secrets live in the host credential store. The card never receives
          // the value back; it only re-reads whether the slot is configured.
          saveKey: (slot, value) =>
            post("key", { slot, value }).then((payload) => {
              const ok = Boolean(payload && payload.ok);
              if (ok) refreshStatus();
              return ok;
            }),
          clearKey: (slot) =>
            post("key", { slot, clear: true }).then((payload) => {
              const ok = Boolean(payload && payload.ok);
              if (ok) refreshStatus();
              return ok;
            }),
          // Load one entity's one-hop neighborhood. An empty entity asks the
          // host for the busiest entities, which is a useful landing view.
          loadGraph: (entity, view) => {
            const wanted = String(entity ?? "").trim();
            return post("graph", { entity: wanted, view: view === "all" ? "all" : "current", depth: 1, withFacts: true }).then((payload) => {
              if (payload && payload.ok) {
                graph = {
                  loaded: true,
                  entity: wanted,
                  view: payload.view === "all" ? "all" : "current",
                  nodes: Array.isArray(payload.nodes) ? payload.nodes : [],
                  edges: Array.isArray(payload.edges) ? payload.edges : [],
                  truncated: payload.truncated || null,
                  totals: payload.totals || null,
                  error: "",
                };
              } else {
                graph = {
                  loaded: true,
                  entity: wanted,
                  view: view === "all" ? "all" : "current",
                  nodes: [],
                  edges: [],
                  truncated: null,
                  totals: null,
                  error: String(payload?.error || "unavailable"),
                };
              }
              publish();
              return graph;
            });
          },
          // Accept a pending proposal. A stale proposal is refused by the host
          // and the card says so instead of showing a success line.
          applyProposal: (proposalId) => {
            if (op && op.status === "running") return Promise.resolve();
            op = { kind: "proposal", status: "running" };
            publish();
            return post("proposal-apply", { proposalId }).then((payload) => {
              if (payload && payload.ok) op = { kind: "proposal", status: "done", count: payload.written ? 1 : 0, factId: String(payload.factId ?? "") };
              else if (payload && payload.unavailable) op = { kind: "proposal", status: "failed", errorKey: "op.unavailable" };
              else if (payload && (payload.stale === true || payload.status === "stale")) op = { kind: "proposal", status: "failed", errorKey: "op.proposalStale", detail: String(payload.reason || payload.detail || "") };
              else op = { kind: "proposal", status: "failed", error: String(payload?.error || "unknown") };
              publish();
              return refreshStatus();
            });
          },
          rejectProposal: (proposalId) => {
            if (op && op.status === "running") return Promise.resolve();
            op = { kind: "proposalReject", status: "running" };
            publish();
            return post("proposal-reject", { proposalId, reason: "rejected_in_card" }).then((payload) => {
              if (payload && payload.ok) op = { kind: "proposalReject", status: "done" };
              else if (payload && payload.unavailable) op = { kind: "proposalReject", status: "failed", errorKey: "op.unavailable" };
              else op = { kind: "proposalReject", status: "failed", error: String(payload?.error || "unknown") };
              publish();
              return refreshStatus();
            });
          },
          // Settle one conflict by keeping the chosen row; the host retires the rest.
          resolveFact: (factId) => {
            if (op && op.status === "running") return Promise.resolve();
            op = { kind: "resolve", status: "running" };
            publish();
            return post("resolve", { factId }).then((payload) => {
              if (payload && payload.ok) op = { kind: "resolve", status: "done", count: Number(payload.superseded ?? 0) + 1 };
              else if (payload && payload.unavailable) op = { kind: "resolve", status: "failed", errorKey: "op.unavailable" };
              else op = { kind: "resolve", status: "failed", error: String(payload?.error || "unknown") };
              publish();
              return refreshStatus();
            });
          },
        },
      };
    }

    // ── rendering ──────────────────────────────────────────────────────────
    // Children go through props.children: these calls are the raw jsx-runtime
    // function form, whose third argument is the key, not children.

    function StatusLine(props) {
      const s = props.status;
      const t = props.t;
      if (!s.loaded) return jsx("p", { className: "FM_status", children: t("card.statusUnavailable") });
      if (!s.ok) {
        return jsx("p", { className: "FM_status FM_statusBad", children: t("card.statusUnavailable") + " · " + s.error });
      }
      // The header already carries the fact count; repeating it here made the
      // first pill read as a second, conflicting status.
      const pills = [];
      if (s.pending > 0) pills.push(t("card.statusPending", { n: s.pending }));
      if (s.conflicts > 0) pills.push(t("card.statusConflict", { n: s.conflicts }));
      if (s.proposals > 0) pills.push(t("status.proposals", { n: s.proposals }));
      // schema/generation are diagnosis, not something to decide on: they move
      // out of the pill row and read as one quiet line at the bottom.
      // Say plainly which retrieval channels are live. A user who configured an
      // embedding endpoint has to be able to see that it is (not) in play.
      const semantic = s.semantic;
      const semanticPill = semantic
        ? semantic.embeddingConfigured || semantic.rerankConfigured
          ? t("status.semantic", {
              vectors: Number(semantic.vectors ?? 0),
              rerank: semantic.rerankConfigured
                ? Number(semantic.calibrations ?? 0) > 0
                  ? t("status.rerankCalibrated")
                  : t("status.rerankUncalibrated")
                : t("status.off"),
            })
          : t("status.semanticOff")
        : null;
      if (semanticPill) pills.push(semanticPill);
      const extraction = s.extraction;
      if (extraction) {
        pills.push(
          extraction.enabled
            ? t("status.extraction", { state: t("status.on"), pending: Number(extraction.pending ?? 0) })
            : t("status.extractionOff"),
        );
      }
      return jsxs("div", {
        className: "FM_statusRow",
        children: [
          jsx("div", {
            className: "FM_pills",
            children: pills.map((text, index) => jsx("span", { className: "FM_pill", children: text }, String(index))),
          }),
          s.schema === undefined ? null : jsx("p", { className: "FM_fineprint", children: t("meta.fineprint", { v: s.schema, g: s.generation }) }),
          s.semantic && s.semantic.vectorIndex
            ? jsx("p", {
                className: "FM_fineprint",
                children: (() => {
                  const index = s.semantic.vectorIndex;
                  const ms = Number(index.intervalMs ?? 0);
                  if (!(ms > 0)) return t("meta.vectorManual");
                  const minutes = Math.max(1, Math.round(ms / 60000));
                  if (!index.lastAt) return t("meta.vectorWaiting", { m: minutes });
                  return t("meta.vectorAuto", {
                    m: minutes,
                    time: timeAgo(index.lastAt, t),
                    n: Number(index.lastIndexed ?? 0),
                  });
                })(),
              })
            : null,
          s.dataDir ? jsx("p", { className: "FM_path", title: s.dataDir, children: s.dataDir }) : null,
          s.integrity && s.integrity.ok === false
            ? jsx("p", {
                className: "FM_warn",
                children: t("integrity.bad", {
                  error: String((s.integrity.storeFindings ?? s.integrity.findings ?? []).join("; ") || s.integrity.error || "unknown"),
                }),
              })
            : null,
          s.integrity && s.integrity.ok !== false && s.integrity.indexOk === false
            ? jsx("p", { className: "FM_warn", children: t("integrity.index", { error: String((s.integrity.indexFindings ?? []).join("; ")) }) })
            : null,
        ],
      });
    }

    function ConflictSection(props) {
      const t = props.t;
      const groups = props.conflicts?.groups ?? [];
      if (groups.length === 0) return null;
      return jsxs("div", {
        className: "FM_group FM_conflicts",
        children: [
          jsx("p", { className: "FM_groupTitle", children: t("group.conflicts") }),
          jsx("p", { className: "FM_hint", children: t("hint.conflicts") }),
          groups.map((group) =>
            jsxs(
              "div",
              {
                className: "FM_conflict",
                children: [
                  jsx("p", {
                    className: "FM_conflictHead",
                    children: `${group.rows?.[0]?.entity ?? ""} · ${group.rows?.[0]?.predicate ?? ""}`,
                  }),
                  (group.rows ?? []).map((row) =>
                    jsxs(
                      "div",
                      {
                        className: "FM_conflictRow",
                        children: [
                          jsx("span", { className: "FM_conflictValue", children: row.value }),
                          jsx("span", {
                            className: "FM_conflictMeta",
                            children: `${String(row.observedAt ?? "").slice(0, 10)} · ${row.evidenceLevel ?? ""}`,
                          }),
                          jsx("button", {
                            className: "FM_secondary",
                            type: "button",
                            disabled: !props.ready,
                            onClick: () => props.resolveFact(row.factId),
                            children: t("conflict.keep"),
                          }),
                        ],
                      },
                      row.factId,
                    ),
                  ),
                ],
              },
              group.id,
            ),
          ),
        ],
      });
    }

    // A secret is typed here and stored in the host credential store; the card
    // only ever learns whether it is configured, never the value itself.
    function KeyRow(props) {
      const { slot, refName, info, t, writable } = props;
      const [draft, setDraft] = react.useState("");
      const [busy, setBusy] = react.useState(false);
      const [note, setNote] = react.useState("");
      const configured = info && info.configured === true;
      const source = info && info.source ? String(info.source) : "none";
      const sourceText =
        source === "file" ? t("key.sourceFile") : source === "env" ? t("key.sourceEnv") : source === "dotenv" ? t("key.sourceDotenv") : t("key.sourceNone");
      const save = async () => {
        if (draft.trim() === "") return;
        setBusy(true);
        setNote("");
        try {
          const ok = await props.saveKey(slot, draft.trim());
          setNote(ok ? t("key.saved") : t("key.failed"));
          if (ok) setDraft("");
        } finally {
          setBusy(false);
        }
      };
      const clear = async () => {
        setBusy(true);
        setNote("");
        try {
          const ok = await props.clearKey(slot);
          setNote(ok ? t("key.cleared") : t("key.failed"));
        } finally {
          setBusy(false);
        }
      };
      return jsxs("div", {
        className: "FM_keyRow",
        children: [
          jsxs("div", {
            className: "FM_keyHead",
            children: [
              jsx("span", { className: "FM_keyTitle", children: t(`key.title.${slot}`) }),
              jsx("span", { className: configured ? "FM_pill FM_pillOn" : "FM_pill", children: sourceText }),
              jsx("span", { className: "FM_keyRef", children: refName || t("key.noRef") }),
            ],
          }),
          jsxs("div", {
            className: "FM_keyInputRow",
            children: [
              jsx("input", {
                className: "FM_input FM_keyInput",
                type: "password",
                autoComplete: "off",
                placeholder: configured ? t("key.replaceHint") : t("key.placeholder"),
                value: draft,
                disabled: busy || writable === false,
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === "Enter") save();
                },
              }),
              jsx("button", { className: "FM_secondary", type: "button", disabled: busy || writable === false || draft.trim() === "", onClick: save, children: t("key.save") }),
              configured
                ? jsx("button", { className: "FM_secondary", type: "button", disabled: busy || writable === false, onClick: clear, children: t("key.clear") })
                : null,
            ],
          }),
          note ? jsx("p", { className: "FM_hint", children: note }) : null,
        ],
      });
    }

    function FieldRow(props) {
      const field = props.field;
      const state = props.value;
      const t = props.t;
      const disabled = !props.writable;
      // Text and number inputs keep what the user typed. Bound straight to the
      // store, a controlled input snaps back on every partial value ("8" while
      // typing 800 is below the minimum), which reads as "the keyboard is dead".
      const [draft, setDraft] = react.useState(null);
      const shown =
        draft !== null
          ? draft
          : state.value === undefined || state.value === null
            ? ""
            : String(state.value);
      react.useEffect(() => {
        if (draft !== null && String(state.value ?? "") === draft) setDraft(null);
      }, [state.value, draft]);
      let control;
      if (field.type === "bool") {
        control = jsx("input", {
          id: `fm-${field.key}`,
          type: "checkbox",
          className: "FM_check",
          checked: state.value === true,
          disabled,
          onChange: (event) => props.edit(field.key, event.target.checked),
        });
      } else if (field.type === "enum") {
        // Segmented buttons, matching the host's own enum controls: every
        // option stays visible, so nobody has to discover a dropdown.
        control = jsx("div", {
          className: "FM_seg",
          role: "group",
          children: field.options.map((option) =>
            jsx(
              "button",
              {
                key: option,
                type: "button",
                className: state.value === option ? "FM_segBtn FM_segOn" : "FM_segBtn",
                "aria-pressed": state.value === option,
                disabled,
                onClick: () => props.edit(field.key, option),
                children: t(`option.${field.key}.${option}`),
              },
              option,
            ),
          ),
        });
      } else {
        control = jsx("input", {
          id: `fm-${field.key}`,
          type: field.type === "number" ? "number" : "text",
          className: state.invalid ? "FM_input FM_inputBad" : "FM_input",
          value: shown,
          min: field.type === "number" ? field.min : undefined,
          max: field.type === "number" ? field.max : undefined,
          step: field.type === "number" ? field.step : undefined,
          inputMode: field.type === "number" ? "decimal" : undefined,
          placeholder:
            field.key === "dataDir"
              ? props.dataDir || "<DSH_HOME>/fact-memory"
              : field.key === "storeTimezone"
                ? "Asia/Shanghai"
                : "",
          disabled,
          onFocus: (event) => event.target.select(),
          onChange: (event) => {
            setDraft(event.target.value);
            props.edit(field.key, event.target.value);
          },
          onBlur: () => setDraft(null),
        });
      }
      return jsxs("div", {
        className: field.type === "bool" ? "FM_row FM_rowInline" : "FM_row",
        children: [
          jsxs("div", {
            className: "FM_rowHead",
            children: [
              jsx("label", { className: "FM_label", htmlFor: `fm-${field.key}`, children: t(`field.${field.key}`) }),
              state.overridden ? jsx("span", { className: "FM_badge", children: t("overridden") }) : null,
              state.overridden
                ? jsx("button", {
                    className: "FM_reset",
                    type: "button",
                    disabled,
                    onClick: () => {
                      setDraft(null);
                      props.resetField(field.key);
                    },
                    children: "↺ " + t("reset"),
                  })
                : null,
            ],
          }),
          control,
          field.unit === "ms" && !state.invalid
            ? jsx("p", { className: "FM_unit", children: durationText(t, state.value) })
            : null,
          field.type === "number" && state.invalid
            ? jsx("p", { className: "FM_invalid", children: t("field.invalidRange", { min: field.min, max: field.max }) })
            : null,
          jsx("p", { className: "FM_hint", children: t(`hint.${field.key}`) }),
        ],
      });
    }

    // Tuning knobs (budgets, timeouts, backup rotation, the duplicate check) live
    // behind one native disclosure: the card opens short, and the fields stay
    // mounted so a draft survives a remount and the keyboard reaches them the
    // moment it unfolds. `<details>` also means no JavaScript state to lose.
    function AdvancedFields(props) {
      const t = props.t;
      const fields = FIELDS.filter((field) => field.group === "advanced");
      const overridden = fields.filter((field) => props.values[field.key] && props.values[field.key].overridden).length;
      return jsxs("details", {
        className: "FM_adv",
        children: [
          jsxs("summary", {
            className: "FM_advSummary",
            children: [
              jsx("span", { className: "FM_advArrow", "aria-hidden": "true", children: "▸" }),
              jsx("span", { className: "FM_groupTitle FM_advTitle", children: t("group.advanced") }),
              overridden > 0 ? jsx("span", { className: "FM_badge", children: t("overriddenN", { n: overridden }) }) : null,
            ],
          }),
          jsx("p", { className: "FM_hint FM_advHint", children: t("group.advancedHint") }),
          fields.map((field) =>
            jsx(
              FieldRow,
              {
                field,
                value: props.values[field.key],
                t,
                dataDir: props.dataDir,
                writable: props.writable,
                edit: props.edit,
                resetField: props.resetField,
              },
              field.key,
            ),
          ),
        ],
      });
    }

    function GraphSection(props) {
      const t = props.t;
      const graph = props.graph ?? { loaded: false, edges: [] };
      const [entity, setEntity] = react.useState("");
      const [view, setView] = react.useState(graph.view === "all" ? "all" : "current");
      const edges = graph.edges ?? [];
      // Edges name their endpoints by node id; the labels live on the nodes.
      const labels = {};
      for (const node of graph.nodes ?? []) labels[node.id] = node.label;
      const label = (id) => labels[id] ?? String(id ?? "");
      return jsxs("div", {
        className: "FM_group FM_graph",
        children: [
          jsx("p", { className: "FM_groupTitle", children: t("group.graph") }),
          jsx("p", { className: "FM_hint", children: t("graph.hint") }),
          jsxs("div", {
            className: "FM_graphBar",
            children: [
              jsx("input", {
                className: "FM_input FM_graphInput",
                type: "text",
                value: entity,
                placeholder: t("graph.placeholder"),
                disabled: !props.ready,
                onChange: (event) => setEntity(event.target.value),
              }),
              jsx("button", {
                className: "FM_secondary",
                type: "button",
                disabled: !props.ready,
                onClick: () => props.loadGraph(entity, view),
                children: t("graph.load"),
              }),
              jsx("button", {
                className: view === "all" ? "FM_secondary FM_segOn" : "FM_secondary",
                type: "button",
                disabled: !props.ready,
                onClick: () => {
                  const next = view === "all" ? "current" : "all";
                  setView(next);
                  props.loadGraph(entity, next);
                },
                children: t("graph.all"),
              }),
            ],
          }),
          graph.loaded && edges.length === 0
            ? jsx("p", { className: "FM_hint", children: graph.error ? graph.error : t("graph.empty") })
            : null,
          edges.map((edge) =>
            jsxs(
              "div",
              {
                className: "FM_edge",
                children: [
                  jsxs("p", {
                    className: "FM_edgeHead",
                    children: [
                      jsx("span", { className: "FM_node", children: label(edge.source) }),
                      jsx("span", { className: "FM_edgePred", children: String(edge.predicate ?? "") + " →" }),
                      jsx("span", { className: "FM_node", children: label(edge.target) }),
                      edge.confirmed === false ? jsx("span", { className: "FM_badge", children: t("graph.contested") }) : null,
                    ],
                  }),
                  (edge.facts ?? []).map((fact) =>
                    jsx(
                      "p",
                      {
                        className: "FM_edgeFact",
                        children: `${String(fact.entity ?? fact.entity_name ?? "")} · ${String(fact.predicate ?? "")}: ${String(fact.value ?? fact.value_text ?? "")}`,
                      },
                      String(fact.id ?? fact.entity + fact.predicate),
                    ),
                  ),
                  (edge.facts ?? []).length > 0
                    ? jsx("p", { className: "FM_hint", children: t("graph.edgeFacts", { n: edge.facts.length }) })
                    : null,
                ],
              },
              `${edge.source}|${edge.predicate}|${edge.target}`,
            ),
          ),
          graph.truncated && (graph.truncated.nodes || graph.truncated.edges)
            ? jsx("p", {
                className: "FM_warn",
                children: t("graph.truncated", { nodes: Number(graph.truncated.nodes ?? 0), edges: Number(graph.truncated.edges ?? 0) }),
              })
            : null,
        ],
      });
    }

    function FactMemoryCard(props) {
      const t = props.t;
      const state = props.useFactMemory((snapshot) => snapshot);
      // Two-step confirm: the first click only arms the button, the second one
      // wipes. Nothing is destroyed by a single stray click.
      const [wipeArmed, setWipeArmed] = react.useState(false);
      useEffect(() => {
        if (typeof setInterval !== "function") return undefined;
        if (typeof props.refresh === "function") props.refresh();
        const timer = setInterval(() => props.refresh && props.refresh(), 15_000);
        // Never hold the process open (the test runner and a one-off CLI share this code).
        if (timer && typeof timer.unref === "function") timer.unref();
        return () => clearInterval(timer);
      }, []);
      if (props.view === "summary") return t("card.description");
      const shell = state.shell;
      const blocked = !shell.dirty || shell.invalid || shell.saving;
      const op = state.op;
      let opText = null;
      if (op && op.status === "running") {
        opText = t(
          op.kind === "export"
            ? "op.exportRunning"
            : op.kind === "resolve"
              ? "op.resolveRunning"
              : op.kind === "vectors"
                ? "op.vectorRunning"
                : op.kind === "proposal"
                  ? "op.proposalRunning"
                  : op.kind === "proposalReject"
                    ? "op.proposalRejectRunning"
                    : op.kind === "wipe"
                      ? "op.wipeRunning"
                      : op.kind === "dedup"
                        ? "op.dedupRunning"
                        : op.kind === "audit"
                          ? "op.auditRunning"
                          : "op.rebuildRunning",
        );
      }
      if (op && op.status === "done") {
        opText =
          op.kind === "export"
            ? t("op.exportDone", { n: op.count, path: op.path })
            : op.kind === "resolve"
              ? t("op.resolveDone", { n: Math.max(0, op.count - 1) })
              : op.kind === "vectors"
                ? t("op.vectorDone", { n: op.count })
                : op.kind === "proposal"
                  ? (op.factId
                      ? t("op.proposalDone", { id: String(op.factId).slice(0, 8) })
                      : t("op.proposalApplied")) +
                    (op.skippedStale > 0 ? " " + t("op.proposalSkipped", { n: op.skippedStale }) : "")
                  : op.kind === "proposalReject"
                    ? t("op.proposalRejected")
                    : op.kind === "wipe"
                      ? t("op.wipeDone", { n: op.count })
                      : op.kind === "dedup"
                        ? op.detail && op.detail.result === "skipped"
                          ? t("op.dedupSkipped", { reason: t(`op.dedupReason.${op.detail.reason || "unknown"}`) })
                          : t("op.dedupDone", {
                              pairs: op.detail?.pairs ?? 0,
                              judged: op.detail?.judged ?? 0,
                              same: op.detail?.same ?? 0,
                              distinct: op.detail?.distinct ?? 0,
                              n: op.count,
                            })
                        : op.kind === "audit"
                          ? op.detail && op.detail.result === "skipped"
                            ? t("op.auditSkipped", { reason: t(`op.auditReason.${op.detail.reason || "unknown"}`) })
                            : (op.detail?.findings ?? 0) > 0
                              ? t("op.auditDone", { findings: op.detail?.findings ?? 0, n: op.count })
                              : t("op.auditClean")
                          : t("op.rebuildDone", { n: op.count });
      }
      if (op && op.status === "failed") {
        opText = op.errorKey ? t(op.errorKey, { reason: String(op.detail ?? "") }) : t("op.failed", { error: op.error });
      }
      return jsxs("div", {
        className: shell.dirty ? "FM_card FM_cardOpen" : "FM_card",
        children: [
          jsxs("div", {
            className: "FM_header",
            children: [
              jsxs("div", {
                className: "FM_headText",
                children: [
                  jsx("span", { className: "FM_name", children: t("card.title") }),
                  jsx("span", { className: "FM_description", children: t("card.description") }),
                ],
              }),
              jsx("span", {
                className: shell.dirty ? "FM_pill FM_pillWarn" : "FM_pill",
                children: shell.dirty ? t("unsaved") : t("card.statusFacts", { n: state.status.facts }),
              }),
            ],
          }),
          jsxs("div", {
            className: "FM_body",
            children: [
              shell.writable ? null : jsx("p", { className: "FM_readOnly", children: t("readOnly") }),
              jsx(StatusLine, { status: state.status, t }),
              jsx(ConflictSection, {
                conflicts: state.conflicts,
                t,
                ready: state.status.ok && !(state.op && state.op.status === "running"),
                resolveFact: props.resolveFact,
              }),
              GROUPS.map((group) =>
                jsxs(
                  "div",
                  {
                    className: "FM_group",
                    children: [
                      jsx("p", { className: "FM_groupTitle", children: t(`group.${group}`) }),
                      FIELDS.filter((field) => field.group === group).flatMap((field) => {
                        const row = jsx(
                          FieldRow,
                          {
                            field,
                            value: state.fields[field.key],
                            t,
                            dataDir: state.status.dataDir,
                            writable: shell.writable,
                            edit: props.edit,
                            resetField: props.resetField,
                          },
                          field.key,
                        );
                        const slot = field.key === "embeddingApiKeyEnv" ? "embedding" : field.key === "rerankApiKeyEnv" ? "rerank" : field.key === "llmApiKeyEnv" ? "llm" : null;
                        if (!slot) return [row];
                        return [
                          row,
                          jsx(
                            KeyRow,
                            {
                              key: `key-${slot}`,
                              slot,
                              refName: state.fields[field.key] ? state.fields[field.key].value : "",
                              info: state.status.keys ? state.status.keys[slot] : null,
                              t,
                              writable: shell.writable,
                              saveKey: props.saveKey,
                              clearKey: props.clearKey,
                            },
                          ),
                        ];
                      }),
                    ],
                  },
                  group,
                ),
              ),
              jsx(AdvancedFields, {
                values: state.fields,
                t,
                writable: shell.writable,
                dataDir: state.status.dataDir,
                edit: props.edit,
                resetField: props.resetField,
              }),
              jsx(GraphSection, {
                graph: state.graph,
                t,
                ready: state.status.ok,
                loadGraph: props.loadGraph,
              }),
              jsxs("div", {
                className: "FM_actions",
                children: [
                  jsx("button", { className: "FM_secondary", type: "button", disabled: !state.status.ok, onClick: () => props.exportNow(), children: t("action.export") }),
                  jsx("button", { className: "FM_secondary", type: "button", disabled: !state.status.ok, onClick: () => props.rebuildNow(), children: t("action.rebuild") }),
                  state.status.semantic && state.status.semantic.embeddingConfigured
                    ? jsx("button", { className: "FM_secondary", type: "button", disabled: !state.status.ok, onClick: () => props.indexVectorsNow(), children: t("action.indexVectors") })
                    : null,
                  jsx("button", { className: "FM_secondary", type: "button", disabled: !state.status.ok, onClick: () => props.dedupNow(), children: t("action.dedup") }),
                  jsx("button", { className: "FM_secondary", type: "button", disabled: !state.status.ok, onClick: () => props.auditNow(), children: t("action.audit") }),
                  wipeArmed
                    ? jsxs("span", {
                        className: "FM_dangerRow",
                        children: [
                          jsx("button", {
                            className: "FM_danger",
                            type: "button",
                            disabled: !state.status.ok,
                            onClick: () => {
                              setWipeArmed(false);
                              props.wipeNow();
                            },
                            children: t("action.wipeConfirm"),
                          }),
                          jsx("button", { className: "FM_secondary", type: "button", onClick: () => setWipeArmed(false), children: t("action.cancel") }),
                        ],
                      })
                    : jsx("button", {
                        className: "FM_secondary FM_dangerText",
                        type: "button",
                        disabled: !state.status.ok,
                        onClick: () => setWipeArmed(true),
                        children: t("action.wipe"),
                      }),
                  jsx("p", { className: "FM_hint FM_wipeHint", children: t("action.wipeHint") }),
                  opText ? jsx("p", { className: op && op.status === "failed" ? "FM_op FM_opBad" : "FM_op", children: opText }) : null,
                ],
              }),
              jsxs("div", {
                className: "FM_footer",
                children: [
                  shell.failed
                    ? jsx("p", {
                        className: "FM_failed",
                        children: shell.failureReason === "invalid" ? t("saveFailed") : t("saveRejected"),
                      })
                    : null,
                  jsx("p", { className: "FM_applyHint", children: t("applyHint") }),
                  jsx("button", { className: "FM_secondary", type: "button", disabled: (!shell.dirty && !shell.failed) || shell.saving, onClick: () => props.discard(), children: t("discard") }),
                  jsx("button", { className: "FM_primary", type: "button", disabled: blocked, onClick: () => props.save(), children: shell.saving ? t("saving") : t("save") }),
                ],
              }),
            ],
          }),
        ],
      });
    }

    // ── styles (official plugin-card look, FM_ prefix to avoid collisions) ──
    const css =
      ".FM_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}" +
      ".FM_card:hover{border-color:var(--dsw-alias-label-dimmed)}.FM_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}" +
      ".FM_header{align-items:center;gap:12px;padding:14px 16px;display:flex}" +
      ".FM_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}" +
      ".FM_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}" +
      ".FM_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}" +
      ".FM_pill{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}" +
      ".FM_pillWarn{color:var(--dsw-alias-label-primary)}" +
      ".FM_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}" +
      ".FM_readOnly{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}" +
      ".FM_statusRow{padding:12px 0 4px;display:flex;flex-direction:column;gap:6px}" +
      ".FM_pills{align-items:center;gap:6px;display:flex;flex-wrap:wrap}" +
      ".FM_status{color:var(--dsw-alias-label-tertiary);margin:12px 0 0;font-size:12px;line-height:1.5}" +
      ".FM_statusBad{color:var(--dsw-alias-label-error)}" +
      ".FM_path{color:var(--dsw-alias-label-tertiary);margin:0;font-size:11px;line-height:1.5;word-break:break-all}" +
      ".FM_warn{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}" +
      ".FM_group{padding-top:8px}" +
      ".FM_groupTitle{color:var(--dsw-alias-label-secondary);margin:10px 0 2px;font-size:12px;font-weight:600;line-height:1.5}" +
      ".FM_adv{margin-top:2px}" +
      ".FM_advSummary{display:flex;align-items:center;gap:6px;margin:10px 0 2px;cursor:pointer;list-style:none}" +
      ".FM_advSummary::-webkit-details-marker{display:none}" +
      ".FM_advSummary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:4px}" +
      ".FM_advArrow{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1;transition:transform .16s}" +
      ".FM_adv[open] .FM_advArrow{transform:rotate(90deg)}" +
      ".FM_advTitle{margin:0}" +
      ".FM_advHint{margin:4px 0 0}" +
      ".FM_adv[open] .FM_advHint{display:none}" +
      ".FM_unit{color:var(--dsw-alias-label-tertiary);margin:2px 0 0;font-size:12px;line-height:1.5}" +
      ".FM_row{flex-direction:column;gap:6px;padding:12px 0;display:flex}.FM_row+.FM_row{border-top:1px solid var(--dsw-alias-border-l2)}" +
      ".FM_rowInline{flex-direction:row;align-items:center;flex-wrap:wrap}" +
      ".FM_rowInline .FM_hint{flex-basis:100%;margin:0}" +
      ".FM_conflicts{border-top:1px solid var(--dsw-alias-border-l2)}" +
      ".FM_seg{display:flex;background:var(--dsw-alias-bg-module-platform);border-radius:8px;padding:2px;gap:2px;align-self:flex-start}" +
      ".FM_segBtn{appearance:none;font:inherit;cursor:pointer;background:0 0;border:none;border-radius:6px;color:var(--dsw-alias-label-secondary);padding:3px 10px;font-size:12px;line-height:1.5}" +
      ".FM_segOn{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-weight:500}" +
      ".FM_segBtn:disabled{opacity:.4;cursor:default}" +
      ".FM_graph{border-top:1px solid var(--dsw-alias-border-l2)}" +
      ".FM_graphBar{align-items:center;gap:8px;display:flex;flex-wrap:wrap;padding:8px 0}" +
      ".FM_graphInput{flex:1;min-width:160px}" +
      ".FM_edge{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 12px;margin:6px 0;display:flex;flex-direction:column;gap:4px}" +
      ".FM_edgeHead{align-items:center;gap:6px;margin:0;display:flex;flex-wrap:wrap;font-size:13px;line-height:1.5}" +
      ".FM_node{color:var(--dsw-alias-label-primary);font-weight:500;word-break:break-all}" +
      ".FM_edgePred{color:var(--dsw-alias-label-tertiary);font-size:12px}" +
      ".FM_edgeFact{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:1.5;word-break:break-all}" +
      ".FM_conflict{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;margin:8px 0;display:flex;flex-direction:column;gap:8px}" +
      ".FM_conflictHead{color:var(--dsw-alias-label-primary);margin:0;font-size:13px;font-weight:600;line-height:1.5}" +
      ".FM_conflictRow{align-items:center;gap:8px;display:flex;flex-wrap:wrap}" +
      ".FM_conflictValue{color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;word-break:break-all;flex:1;min-width:0}" +
      ".FM_conflictMeta{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;white-space:nowrap}" +
      ".FM_rowHead{align-items:center;gap:8px;display:flex}" +
      ".FM_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}" +
      ".FM_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}" +
      ".FM_reset{font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;padding:0;font-size:12px;line-height:1.5}" +
      ".FM_input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}" +
      ".FM_input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}" +
      ".FM_check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}" +
      ".FM_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}" +
      ".FM_inputBad{border-color:var(--dsw-alias-status-danger,#d34a4a)}" +
      ".FM_invalid{color:var(--dsw-alias-status-danger,#d34a4a);margin:6px 0 0;font-size:12px}" +
      ".FM_keyRow{margin:-4px 0 14px;padding:12px 14px;border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-secondary,rgba(0,0,0,.03));border:1px solid var(--dsw-alias-border-subtle,rgba(0,0,0,.06))}" +
      ".FM_keyHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}" +
      ".FM_keyTitle{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".FM_keyRef{font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_keyInputRow{display:flex;gap:8px;align-items:center}" +
      ".FM_keyInput{flex:1 1 auto;min-width:0}" +
      ".FM_actions{align-items:center;gap:8px;padding:10px 0;display:flex;flex-wrap:wrap;border-top:1px solid var(--dsw-alias-border-l2)}" +
      ".FM_op{color:var(--dsw-alias-label-secondary);margin:0;font-size:12px;line-height:1.5;min-width:0;overflow:hidden;text-overflow:ellipsis}" +
      ".FM_opBad{color:var(--dsw-alias-label-error)}" +
      ".FM_footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}" +
      ".FM_failed{min-width:0;color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:1.5}" +
      ".FM_applyHint{min-width:0;color:var(--dsw-alias-label-tertiary);flex:1;margin:0;font-size:11px;line-height:1.5}" +
      ".FM_primary,.FM_secondary{appearance:none;font:inherit;cursor:pointer;border:1px solid #0000;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}" +
      ".FM_primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}" +
      ".FM_secondary{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}" +
      ".FM_secondary:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}" +
      ".FM_primary:disabled,.FM_secondary:disabled{opacity:.4;cursor:default}" +
      ".FM_dangerRow{align-items:center;gap:8px;display:flex;flex-wrap:wrap}" +
      ".FM_dangerText{color:var(--dsw-alias-status-danger,#d34a4a)}" +
      ".FM_danger{appearance:none;font:inherit;cursor:pointer;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;border:1px solid var(--dsw-alias-status-danger,#d34a4a);background:var(--dsw-alias-status-danger,#d34a4a);color:#fff}" +
      ".FM_danger:disabled{opacity:.4;cursor:default}" +
      ".FM_wipeHint{flex-basis:100%;margin:0}" +
      "@media (prefers-reduced-motion:reduce){.FM_card{transition:none}";

    const tagId = "dsh-fact-memory/settings.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-fact-memory";
      tag.dataset.pluginCss = tagId;
      tag.textContent = css;
      document.head.appendChild(tag);
    }


    // ── page styles: one surface, four views, no dependency on host classes ──
    const pageCss =
      ".FM_pg{position:relative;height:100%;min-height:0;box-sizing:border-box;padding:24px 28px 18px;display:flex;flex-direction:column;gap:16px;color:var(--dsw-alias-label-primary);background:radial-gradient(900px 420px at 8% -12%,rgba(94,124,255,.10),transparent 62%),var(--dsw-alias-bg-base);font-family:var(--dsw-font-family);overflow:hidden}" +
      ".FM_pgHead{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}" +
      ".FM_pgHeadMain{display:flex;align-items:center;gap:12px;min-width:0}" +
      ".FM_pgBrand{width:38px;height:38px;flex:none;border-radius:11px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-primary);background:linear-gradient(150deg,rgba(94,124,255,.22),rgba(94,124,255,.04));border:1px solid var(--dsw-alias-border-l2)}" +
      ".FM_pgTitle{margin:0;font-size:19px;font-weight:600;line-height:1.35;letter-spacing:.2px}" +
      ".FM_pgSubtitle{margin:3px 0 0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgInlinePill{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 8px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}" +
      ".FM_pgHeadActions{display:flex;align-items:center;gap:8px;flex:1;justify-content:flex-end;min-width:240px}" +
      ".FM_pgSearch{display:flex;align-items:center;gap:8px;height:34px;padding:0 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);min-width:240px;flex:0 1 360px;transition:border-color .16s,box-shadow .16s}" +
      ".FM_pgSearch:focus-within{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px rgba(94,124,255,.14)}" +
      ".FM_pgSearchGrow{flex:1 1 260px}" +
      ".FM_pgSearchInput{appearance:none;border:none;background:0 0;outline:none;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);width:100%;min-width:0}" +
      ".FM_pgSearchInput::placeholder{color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgIconBtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);width:32px;height:32px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:color .16s,border-color .16s,background .16s}" +
      ".FM_pgIconBtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2)}" +
      ".FM_pgStats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}" +
      ".FM_pgStat{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:2px;background:linear-gradient(180deg,var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-2));min-width:0}" +
      ".FM_pgStatLabel{font-size:11px;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgStatValue{font-size:22px;font-weight:600;line-height:1.3;font-variant-numeric:tabular-nums}" +
      ".FM_pgStatHint{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".FM_pgTone_warn{color:var(--dsw-alias-state-warn-label,#b8860b)}.FM_pgTone_danger{color:var(--dsw-alias-label-error)}" +
      ".FM_pgStatFoot{display:flex;align-items:center;gap:6px;justify-content:space-between}" +
      ".FM_pgMiniBtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:0 0;font:inherit;font-size:10px;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:1px 7px;cursor:pointer;white-space:nowrap}" +
      ".FM_pgMiniBtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}" +
      ".FM_pgTabs{display:flex;align-items:center;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:0}" +
      ".FM_pgTab{appearance:none;border:none;background:0 0;font:inherit;font-size:13px;color:var(--dsw-alias-label-tertiary);display:inline-flex;align-items:center;gap:7px;padding:9px 12px 10px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .16s,border-color .16s}" +
      ".FM_pgTab:hover{color:var(--dsw-alias-label-primary)}" +
      ".FM_pgTabOn{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:500}" +
      ".FM_pgTabCount{font-size:11px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}" +
      ".FM_pgBody{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr);gap:16px}" +
      ".FM_pgBodySplit{grid-template-columns:minmax(0,1fr) 360px}" +
      ".FM_pgMain{min-height:0;overflow:auto;padding-right:2px}" +
      ".FM_pgFacts{display:flex;flex-direction:column;gap:12px}" +
      ".FM_pgChips{display:flex;gap:6px;flex-wrap:wrap}" +
      ".FM_pgChip{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;border-radius:999px;padding:3px 11px;cursor:pointer;transition:color .16s,border-color .16s,background .16s}" +
      ".FM_pgChip:hover{color:var(--dsw-alias-label-primary)}" +
      ".FM_pgChipOn{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2)}" +
      ".FM_pgFactList{display:flex;flex-direction:column;gap:8px}" +
      ".FM_pgFact{border:1px solid var(--dsw-alias-border-l2);border-radius:11px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1);cursor:pointer;transition:transform .14s,border-color .14s,background .14s,box-shadow .14s;display:flex;flex-direction:column;gap:6px}" +
      ".FM_pgFact:hover{transform:translateY(-1px);border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2);box-shadow:0 6px 18px rgba(0,0,0,.10)}" +
      ".FM_pgFactOn{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}" +
      ".FM_pgFactTop{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}" +
      ".FM_pgEntity{appearance:none;border:none;background:0 0;padding:0;font:inherit;font-size:12px;font-weight:600;letter-spacing:.2px;color:var(--dsw-alias-label-primary);cursor:pointer;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".FM_pgEntity:hover{text-decoration:underline}" +
      ".FM_pgEntityLg{font-size:17px;font-weight:600}" +
      ".FM_pgSep{color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgPred{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgValue{margin:0;font-size:14px;line-height:1.5;color:var(--dsw-alias-label-primary);word-break:break-word}" +
      ".FM_pgValueSm{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);word-break:break-word}" +
      ".FM_pgMeta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgDot{width:3px;height:3px;border-radius:50%;background:var(--dsw-alias-label-tertiary);opacity:.6;display:inline-block}" +
      ".FM_pgDot_ok{background:var(--dsw-alias-state-success-primary,#3ba55d);opacity:1}.FM_pgDot_danger{background:var(--dsw-alias-label-error);opacity:1}.FM_pgDot_muted{opacity:.5}" +
      ".FM_pgId{font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace)}" +
      ".FM_pgSources{color:var(--dsw-alias-label-secondary)}" +
      ".FM_pgPill{font-size:11px;line-height:18px;padding:0 8px;border-radius:999px;border:1px solid transparent;white-space:nowrap}" +
      ".FM_pgPill_ok{color:var(--dsw-alias-state-success-primary,#3ba55d);background:rgba(59,165,93,.12)}" +
      ".FM_pgPill_warn{color:var(--dsw-alias-state-warn-label,#b8860b);background:rgba(218,165,32,.14)}" +
      ".FM_pgPill_danger{color:var(--dsw-alias-label-error);background:rgba(220,80,80,.12)}" +
      ".FM_pgPill_muted{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-platform)}" +
      ".FM_pgEmpty{border:1px dashed var(--dsw-alias-border-l2);border-radius:14px;padding:38px 24px;display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;background:var(--dsw-alias-bg-layer-1)}" +
      ".FM_pgEmptyIcon{width:44px;height:44px;border-radius:12px;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2)}" +
      ".FM_pgEmptyTitle{margin:0;font-size:14px;font-weight:500}" +
      ".FM_pgEmptyHint{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);max-width:420px}" +
      ".FM_pgMuted{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgOp{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}.FM_pgOpBad{color:var(--dsw-alias-label-error)}" +
      ".FM_pgPrimary,.FM_pgGhost{appearance:none;font:inherit;font-size:12.5px;border-radius:9px;padding:6px 13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;border:1px solid transparent;transition:background .16s,color .16s,border-color .16s}" +
      ".FM_pgPrimary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base)}" +
      ".FM_pgPrimary:hover:not(:disabled){opacity:.88}" +
      ".FM_pgPrimary:disabled{opacity:.4;cursor:default}" +
      ".FM_pgGhost{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}" +
      ".FM_pgGhost:hover{border-color:var(--dsw-alias-label-dimmed);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}" +
      ".FM_pgDanger{color:var(--dsw-alias-label-error)}.FM_pgDanger:hover{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-label-error);background:rgba(220,80,80,.08)}" +
      ".FM_pgRail{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:16px;background:var(--dsw-alias-bg-layer-1);overflow:auto;display:flex;flex-direction:column;gap:12px;min-height:0}" +
      ".FM_pgRailHead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}" +
      ".FM_pgRailTitle{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}" +
      ".FM_pgRailValueRow{display:flex;align-items:center;gap:8px;justify-content:space-between}" +
      ".FM_pgRailPills{display:flex;gap:6px;align-items:center;flex-wrap:wrap}" +
      ".FM_pgRailValue{margin:0;font-size:17px;line-height:1.45;font-weight:500;word-break:break-word}" +
      ".FM_pgRailActions{display:flex;gap:8px;flex-wrap:wrap}" +
      ".FM_pgRailSection{border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px;display:flex;flex-direction:column;gap:8px}" +
      ".FM_pgRailLabel{margin:0;font-size:11px;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgMetaList{margin:0;display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:12px}" +
      ".FM_pgMetaList dt{color:var(--dsw-alias-label-tertiary);white-space:nowrap}" +
      ".FM_pgMetaList dd{margin:0;color:var(--dsw-alias-label-primary);word-break:break-word}" +
      ".FM_pgSourceList,.FM_pgTimeline{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}" +
      ".FM_pgSourceList li{display:flex;flex-direction:column;gap:2px;font-size:12px;border-left:2px solid var(--dsw-alias-border-l2);padding-left:8px}" +
      ".FM_pgSourceKind{color:var(--dsw-alias-label-secondary);font-weight:500}" +
      ".FM_pgSourceQuote{color:var(--dsw-alias-label-tertiary);word-break:break-word}" +
      ".FM_pgTimeline li{display:flex;gap:8px;align-items:flex-start;font-size:12px;padding:2px 0}" +
      ".FM_pgTimeline li .FM_pgDot{margin-top:6px;flex:none}" +
      ".FM_pgTimelineOn .FM_pgTimelineValue{font-weight:600}" +
      ".FM_pgTimelineValue{margin:0;font-size:13px;line-height:1.45;word-break:break-word}" +
      ".FM_pgTimelineMeta{margin:2px 0 0;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgEdit{display:flex;flex-direction:column;gap:8px}" +
      ".FM_pgInput{width:100%;box-sizing:border-box;height:34px;border-radius:9px;border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 11px;outline:none}" +
      ".FM_pgEditRow{display:flex;gap:8px}" +
      ".FM_pgEntityFacts{display:flex;flex-direction:column;gap:6px}" +
      ".FM_pgEntityFact{appearance:none;font:inherit;text-align:left;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:8px 11px;display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--dsw-alias-label-primary)}" +
      ".FM_pgEntityFact:hover{border-color:var(--dsw-alias-label-dimmed)}" +
      ".FM_pgGraphTab{display:flex;flex-direction:column;gap:12px}" +
      ".FM_pgGraphBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
      ".FM_pgSeg{display:flex;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-module-platform)}" +
      ".FM_pgSegBtn{appearance:none;border:none;background:0 0;font:inherit;font-size:12px;color:var(--dsw-alias-label-tertiary);padding:4px 11px;border-radius:7px;cursor:pointer}" +
      ".FM_pgSegOn{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-weight:500}" +
      ".FM_pgCanvasWrap{border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:linear-gradient(180deg,var(--dsw-alias-bg-layer-1),var(--dsw-alias-bg-layer-2));padding:8px;display:flex;flex-direction:column;gap:4px}" +
      ".FM_pgCanvas{width:100%;height:auto;display:block}" +
      ".FM_pgSeedBox{fill:var(--dsw-alias-bg-layer-3);stroke:var(--dsw-alias-brand-primary);stroke-width:1.6}" +
      ".FM_pgSeedName{fill:var(--dsw-alias-label-primary);font-size:14px;font-weight:600}" +
      ".FM_pgSeedMeta{fill:var(--dsw-alias-label-tertiary);font-size:10px}" +
      ".FM_pgLink{stroke:var(--dsw-alias-brand-primary);stroke-opacity:.4;stroke-width:1.4;fill:none}" +
      ".FM_pgLinkDanger{stroke:var(--dsw-alias-label-error);stroke-opacity:.65;stroke-dasharray:5 4}" +
      ".FM_pgRowGroup{cursor:pointer}" +
      ".FM_pgRowHit{fill:transparent}" +
      ".FM_pgRowGroup:hover .FM_pgRowHit{fill:var(--dsw-alias-bg-layer-3)}" +
      ".FM_pgRowGroup:hover .FM_pgRowValue{fill:var(--dsw-alias-label-primary)}" +
      ".FM_pgRowPred{fill:var(--dsw-alias-label-tertiary);font-size:11px}" +
      ".FM_pgRowValue{fill:var(--dsw-alias-label-secondary);font-size:12.5px}" +
      ".FM_pgRowValueDanger{fill:var(--dsw-alias-label-error)}" +
      ".FM_pgRowTag{fill:var(--dsw-alias-label-tertiary);font-size:10px}" +
      ".FM_pgEdgeList{display:flex;flex-direction:column;gap:6px}" +
      ".FM_pgEdgeRow{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:7px 11px;background:var(--dsw-alias-bg-layer-1)}" +
      ".FM_pgNodeName{font-weight:500;color:var(--dsw-alias-label-primary)}" +
      ".FM_pgEdgeCount{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgCards{display:flex;flex-direction:column;gap:10px}" +
      ".FM_pgCard{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:9px}" +
      ".FM_pgCardDanger{border-color:rgba(220,80,80,.35)}" +
      ".FM_pgCardHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
      ".FM_pgDiff{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:14px}" +
      ".FM_pgDiffOld{color:var(--dsw-alias-label-tertiary);text-decoration:line-through;text-decoration-thickness:1px}" +
      ".FM_pgArrow{color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgDiffNew{font-weight:600;color:var(--dsw-alias-label-primary);word-break:break-word}" +
      ".FM_pgCardMeta{margin:0;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgReason{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-border-l2);padding-left:9px}" +
      ".FM_pgCardActions{display:flex;gap:8px;flex-wrap:wrap}" +
      ".FM_pgList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px}" +
      ".FM_pgListItem{display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:12.5px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 9px;background:var(--dsw-alias-bg-layer-2)}" +
      ".FM_pgListValue{color:var(--dsw-alias-label-primary);word-break:break-word;min-width:0}" +
      ".FM_pgListItem .FM_pgMiniBtn{margin-left:auto}" +
      ".FM_pgReviewDigest{margin:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:7px 11px;background:var(--dsw-alias-bg-layer-2)}" +
      ".FM_pgReviewKinds{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgConflictRows{display:flex;flex-direction:column;gap:8px}" +
      ".FM_pgConflictRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:9px 11px;background:var(--dsw-alias-bg-layer-2)}" +
      ".FM_pgConflictActions{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}" +
      ".FM_dr{display:flex;flex-direction:column;gap:10px;padding:12px 12px 16px;height:100%;box-sizing:border-box;overflow:auto}" +
      ".FM_drHead{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}" +
      ".FM_drHeadText{display:flex;flex-direction:column;gap:2px;min-width:0}" +
      ".FM_drSub{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_drList{display:flex;flex-direction:column;gap:6px}" +
      ".FM_drCount{font-size:11.5px;color:var(--dsw-alias-label-tertiary);padding:0 2px 2px}" +
      ".FM_drRow{appearance:none;text-align:left;font:inherit;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;padding:9px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);transition:border-color .16s,background .16s,transform .16s}" +
      ".FM_drRow:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);transform:translateY(-1px)}" +
      ".FM_drRowMain{display:flex;flex-direction:column;gap:2px;min-width:0}" +
      ".FM_drRowHead{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);min-width:0}" +
      ".FM_drEntity{font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".FM_drDot{opacity:.6}" +
      ".FM_drPred{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".FM_drValue{font-size:13px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:190px}" +
      ".FM_drRowMeta{display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex:none}" +
      ".FM_drTime{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}" +
      ".FM_drTitle{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}" +
      ".FM_drTitleCount{min-width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:10.5px;display:inline-flex;align-items:center;justify-content:center;padding:0 4px}" +
      ".FM_turnCard{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px;margin:4px 0;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary);width:fit-content;max-width:100%}" +
      ".FM_turnLabel{font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".FM_turnStat{padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px}" +
      ".FM_turnStat_pending{color:var(--dsw-alias-label-warning,#a05a00)}" +
      ".FM_turnStat_conflict{color:var(--dsw-alias-label-danger,#b3261e)}" +
      ".FM_turnView{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;height:22px;border-radius:999px;padding:0 10px;cursor:pointer}" +
      ".FM_turnView:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}" +
      ".FM_rowMark{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_rowMark:hover{color:var(--dsw-alias-label-secondary)}" +
      ".FM_pgHeaderBtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;height:26px;border-radius:999px;padding:0 10px 0 8px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;transition:color .16s,border-color .16s,background .16s}" +
      ".FM_pgHeaderBtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-bg-layer-2)}" +
      ".FM_pgHeaderBadge{font-size:10px;line-height:15px;min-width:15px;padding:0 4px;border-radius:999px;background:var(--dsw-alias-label-error);color:#fff;text-align:center}" +
      ".FM_pgQueue{display:flex;flex-direction:column;gap:12px}" +
      ".FM_pgQueueBar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
      ".FM_pgQueueAt{margin-left:auto;font-size:11px;white-space:nowrap}" +
      ".FM_pgQueueBody{display:flex;flex-direction:column;gap:12px}" +
      ".FM_pgQueueChips{display:flex;gap:6px;flex-wrap:wrap}" +
      ".FM_pgQueueConfig{margin:0;font-size:11px}" +
      ".FM_pgQueueList{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l2);border-radius:11px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}" +
      ".FM_pgQueueRow{display:grid;grid-template-columns:96px minmax(120px,1fr) minmax(90px,auto) auto;align-items:center;gap:10px;padding:9px 12px;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
      ".FM_pgQueueRow:last-child{border-bottom:none}" +
      ".FM_pgQueueSession{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}" +
      ".FM_pgQueueMeta{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}" +
      ".FM_pgQueuePreview{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px}" +
      ".FM_pgQueueRowPending{grid-template-columns:96px 90px minmax(120px,1fr) auto}" +
      ".FM_pgQueueRowRecent{grid-template-columns:96px minmax(120px,1fr) minmax(120px,auto) auto 12px}" +
      ".FM_pgQueueItem{display:flex;flex-direction:column;min-width:0}" +
      ".FM_pgQueueRowClick{cursor:pointer}" +
      ".FM_pgQueueRowClick:hover{background:var(--dsw-alias-bg-layer-2)}" +
      ".FM_pgQueueRowClick:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}" +
      ".FM_pgQueueCaret{font-size:10px;color:var(--dsw-alias-label-tertiary);transition:transform .16s ease}" +
      ".FM_pgQueueCaretOn{transform:rotate(90deg)}" +
      ".FM_pgQueueDetail{display:flex;flex-direction:column;gap:8px;padding:10px 12px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}" +
      ".FM_pgQueueDetailHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}" +
      ".FM_pgQueueNote{margin:0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}" +
      ".FM_pgQueueInput{margin:0;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:11.5px;line-height:1.65;padding:10px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}" +
      ".FM_pgQueueMore{align-self:flex-start;appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;border-radius:8px;padding:4px 10px;cursor:pointer}" +
      ".FM_pgQueueMore:hover{border-color:var(--dsw-alias-brand-primary)}" +
      ".FM_pgQueueReject{display:flex;align-items:center;gap:6px;flex-wrap:wrap}" +
      ".FM_pgQueueRejectPill{font-size:11px;line-height:18px;padding:0 8px;border-radius:999px;background:rgba(218,165,32,.14);color:var(--dsw-alias-state-warn-label,#b8860b)}" +
      ".FM_pgQueueRecentHead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}" +
      ".FM_pgQueueRecentHead .FM_pgRailLabel{margin:0}" +
      ".FM_pgQueueRecentHint{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgQueueRecentEmpty{margin:0;padding:10px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:11px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}" +
      ".FM_pgPill_muted{color:var(--dsw-alias-label-secondary);background:rgba(128,128,128,.10)}" +
      "@media (max-width:1180px){.FM_pgBodySplit{grid-template-columns:minmax(0,1fr)}.FM_pgStats{grid-template-columns:repeat(2,minmax(0,1fr))}.FM_pgQueueRow,.FM_pgQueueRowPending{grid-template-columns:96px minmax(0,1fr)}.FM_pgQueueRowRecent{grid-template-columns:76px minmax(0,1fr) auto 10px}.FM_pgQueueRowRecent .FM_pgQueueMeta:nth-child(3){display:none}}" +
      "@media (prefers-reduced-motion:reduce){.FM_pgFact,.FM_pgIconBtn,.FM_pgTab,.FM_pgChip{transition:none}}" +
      ".FM_pgNebula{display:flex;flex-direction:column;gap:8px}" +
      ".FM_pgNebulaBar{display:flex;align-items:center;gap:6px;flex-wrap:wrap}" +
      ".FM_pgNebulaBtn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;height:26px;border-radius:999px;padding:0 11px;cursor:pointer;transition:color .16s,border-color .16s,background .16s}" +
      ".FM_pgNebulaBtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}" +
      ".FM_pgNebulaBtnOn{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary);background:rgba(94,124,255,.14)}" +
      ".FM_pgNebulaHint{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgNebulaStage{position:relative;height:clamp(360px,52vh,560px);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;overflow:hidden;background:radial-gradient(120% 90% at 50% 8%,#0b132a 0%,#05070f 55%,#020306 100%)}" +
      ".FM_pgNebulaStage canvas{position:absolute;inset:0;width:100%;height:100%;display:block}" +
      ".FM_pgNebulaBg{z-index:0;pointer-events:none}" +
      ".FM_pgNebulaGl{z-index:1;cursor:grab;touch-action:none}" +
      ".FM_pgNebulaLabel{z-index:2;pointer-events:none}" +
      ".FM_pgNebulaFoot{margin:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgNebulaVignette{position:absolute;inset:0;z-index:3;pointer-events:none;background:radial-gradient(120% 100% at 50% 45%,transparent 55%,rgba(2,3,6,.55) 100%);opacity:.55}" +
      ".FM_pgNebulaStage[data-tone=light]{box-shadow:inset 0 0 0 1px rgba(20,28,60,.10),0 10px 28px rgba(20,28,60,.10)}" +
      ".FM_pgNebulaStage[data-tone=light] .FM_pgNebulaVignette{background:radial-gradient(120% 100% at 50% 45%,transparent 58%,rgba(255,255,255,.16) 100%);opacity:.9}" +
      ".FM_pgNebulaTip{position:absolute;z-index:4;pointer-events:none;transform:translate(-50%,calc(-100% - 10px));background:rgba(10,14,28,.94);color:#e8ecff;border:1px solid rgba(150,170,255,.28);border-radius:8px;padding:5px 9px;font-size:11.5px;line-height:1.45;white-space:nowrap;box-shadow:0 8px 20px rgba(0,0,0,.35)}" +
      ".FM_pgNebulaTip b{font-weight:600;color:#fff}" +
      ".FM_pgNebulaTip span{color:#9aa6cc;margin-left:6px}" +
      ".FM_pgPillGlyph{display:inline-block;margin-right:4px;font-size:9px;line-height:1;vertical-align:1px;opacity:.9}" +
      ".FM_pgTimeAgo{font-variant-numeric:tabular-nums}" +
      ".FM_pgFactListWrap{display:flex;flex-direction:column;gap:10px}" +
      ".FM_pgLoadMore{display:flex;flex-direction:column;align-items:center;gap:6px;padding:8px 0 2px}" +
      ".FM_pgLoadMoreMeta{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary);text-align:center}" +
      ".FM_pgSkeleton{display:flex;flex-direction:column;gap:8px}" +
      ".FM_pgSkeletonRow{height:64px;border-radius:11px;border:1px solid var(--dsw-alias-border-l2);background:linear-gradient(100deg,var(--dsw-alias-bg-layer-1) 30%,var(--dsw-alias-bg-layer-2) 50%,var(--dsw-alias-bg-layer-1) 70%);background-size:220% 100%;animation:FM_pgShimmer 1.4s ease-in-out infinite}" +
      "@keyframes FM_pgShimmer{0%{background-position:120% 0}100%{background-position:-20% 0}}" +
      ".FM_pgStart{display:flex;flex-direction:column;gap:8px;margin-top:14px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);text-align:left;width:100%;max-width:480px}" +
      ".FM_pgStartLabel{margin:0;font-size:11px;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgStartCode{display:block;padding:10px 12px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:12px;line-height:1.6;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}" +
      ".FM_pgStartRow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
      ".FM_pgToast{position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:90;display:flex;align-items:center;gap:12px;min-width:260px;max-width:min(560px,92vw);padding:10px 12px 10px 14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 14px 40px rgba(0,0,0,.22);animation:FM_pgToastIn .18s ease-out}" +
      "@keyframes FM_pgToastIn{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}" +
      ".FM_pgToastBody{display:flex;flex-direction:column;gap:2px;min-width:0}" +
      ".FM_pgToastText{margin:0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary)}" +
      ".FM_pgToastBad .FM_pgToastText{color:var(--dsw-alias-label-error)}" +
      ".FM_pgToastMsg{margin:0;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgToastActions{display:flex;align-items:center;gap:6px;margin-left:auto}" +
      ".FM_pgToastUndo{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;border-radius:8px;padding:4px 10px;cursor:pointer;white-space:nowrap}" +
      ".FM_pgToastUndo:hover{border-color:var(--dsw-alias-brand-primary)}" +
      ".FM_pgToastClose{appearance:none;border:none;background:0 0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:1;cursor:pointer;padding:2px 4px}" +
      ".FM_pgSearchClear{appearance:none;border:none;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:13px;line-height:1;padding:2px 4px;border-radius:6px}" +
      ".FM_pgSearchClear:hover{color:var(--dsw-alias-label-primary)}" +
      ".FM_pgRecentSearches{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgRecentChip{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;border-radius:999px;padding:1px 9px;cursor:pointer}" +
      ".FM_pgRecentChip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}" +
      ".FM_pgKbd{font-family:var(--dsw-font-markdown-code-block,ui-monospace,monospace);font-size:10px;padding:1px 5px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}" +
      ".FM_fineprint{margin:2px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".FM_pgSheetBackdrop{display:none}" +
      "@media (max-width:1180px){.FM_pgSheetBackdrop{display:block;position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.34)}.FM_pgBodySplit .FM_pgRail{position:fixed;left:0;right:0;bottom:0;top:auto;z-index:61;max-height:78vh;overflow:auto;border-radius:16px 16px 0 0;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:0 -18px 44px rgba(0,0,0,.30);padding:14px 16px 18px}.FM_pgBodySplit .FM_pgRail::before{content:'';display:block;width:38px;height:4px;margin:0 auto 10px;border-radius:999px;background:var(--dsw-alias-border-l2)}}" +
      "@media (prefers-reduced-motion:reduce){.FM_pgSkeletonRow{animation:none}.FM_pgToast{animation:none}}" +
      ".FM_pgNebulaFallback{display:flex;flex-direction:column;gap:6px}";

    // Injected immediately after its declaration: pageCss is a `const` in this
    // factory, so referencing it any earlier throws a TDZ error at load time.
    const pageTagId = "dsh-fact-memory/page.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(pageTagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "dsh-fact-memory";
      tag.dataset.pluginCss = pageTagId;
      tag.textContent = pageCss;
      document.head.appendChild(tag);
    }

    const zhPage = {
      "panel.title": "事实记忆",
      "panel.label": "记忆",
      "page.openPanel": "打开事实记忆",
      "drawer.title": "记忆详情",
      "drawer.subtitle": "这个会话写入的事实",
      "drawer.empty": "这个会话还没有写入任何事实。",
      "drawer.hint": "在对话里点「本轮记忆」的「查看」，这里就会列出这个会话写入的事实。",
      "drawer.loading": "正在读取…",
      "drawer.failed": "读取失败：{error}",
      "drawer.open": "在事实库里打开",
      "drawer.count": "{n} 条",
      "turn.title": "本轮记忆",
      "turn.saved": "写入 {n} 条",
      "turn.pending": "待审 {n} 条",
      "turn.conflict": "待裁决 {n}",
      "turn.view": "查看",
      "row.mark": "这个会话写过 {n} 条记忆",
      "page.tabsLabel": "事实记忆视图",
      "page.subtitle": "{n} 条事实 · 跨会话记忆库",
      "page.unavailable": "记忆库暂不可用",
      "page.autoOn": "自动抽取已开启",
      "page.semanticOn": "向量：{model}",
      "page.searchPlaceholder": "搜索实体、属性或值…",
      "page.searchHint": "按 / 聚焦搜索，Esc 清空",
      "page.searchClear": "清空搜索",
      "page.recentSearches": "最近搜索",
      "page.loadMore": "加载更多",
      "page.loadMoreMeta": "已显示 {n} 条",
      "page.loadMoreEnd": "共 {n} 条，已全部显示",
      "page.facts.emptySearch": "没有匹配的事实",
      "page.facts.emptySearchHint": "换个词试试，或者清空搜索看全部。",
      "page.facts.tryTitle": "可以这样让它记住",
      "page.facts.tryExample": "记住：我偏好中文回答，除非我用英文提问。",
      "page.facts.tryCopy": "复制示例",
      "page.facts.tryHint": "发一条消息，或者直接调用 memory_write。",
      "page.undo": "撤销",
      "page.toast.updated": "已保存新值",
      "page.toast.expired": "已标记失效",
      "page.toast.restored": "已恢复这条事实",
      "page.toast.restoreStale": "撤销失败：这个属性已经有新值",
      "page.toast.restoreFailed": "撤销失败",
      "page.toast.proposal": "提案已采纳",
      "page.toast.proposalUndone": "已撤销采纳",
      "page.toast.proposalRejected": "提案已拒绝",
      "page.toast.resolved": "冲突已裁决",
      "page.toast.copied": "示例已复制",
    "page.toast.copyFailed": "复制失败，请手动选中示例文字",
    "page.toast.undoFailed": "撤销没有完成，请刷新后重试",
      "page.refresh": "刷新",
      "page.loading": "正在读取…",
      "page.save": "保存",
      "page.cancel": "取消",
      "page.edit": "改值",
      "page.expire": "标记失效",
      "page.close": "关闭",
      "page.openEntity": "查看这个主体的全部事实",
      "page.accept": "采纳",
      "page.reject": "拒绝",
      "page.keepThis": "保留这个",
      "page.keepBoth": "确认多值",
      "page.dropAll": "全部弃用",
      "page.sources": "来源",
      "page.sourceCount": "{n} 处来源",
      "page.noSources": "没有记录来源（可能是导入或手工补录）。",
      "page.history": "同一槽位的历史",
      "page.meta": "元信息",
      "page.metaScope": "范围",
      "page.metaObserved": "观察时间",
      "page.metaRevision": "记录版本",
      "page.metaValid": "有效区间",
      "page.metaFromStart": "起始",
      "page.metaOpen": "至今",
      "page.entityCount": "这个主体共有 {n} 条事实",
      "page.proposalNone": "无现值",
      "page.proposalConfidence": "置信度 {n}%",
      "page.proposalNoConfidence": "无置信度",
      "page.proposalRevision": "第 {n} 版",
      "page.conflictOpen": "未裁决",
      "page.conflictHint": "同一槽位出现两个可信度不足的值。选一个保留，或确认它们可以共存。",
      "page.tab.facts": "事实库",
      "page.tab.graph": "图谱",
      "page.tab.proposals": "待审提案",
      "page.tab.conflicts": "待裁决",
      "page.tab.queue": "抽取队列",
      "page.queue.auto": "自动刷新",
      "page.queue.autoOff": "关闭",
      "page.queue.seconds": "{s} 秒",
      "page.queue.refresh": "刷新队列",
      "page.queue.updated": "更新于 {time}",
      "page.queue.running": "运行中 {n}",
      "page.queue.queued": "排队 {n}",
      "page.queue.waiting": "等待 {n}",
      "page.queue.retrying": "重试 {n}",
      "page.queue.pending": "待处理 {n}",
      "page.queue.current": "正在处理",
      "page.queue.idle": "当前没有正在跑的抽取。发一条消息后，它就会出现在这里。",
      "page.queue.pendingTitle": "多次失败、已挂起",
      "page.queue.recent": "最近完成",
      "page.queue.recentHint": "重启后仍然保留，点一行看它读到了什么",
      "page.queue.recentEmpty": "还没有运行记录：发一条消息，回合结束后抽取跑完就会出现在这里；也可以点上面的刷新。",
      "page.queue.recentEmptyOff": "自动抽取当前关闭，所以不会有运行记录。到设置卡里打开后，回合结束才会自动入队。",
      "page.queue.justNow": "刚刚",
      "page.queue.minutesAgo": "{n} 分钟前",
      "page.queue.hoursAgo": "{n} 小时前",
      "page.queue.daysAgo": "{n} 天前",
      "page.queue.detail.saved": "写入 {n} 条",
      "page.queue.detail.proposals": "待确认 {n} 条",
      "page.queue.detail.conflicts": "冲突 {n} 条",
      "page.queue.detail.nothing": "没有新的可记事实",
      "page.queue.detail.took": "用时 {s} 秒",
      "page.queue.reason.noText": "这一轮没有新的对话文本",
      "page.queue.reason.noCandidates": "读过内容，没有可记的事实",
      "page.queue.reason.unconfigured": "没有配置模型，这轮没有抽取",
      "page.queue.reason.failed": "失败：{reason}",
      "page.queue.reason.noSignal": "没有发现记忆信号，这一轮未调用模型（文本留着，轮数到了会补看）",
      "page.queue.reason.policyRejected": "模型给了候选，但没有一条符合库的结构（点开看拒绝原因）",
      "page.queue.reason.manualCapture": "助手已用 memory_write 记下这一轮，没有再调用模型",
      "page.queue.detailManual": "这一轮的事实是助手自己用 memory_write 记下的，所以没有再调用模型——下面是这一轮的原文。",
      "page.queue.detailTurnText": "这一轮的原文",
      "page.queue.openHint": "点开看这一轮读到的原文",
      "page.queue.detailInput": "发给模型的原文",
      "page.queue.detailNoInput": "这条记录没有留下原文（旧版本只存了计数），下一轮开始会带上原文。",
      "page.queue.detailTruncated": "原文超过 2 万字，这里只保留前 {n} 字",
      "page.queue.detailMeta": "{messages} 条消息 · {chunks} 段 · 模型 {model}",
      "page.queue.detailNoModel": "未调用",
      "page.queue.detailTook": "用时 {s} 秒",
      "page.queue.detailRejected": "被拒绝的候选",
      "page.queue.detailRejectedNone": "没有候选被拒绝",
      "page.queue.detailNotCalled": "预过滤没有发现记忆信号，所以这一轮没有调用模型——下面就是它检查过的原文。",
      "page.queue.detailMore": "加载更多（已显示 {shown} / {total} 字）",
      "page.queue.detailAll": "已显示全文（{n} 字）",
      "page.queue.detailShape": "形态不合格",
      "page.queue.reject.no_quote": "没有引用原文",
      "page.queue.reject.quote_not_in_source": "引用不在原文里",
      "page.queue.reject.missing_field": "字段不全",
      "page.queue.reject.not_an_object": "不是对象",
      "page.queue.reject.too_long": "太长",
      "page.queue.reject.duplicate_in_batch": "批内重复",
      "page.queue.state.unconfigured": "未配置",
      "page.queue.rowQueued": "排在第 {n} 位",
      "page.queue.rowDue": "约 {s} 秒后开始",
      "page.queue.rowRetry": "第 {n} 次重试，约 {s} 秒后",
      "page.queue.rowSeq": "到 seq {n}",
      "page.queue.chars": "{n} 字",
      "page.queue.session": "会话 {id}",
      "page.queue.configOn": "自动抽取已开启 · 延迟 {s} 秒 · 模型 {model}",
      "page.queue.configOff": "自动抽取已关闭：到设置卡里打开后，回合结束才会自动入队。",
      "page.queue.empty": "还没有队列数据",
      "page.queue.emptyHint": "点刷新读取当前队列。默认不自动刷新，可以在这里开 5/10/15/30 秒。",
      "page.queue.state.running": "运行中",
      "page.queue.state.queued": "排队中",
      "page.queue.state.waiting": "等待中",
      "page.queue.state.retrying": "等待重试",
      "page.queue.state.done": "已完成",
      "page.queue.state.ok": "已完成",
      "page.queue.state.skipped": "已跳过",
      "page.queue.state.failed": "已挂起",
      "page.queue.state.error": "失败",
      "page.stat.facts": "事实",
      "page.stat.factsHint": "其中 {n} 条生效中",
      "page.stat.proposals": "待审提案",
      "page.stat.proposalsHint": "推断或低置信度，等你确认",
      "page.stat.conflicts": "待裁决",
      "page.stat.conflictsHint": "同一槽位的两个值",
      "page.stat.vectors": "向量",
      "page.stat.vectorsOn": "语义通道已配置",
      "page.stat.vectorsOff": "仅词面检索",
      "page.stat.vectorsBuild": "重建",
      "page.filter.live": "生效中",
      "page.filter.conflict": "待裁决",
      "page.filter.scheduled": "待生效",
      "page.filter.expired": "已过期",
      "page.filter.all": "全部",
      "page.status.active": "生效中",
      "page.status.scheduled": "待生效",
      "page.status.conflict": "待裁决",
      "page.status.expired": "已过期",
      "page.status.superseded": "已被替代",
      "page.status.forgotten": "已遗忘",
      "page.evidence.explicit_user": "用户明说",
      "page.evidence.confirmed_user": "用户确认",
      "page.evidence.observed": "观察所得",
      "page.evidence.inferred": "推断",
      "page.evidence.imported": "导入",
      "page.evidence.unverified": "未核实",
      "page.secret": "凭据",
      "page.reveal": "显示",
      "page.hide": "隐藏",
      "page.facts.empty": "还没有匹配的事实",
      "page.facts.emptyHint": "换个筛选条件，或者让模型用 memory_write 记下值得跨会话保留的事实。",
      "page.facts.emptyTitle": "这里还没有事实",
      "page.facts.emptyIntro": "记忆只在值得跨会话保留时写入，第一条可以从下面这句开始。",
      "page.proposals.empty": "没有待审提案",
      "page.proposals.emptyHint": "推断出来的事实与低置信度的写入会先进入这里，确认之后才进事实库。",
      "page.conflicts.empty": "没有待裁决的冲突",
      "page.conflicts.emptyHint": "同一槽位出现两个可信度相近的值时会在这里让你裁决。",
      "page.graph.entityPlaceholder": "输入主体名，例如 api、user、dsh-fact-memory",
      "page.graph.load": "载入图谱",
      "page.graph.refresh": "刷新图谱",
      "page.graph.current": "当前关系",
      "page.graph.all": "含冲突",
      "page.graph.prompt": "选一个主体看它的关系网",
      "page.graph.promptHint": "边只由「提到这个主体的事实」派生，点节点可以继续展开邻域。",
      "page.graph.empty": "这个主体还没有关系",
      "page.graph.emptyHint": "试试另一个主体，或者先写入几条提到它的事实。",
      "page.graph.truncated": "还有 {n} 个节点/边未展示",
      "page.graph.relations": "关系列表",
      "page.graph.seedMeta": "{n} 条关系",
      "page.graph.entityNode": "主体",
      "page.graph.factCount": "支撑 {n} 条事实",
      "page.graph.resetView": "重置视角",
      "page.graph.spinPause": "暂停自转",
      "page.graph.spinResume": "恢复自转",
      "page.graph.labelsHide": "隐藏标签",
      "page.graph.labelsShow": "显示标签",
      "page.graph.nebulaHint": "拖拽旋转 · 滚轮缩放 · 右键平移 · 双击复位；悬停看关系，点击进详情。",
      "page.graph.tipEntity": "{n} 条事实 · 点击查看",
      "page.graph.tipValue": "值 · {n} 条事实",
      "page.graph.nebulaLoading": "星云成形中",
      "page.graph.nebulaTruncated": "另有 {nodes} 个节点、{edges} 条边未展开",
      "page.graph.nebulaCounts": "{nodes} 个节点 · {edges} 条边",
      "page.graph.webglFallback": "当前环境没有 WebGL，已降级为关系树视图。",
      "page.proposalKind.low_confidence": "低置信推断",
      "page.proposalKind.consolidation": "合并整理",
      "page.proposalKind.alias": "主体别名",
      "page.proposalKind.conflict": "冲突处理",
      "page.proposalKind.expiry": "过期清理",
      "page.running.update": "正在改值…",
      "page.running.expire": "正在标记失效…",
      "page.running.proposal": "正在采纳…",
      "page.running.proposalReject": "正在拒绝…",
      "page.running.resolve": "正在裁决…",
      "page.running.vectors": "正在重建向量索引…",
      "page.running.restore": "正在恢复…",
      "page.done.update": "已改值，历史保留在同一槽位",
      "page.done.expire": "已标记失效",
      "page.done.proposal": "已采纳并写入事实库",
      "page.done.proposalReject": "已拒绝这条提案",
      "page.done.resolve": "已裁决",
      "page.done.vectors": "向量索引已更新",
      "page.done.restore": "已恢复",
      "page.failed.update": "改值失败",
      "page.failed.expire": "标记失效失败",
      "page.failed.proposal": "采纳失败",
      "page.failed.proposalReject": "拒绝失败",
      "page.failed.resolve": "裁决失败",
      "page.failed.vectors": "重建向量索引失败",
      "page.failed.restore": "恢复失败",
    };

    const enPage = {
      "panel.title": "Fact memory",
      "panel.label": "Memory",
      "page.openPanel": "Open fact memory",
      "drawer.title": "Memory",
      "drawer.subtitle": "Facts this conversation wrote",
      "drawer.empty": "This conversation has not written any fact yet.",
      "drawer.hint": "Use View on a turn's memory card and this pane lists what that conversation wrote.",
      "drawer.loading": "Loading…",
      "drawer.failed": "Could not load: {error}",
      "drawer.open": "Open in the library",
      "drawer.count": "{n} facts",
      "turn.title": "This turn",
      "turn.saved": "{n} saved",
      "turn.pending": "{n} to review",
      "turn.conflict": "{n} unresolved",
      "turn.view": "View",
      "row.mark": "This conversation wrote {n} facts",
      "page.tabsLabel": "Fact memory views",
      "page.subtitle": "{n} facts · cross-session memory",
      "page.unavailable": "Memory store unavailable",
      "page.autoOn": "Auto-extract on",
      "page.semanticOn": "Vectors: {model}",
      "page.searchPlaceholder": "Search entities, predicates or values…",
      "page.searchHint": "Press / to search, Esc to clear",
      "page.searchClear": "Clear search",
      "page.recentSearches": "Recent searches",
      "page.loadMore": "Load more",
      "page.loadMoreMeta": "{n} shown",
      "page.loadMoreEnd": "{n} total, all shown",
      "page.facts.emptySearch": "No matching facts",
      "page.facts.emptySearchHint": "Try another word, or clear the search to see everything.",
      "page.facts.tryTitle": "You can ask it to remember",
      "page.facts.tryExample": "Remember: I prefer Chinese unless I ask in English.",
      "page.facts.tryCopy": "Copy example",
      "page.facts.tryHint": "Send a message, or call memory_write directly.",
      "page.undo": "Undo",
      "page.toast.updated": "New value saved",
      "page.toast.expired": "Marked expired",
      "page.toast.restored": "Fact restored",
      "page.toast.restoreStale": "Undo failed: the slot already has a newer value",
      "page.toast.restoreFailed": "Undo failed",
      "page.toast.proposal": "Proposal accepted",
      "page.toast.proposalUndone": "Acceptance undone",
      "page.toast.proposalRejected": "Proposal rejected",
      "page.toast.resolved": "Conflict resolved",
      "page.toast.copied": "Example copied",
    "page.toast.copyFailed": "Could not copy — select the example text manually",
    "page.toast.undoFailed": "The undo did not go through — refresh and try again",
      "page.refresh": "Refresh",
      "page.loading": "Loading…",
      "page.save": "Save",
      "page.cancel": "Cancel",
      "page.edit": "Edit value",
      "page.expire": "Mark expired",
      "page.close": "Close",
      "page.openEntity": "See every fact about this subject",
      "page.accept": "Accept",
      "page.reject": "Reject",
      "page.keepThis": "Keep this one",
      "page.keepBoth": "Both are true",
      "page.dropAll": "Drop both",
      "page.sources": "Sources",
      "page.sourceCount": "{n} source(s)",
      "page.noSources": "No recorded source (imported or entered by hand).",
      "page.history": "History of this slot",
      "page.meta": "Metadata",
      "page.metaScope": "Scope",
      "page.metaObserved": "Observed",
      "page.metaRevision": "Revision",
      "page.metaValid": "Valid window",
      "page.metaFromStart": "start",
      "page.metaOpen": "open",
      "page.entityCount": "{n} facts about this subject",
      "page.proposalNone": "nothing",
      "page.proposalConfidence": "{n}% confidence",
      "page.proposalNoConfidence": "no confidence",
      "page.proposalRevision": "revision {n}",
      "page.conflictOpen": "unresolved",
      "page.conflictHint": "Two values of similar strength landed in one slot. Keep one, or confirm they can coexist.",
      "page.tab.facts": "Facts",
      "page.tab.graph": "Graph",
      "page.tab.proposals": "Proposals",
      "page.tab.conflicts": "Conflicts",
      "page.tab.queue": "Extraction queue",
      "page.queue.auto": "Auto refresh",
      "page.queue.autoOff": "Off",
      "page.queue.seconds": "{s}s",
      "page.queue.refresh": "Refresh queue",
      "page.queue.updated": "updated {time}",
      "page.queue.running": "{n} running",
      "page.queue.queued": "{n} queued",
      "page.queue.waiting": "{n} waiting",
      "page.queue.retrying": "{n} retrying",
      "page.queue.pending": "{n} parked",
      "page.queue.current": "In flight",
      "page.queue.idle": "Nothing is running right now. Send a message and the pass shows up here.",
      "page.queue.pendingTitle": "Parked after repeated failures",
      "page.queue.recent": "Recently finished",
      "page.queue.recentHint": "kept across restarts · click a row to see what it read",
      "page.queue.recentEmpty": "No run yet: send a message and the pass that runs when the turn ends shows up here. You can also hit refresh above.",
      "page.queue.recentEmptyOff": "Auto extraction is off, so no pass will run. Turn it on in the settings card to queue one when a turn ends.",
      "page.queue.justNow": "just now",
      "page.queue.minutesAgo": "{n} min ago",
      "page.queue.hoursAgo": "{n} h ago",
      "page.queue.daysAgo": "{n} d ago",
      "page.queue.detail.saved": "{n} saved",
      "page.queue.detail.proposals": "{n} to review",
      "page.queue.detail.conflicts": "{n} conflicts",
      "page.queue.detail.nothing": "nothing worth saving",
      "page.queue.detail.took": "{s}s",
      "page.queue.reason.noText": "no new conversation text in this turn",
      "page.queue.reason.noCandidates": "read it, nothing worth saving",
      "page.queue.reason.unconfigured": "no model configured, pass skipped",
      "page.queue.reason.failed": "failed: {reason}",
      "page.queue.reason.noSignal": "no memory signal; the model was not called this pass (the text is kept for the fallback)",
      "page.queue.reason.policyRejected": "the model proposed candidates and the schema refused every one (open the row for why)",
      "page.queue.reason.manualCapture": "the assistant stored this turn with memory_write, so no model pass ran",
      "page.queue.detailManual": "The assistant stored this turn itself with memory_write, so no model pass ran — here is the turn's text.",
      "page.queue.detailTurnText": "Text of this turn",
      "page.queue.openHint": "Open to see the text this pass read",
      "page.queue.detailInput": "Text sent to the model",
      "page.queue.detailNoInput": "This record kept counts only (an older build); the next pass will carry the text.",
      "page.queue.detailTruncated": "over 20k chars, first {n} kept",
      "page.queue.detailMeta": "{messages} messages · {chunks} chunks · model {model}",
      "page.queue.detailNoModel": "not called",
      "page.queue.detailTook": "{s}s",
      "page.queue.detailRejected": "Refused candidates",
      "page.queue.detailRejectedNone": "Nothing was refused",
      "page.queue.detailNotCalled": "The prefilter found no memory signal, so this pass never called the model — this is the text it checked.",
      "page.queue.detailMore": "Load more ({shown} / {total} chars shown)",
      "page.queue.detailAll": "whole text shown ({n} chars)",
      "page.queue.detailShape": "bad shape",
      "page.queue.reject.no_quote": "no quote",
      "page.queue.reject.quote_not_in_source": "quote not in source",
      "page.queue.reject.missing_field": "missing field",
      "page.queue.reject.not_an_object": "not an object",
      "page.queue.reject.too_long": "too long",
      "page.queue.reject.duplicate_in_batch": "duplicate in batch",
      "page.queue.state.unconfigured": "unconfigured",
      "page.queue.rowQueued": "#{n} in line",
      "page.queue.rowDue": "starts in ~{s}s",
      "page.queue.rowRetry": "retry {n}, in ~{s}s",
      "page.queue.rowSeq": "up to seq {n}",
      "page.queue.chars": "{n} chars",
      "page.queue.session": "session {id}",
      "page.queue.configOn": "Auto extraction on · {s}s delay · model {model}",
      "page.queue.configOff": "Auto extraction is off: turn it on in the settings card and a pass is queued when a turn ends.",
      "page.queue.empty": "No queue data yet",
      "page.queue.emptyHint": "Refresh to read the queue. Auto refresh is off by default; pick 5/10/15/30s here.",
      "page.queue.state.running": "running",
      "page.queue.state.queued": "queued",
      "page.queue.state.waiting": "waiting",
      "page.queue.state.retrying": "retrying",
      "page.queue.state.done": "done",
      "page.queue.state.ok": "done",
      "page.queue.state.skipped": "skipped",
      "page.queue.state.failed": "parked",
      "page.queue.state.error": "failed",
      "page.stat.facts": "Facts",
      "page.stat.factsHint": "{n} active",
      "page.stat.proposals": "Proposals",
      "page.stat.proposalsHint": "inferred, waiting for you",
      "page.stat.conflicts": "Conflicts",
      "page.stat.conflictsHint": "two values in one slot",
      "page.stat.vectors": "Vectors",
      "page.stat.vectorsOn": "semantic channel configured",
      "page.stat.vectorsOff": "lexical only",
      "page.stat.vectorsBuild": "Build",
      "page.filter.live": "Active",
      "page.filter.conflict": "Conflicts",
      "page.filter.scheduled": "Scheduled",
      "page.filter.expired": "Expired",
      "page.filter.all": "All",
      "page.status.active": "active",
      "page.status.scheduled": "scheduled",
      "page.status.conflict": "conflict",
      "page.status.expired": "expired",
      "page.status.superseded": "superseded",
      "page.status.forgotten": "forgotten",
      "page.evidence.explicit_user": "user stated",
      "page.evidence.confirmed_user": "user confirmed",
      "page.evidence.observed": "observed",
      "page.evidence.inferred": "inferred",
      "page.evidence.imported": "imported",
      "page.evidence.unverified": "unverified",
      "page.secret": "credential",
      "page.reveal": "Reveal",
      "page.hide": "Hide",
      "page.facts.empty": "No matching facts",
      "page.facts.emptyHint": "Loosen the filter, or have the model record something worth keeping across sessions.",
      "page.facts.emptyTitle": "No facts yet",
      "page.facts.emptyIntro": "Nothing is stored unless it will still hold next session; the first one can start below.",
      "page.proposals.empty": "Nothing to review",
      "page.proposals.emptyHint": "Inferred facts and low-confidence writes queue here until you confirm them.",
      "page.conflicts.empty": "No conflicts",
      "page.conflicts.emptyHint": "When two equally credible values hit one slot, the decision lands here.",
      "page.graph.entityPlaceholder": "Entity name, e.g. api, user, dsh-fact-memory",
      "page.graph.load": "Load graph",
      "page.graph.refresh": "Refresh graph",
      "page.graph.current": "Confirmed",
      "page.graph.all": "With conflicts",
      "page.graph.prompt": "Pick a subject to see its relations",
      "page.graph.promptHint": "Edges come only from facts that name the subject; click a node to expand its neighborhood.",
      "page.graph.empty": "No relations yet",
      "page.graph.emptyHint": "Try another subject, or record facts that mention it.",
      "page.graph.truncated": "{n} more nodes/edges not shown",
      "page.graph.relations": "Relations",
      "page.graph.seedMeta": "{n} relations",
      "page.graph.entityNode": "entity",
      "page.graph.factCount": "{n} facts",
      "page.graph.resetView": "Reset view",
      "page.graph.spinPause": "Pause spin",
      "page.graph.spinResume": "Resume spin",
      "page.graph.labelsHide": "Hide labels",
      "page.graph.labelsShow": "Show labels",
      "page.graph.nebulaHint": "Drag to orbit · wheel to zoom · right-drag to pan · double-click to reset; hover for relations, click for details.",
      "page.graph.tipEntity": "{n} facts · click to open",
      "page.graph.tipValue": "value · {n} facts",
      "page.graph.nebulaLoading": "Shaping the nebula",
      "page.graph.nebulaTruncated": "{nodes} more nodes / {edges} more edges",
      "page.graph.nebulaCounts": "{nodes} nodes · {edges} edges",
      "page.graph.webglFallback": "WebGL is unavailable here, so the relation tree is shown instead.",
      "page.proposalKind.low_confidence": "low confidence",
      "page.proposalKind.consolidation": "consolidation",
      "page.proposalKind.alias": "alias merge",
      "page.proposalKind.conflict": "conflict fix",
      "page.proposalKind.expiry": "expiry",
      "page.running.update": "Saving the new value…",
      "page.running.expire": "Marking expired…",
      "page.running.proposal": "Accepting…",
      "page.running.proposalReject": "Rejecting…",
      "page.running.resolve": "Resolving…",
      "page.running.vectors": "Rebuilding vectors…",
      "page.running.restore": "Restoring…",
      "page.done.update": "Value updated; the old one stays in history",
      "page.done.expire": "Marked expired",
      "page.done.proposal": "Accepted and written",
      "page.done.proposalReject": "Proposal rejected",
      "page.done.resolve": "Conflict resolved",
      "page.done.vectors": "Vector index updated",
      "page.done.restore": "Restored",
      "page.failed.update": "Could not update the value",
      "page.failed.expire": "Could not mark it expired",
      "page.failed.proposal": "Could not accept it",
      "page.failed.proposalReject": "Could not reject it",
      "page.failed.resolve": "Could not resolve it",
      "page.failed.vectors": "Could not rebuild the vectors",
      "page.failed.restore": "Could not restore it",
    };

    const useState = react.useState;
    const useEffect = react.useEffect;

    // ══ full-page library ═════════════════════════════════════════════════
    // The settings card answers "is it on, and what does it hold"; the page
    // answers "what do I actually know". It lives in the sidebar as a first-class
    // panel because browsing, editing and resolving is not a setting.
    const PANEL_ID = "dsh-fact-memory";

    function createStore(initial) {
      let value = initial;
      const listeners = new Set();
      const set = (next) => {
        value = typeof next === "function" ? next(value) : next;
        for (const listener of [...listeners]) listener();
      };
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        set,
        patch: (partial) => set((current) => ({ ...current, ...partial })),
      };
    }

    let idCounter = 0;
    function operationId() {
      idCounter += 1;
      const random = typeof Math.random === "function" ? Math.random().toString(36).slice(2, 10) : "0000";
      return `ui-${Date.now().toString(36)}-${random}-${idCounter.toString(36)}`;
    }

    function postJson(path, body, options) {
      if (typeof fetch !== "function") return Promise.resolve({ ok: false, error: "no-fetch" });
      const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : NET_TIMEOUT_MS;
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const init = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
        credentials: "same-origin",
      };
      if (controller) init.signal = controller.signal;
      const timer = setTimeout(() => {
        if (controller) controller.abort();
      }, timeoutMs);
      return fetch(`/api/fact-memory/${path}`, init)
        .then((response) => {
          if (response.status === 401 || response.status === 404) return { ok: false, unavailable: true, error: `http-${response.status}` };
          return response.json().then((payload) => (payload && typeof payload === "object" ? payload : { ok: false, error: "bad-payload" }));
        })
        .catch((error) => ({ ok: false, error: String((error && error.message) || error) }))
        .finally(() => clearTimeout(timer));
    }

    function shortTime(iso, zone) {
      if (!iso) return "";
      try {
        const options = { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" };
        if (zone) options.timeZone = zone;
        return new Intl.DateTimeFormat("zh-CN", options).format(new Date(iso));
      } catch {
        return String(iso).slice(0, 16).replace("T", " ");
      }
    }

    /**
     * "3 分钟前" reads as a plugin that is running; a bare timestamp reads as a
     * log file. Under a minute it says 刚刚; past a week the date is clearer.
     */
    function timeAgo(iso, t) {
      if (!iso) return "";
      const then = Date.parse(iso);
      if (!Number.isFinite(then)) return String(iso);
      const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
      if (seconds < 45) return t("page.queue.justNow");
      const minutes = Math.round(seconds / 60);
      if (minutes < 60) return t("page.queue.minutesAgo", { n: Math.max(1, minutes) });
      const hours = Math.round(minutes / 60);
      if (hours < 24) return t("page.queue.hoursAgo", { n: hours });
      const days = Math.round(hours / 24);
      if (days <= 7) return t("page.queue.daysAgo", { n: days });
      return shortTime(iso);
    }

    const FACTS_PAGE_SIZE = 100;
    // The stored run text is capped at 20k chars; rendering all of it at once is
    // what freezes a long record, so the panel shows one chunk at a time.
    const RUN_TEXT_CHUNK = 4000;

    function createPageController(ctx) {
      const store = createStore({
        tab: "facts",
        query: "",
        statusFilter: "live",
        facts: { loading: false, items: [], error: null, hasMore: false },
        recentSearches: [],
        detail: null,
        proposals: { loading: false, items: [], error: null },
        conflicts: { loading: false, groups: [], error: null },
        graph: { entity: "", view: "current", loading: false, data: null, error: null },
        queue: { loading: false, data: null, error: null, auto: 0, expanded: { id: "", loading: false, data: null, error: null, shown: RUN_TEXT_CHUNK } },
        status: null,
        // "New since you last looked", frozen at the moment the queue was opened:
        // marking it seen clears the server-side count, so the page keeps its own
        // copy until the tab is left.
        reviewDigest: null,
        op: null,
        toast: null,
      });
      const patch = store.patch;
      let queryTimer = null;
      let queueTimer = null;
      let toastTimer = null;
      // Every facts read takes a ticket. A slower, older answer must not land on
      // top of a newer query (type "a", type "ab", then the "a" answer arrives).
      let factsRequest = 0;
      // Same idea for the detail pane: clicking fact B while A is still loading
      // must not let A's late answer replace B, and closing must win over both.
      let detailRequest = 0;
      // Switching subject or view fires a new graph read; an older one must not
      // paint over it (and must not put its own subject back into the store).
      let graphRequest = 0;
      // The queue refresh is manual and polled; an older answer must not replace
      // a newer one, and overlapping polls are wasted work.
      let queueRequest = 0;

      const refreshStatus = () =>
        postJson("status", {}).then((payload) => {
          if (payload.ok) patch({ status: payload });
        });

      // ── feedback: one toast, dismissable, with undo when the act is reversible ──
      // A line of text under the tabs stayed forever: it was a receipt, not an
      // answer to "did that work, and can I take it back?".
      const dismissToast = () => {
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = null;
        patch({ toast: null });
      };

      const showToast = (next) => {
        if (toastTimer) clearTimeout(toastTimer);
        const toast = { id: operationId(), tone: "ok", ...next };
        const ttl = Number(toast.ttlMs) > 0 ? Number(toast.ttlMs) : toast.undo ? 8000 : toast.tone === "error" ? 8000 : 4200;
        patch({ toast });
        toastTimer = setTimeout(() => {
          toastTimer = null;
          patch({ toast: null });
        }, ttl);
        // In the page the timer belongs to the document; in a test process it
        // must not hold the event loop open for eight seconds.
        if (toastTimer && typeof toastTimer.unref === "function") toastTimer.unref();
        return toast.id;
      };

      const runUndo = () => {
        const toast = store.getSnapshot().toast;
        if (!toast || typeof toast.undo !== "function") return Promise.resolve();
        // Keep the toast until the undo actually answers: dismissing first made a
        // stale/refused undo look like it succeeded.
        return Promise.resolve()
          .then(() => toast.undo())
          .catch((error) =>
            showToast({
              tone: "error",
              key: "page.toast.undoFailed",
              message: String(error?.message ?? error ?? ""),
            }),
          );
      };

      const loadFacts = ({ append = false } = {}) => {
        const state = store.getSnapshot();
        const offset = append ? state.facts.items.length : 0;
        const ticket = (factsRequest += 1);
        patch({ facts: { ...state.facts, loading: true, error: null } });
        return postJson("facts", { query: state.query, status: state.statusFilter, limit: FACTS_PAGE_SIZE, offset }).then((payload) => {
          if (ticket !== factsRequest) return; // a newer read owns the list now
          const page = payload.ok ? payload.items || [] : [];
          // A failed append keeps what is already on screen; a failed first page
          // shows the error instead of a stale list. An offset page can repeat a
          // row when extraction writes between two reads, and duplicate ids also
          // break React keys — keep the first sighting.
          const merged = append ? [...state.facts.items, ...page] : page;
          const seen = new Set();
          const items = payload.ok
            ? merged.filter((fact) => {
                const id = fact && (fact.id ?? fact.factId);
                if (id == null) return true;
                if (seen.has(id)) return false;
                seen.add(id);
                return true;
              })
            : append
              ? state.facts.items
              : [];
          patch({
            facts: {
              loading: false,
              error: payload.ok ? null : payload.error || "failed",
              items,
              // A short page is the end. The route answers with rows, not a
              // COUNT(*), so this is a heuristic and never claims a total.
              hasMore: payload.ok ? page.length === FACTS_PAGE_SIZE : append ? state.facts.hasMore : false,
            },
          });
        });
      };

      const loadMoreFacts = () => {
        const state = store.getSnapshot();
        if (state.facts.loading || !state.facts.hasMore) return Promise.resolve();
        return loadFacts({ append: true });
      };

      const rememberSearch = (query) => {
        const text = String(query ?? "").trim();
        if (text === "") return;
        const previous = store.getSnapshot().recentSearches || [];
        patch({ recentSearches: [text, ...previous.filter((item) => item !== text)].slice(0, 5) });
      };

      const searchNow = (query) => {
        const text = String(query ?? "");
        if (queryTimer) {
          clearTimeout(queryTimer);
          queryTimer = null;
        }
        patch({ query: text });
        rememberSearch(text);
        return loadFacts();
      };

      const clearQuery = () => {
        patch({ query: "" });
        return loadFacts();
      };

      const notifyCopied = () => showToast({ key: "page.toast.copied" });
      const notifyCopyFailed = () => showToast({ tone: "error", key: "page.toast.copyFailed" });

      const dismissOp = () => {
        if (store.getSnapshot().op) patch({ op: null });
      };

      const loadProposals = () => {
        patch({ proposals: { loading: true, items: store.getSnapshot().proposals.items, error: null } });
        return postJson("proposals", { status: "pending" }).then((payload) => {
          patch({
            proposals: {
              loading: false,
              error: payload.ok ? null : payload.error || "failed",
              items: payload.ok ? payload.items || [] : [],
            },
          });
        });
      };

      const loadConflicts = () => {
        patch({ conflicts: { loading: true, groups: store.getSnapshot().conflicts.groups, error: null } });
        return postJson("conflicts", {}).then((payload) => {
          patch({
            conflicts: {
              loading: false,
              error: payload.ok ? null : payload.error || "failed",
              groups: payload.ok ? payload.groups || [] : [],
            },
          });
        });
      };

      const refreshAll = () =>
        Promise.all([refreshStatus(), loadFacts(), loadProposals(), loadConflicts()]).then(() => {
          const state = store.getSnapshot();
          // The graph is a projection of the facts: any refresh of the library can
          // invalidate it. Re-fetch when it is on screen (or when a stale copy is
          // held), instead of keeping a map of a store that has moved on.
          if (state.tab === "graph" || state.graph.data) loadGraph(state.graph.entity, state.graph.view);
        });

      // Opening the review queue is also the moment "what is new" becomes "what is
      // here": snapshot the count first, then mark it seen.
      const markReviewSeen = () => {
        const review = store.getSnapshot().status?.review;
        const fresh = Number(review?.newCount ?? 0);
        return postJson("review-seen", {}).then((payload) => {
          if (payload && payload.ok) refreshStatus();
          return payload;
        });
      };

      const setTab = (tab) => {
        const review = store.getSnapshot().status?.review;
        const fresh = Number(review?.newCount ?? 0);
        const reviewDigest =
          tab === "proposals" && fresh > 0
            ? { n: fresh, byKind: review?.newByKind && typeof review.newByKind === "object" ? review.newByKind : {} }
            : null;
        // A detail pane opened for one tab makes no sense on another.
        patch({ tab, detail: null, reviewDigest });
        const state = store.getSnapshot();
        if (tab === "proposals") markReviewSeen();
        if (tab === "proposals" && state.proposals.items.length === 0) loadProposals();
        if (tab === "conflicts" && state.conflicts.groups.length === 0) loadConflicts();
        // Opening the tab always re-reads the graph: a cached projection survives
        // writes, wipes and edits made from another session, and a stale map reads
        // as truth. This is also why "the store was wiped but the graph still had
        // nodes" happened once.
        if (tab === "graph") loadGraph(state.graph.entity || "", state.graph.view);
        if (tab === "queue") {
          // Entering the tab is a user request for live state: it must not be
          // swallowed by a loading flag left over from an earlier read.
          loadQueue({ force: true });
          armQueueTimer(store.getSnapshot().queue.auto);
        } else {
          // Leaving the tab stops the poll: the numbers would keep moving off screen.
          stopQueuePolling();
        }
      };

      const setQuery = (query) => {
        patch({ query });
        if (queryTimer) clearTimeout(queryTimer);
        queryTimer = setTimeout(() => loadFacts(), 240);
      };

      const setStatusFilter = (statusFilter) => {
        patch({ statusFilter });
        loadFacts();
      };

      const openFact = (factId) => {
        const ticket = (detailRequest += 1);
        patch({ detail: { kind: "fact", loading: true, error: null, data: null } });
        return postJson("fact", { factId }).then((payload) => {
          if (ticket !== detailRequest) return;
          patch({
            detail: payload.ok
              ? { kind: "fact", loading: false, error: null, data: payload }
              : { kind: "fact", loading: false, error: payload.error || "failed", data: null },
          });
        });
      };

      const openEntity = (entity) => {
        if (!entity) return Promise.resolve();
        const ticket = (detailRequest += 1);
        patch({ detail: { kind: "entity", loading: true, error: null, data: null } });
        return postJson("entity", { entity }).then((payload) => {
          if (ticket !== detailRequest) return;
          patch({
            detail: payload.ok
              ? { kind: "entity", loading: false, error: null, data: payload }
              : { kind: "entity", loading: false, error: payload.error || "failed", data: null },
          });
        });
      };

      const closeDetail = () => {
        detailRequest += 1;
        patch({ detail: null });
      };

      /**
       * Every mutating click carries the generation the page is showing and a
       * fresh operation id: the first makes a stale page refuse instead of
       * overwriting, the second makes a double click one write.
       */
      const fence = () => {
        const generation = store.getSnapshot().status?.generation;
        const body = { operationId: operationId() };
        if (typeof generation === "number") body.expectedGeneration = generation;
        return body;
      };

      const updateValue = (factId, value, expectedRevision, options = {}) => {
        const previous = store.getSnapshot().detail?.data?.fact;
        patch({ op: { status: "running", kind: "update" } });
        return postJson("fact-update", { factId, value, expectedRevision, ...fence() }).then((payload) => {
          if (!payload.ok) {
            patch({ op: { status: "failed", kind: "update", message: payload.error || "" } });
            // Silent means "don't announce the success", not "hide a refusal":
            // an undo that could not land must say so.
            showToast({ tone: "error", message: payload.error || "" });
            if (payload.stale) refreshAll();
            return payload;
          }
          patch({ op: { status: "done", kind: "update" } });
          // A value change supersedes the old row and inserts a new one, so the
          // detail pane must follow the new id — reopening the old one shows history.
          const currentId = payload.fact?.id ?? payload.factId ?? factId;
          const undo =
            previous && previous.id === factId && payload.fact
              ? () => updateValue(currentId, previous.value, payload.fact.recordRevision, { silent: true })
              : null;
          if (!options.silent) showToast({ key: "page.toast.updated", undo, undoKey: "page.undo" });
          return Promise.all([loadFacts(), refreshStatus(), openFact(currentId)]).then(() => payload);
        });
      };

      const restoreFact = (factId, expectedRevision) => {
        patch({ op: { status: "running", kind: "restore" } });
        return postJson("fact-restore", { factId, expectedRevision, ...fence() }).then((payload) => {
          if (!payload.ok) {
            patch({ op: { status: "failed", kind: "restore", message: payload.error || "" } });
            showToast({
              tone: "error",
              key: payload.stale ? "page.toast.restoreStale" : "page.toast.restoreFailed",
              message: payload.error || "",
            });
            if (payload.stale) refreshAll();
            return payload;
          }
          patch({ op: { status: "done", kind: "restore" } });
          showToast({ key: "page.toast.restored" });
          return Promise.all([loadFacts(), refreshStatus(), openFact(payload.fact.id)]).then(() => payload);
        });
      };

      const expireFact = (factId, expectedRevision, options = {}) => {
        patch({ op: { status: "running", kind: "expire" } });
        return postJson("fact-expire", { factId, expectedRevision, ...fence() }).then((payload) => {
          if (!payload.ok) {
            patch({ op: { status: "failed", kind: "expire", message: payload.error || "" } });
            showToast({ tone: "error", message: payload.error || "" });
            if (payload.stale) refreshAll();
            return payload;
          }
          patch({ op: { status: "done", kind: "expire" }, detail: null });
          const undo = payload.fact ? () => restoreFact(payload.fact.id, payload.fact.recordRevision) : null;
          if (!options.silent) showToast({ key: "page.toast.expired", undo, undoKey: "page.undo" });
          return Promise.all([loadFacts(), refreshStatus()]).then(() => payload);
        });
      };

      const acceptProposal = (proposalId) => {
        patch({ op: { status: "running", kind: "proposal" } });
        return postJson("proposal-apply", { proposalId, ...fence() }).then((payload) => {
          patch({
            op: payload.ok
              ? {
                  status: "done",
                  kind: "proposal",
                  // A health-check card has no single fact to name, and it may have
                  // had to leave some rows alone; both belong in the sentence.
                  factId: payload.factId ?? null,
                  skippedStale: payload.skippedStale ?? 0,
                }
              : { status: "failed", kind: "proposal", message: payload.error || "" },
          });
          if (payload.ok) {
            // A duplicate (or an already-applied proposal) points at a fact that
            // existed before this click. Expiring it would delete someone else's
            // fact, so only a created or superseding write can be undone.
            const undoable =
              payload.written === "saved" ||
              payload.written === true ||
              (payload.written === "superseded" && payload.previousValue != null);
            const undo =
              payload.factId && undoable
                ? () => {
                    const done =
                      payload.previousValue == null
                        ? expireFact(payload.factId, null, { silent: true })
                        : // Accepting a proposal replaced an older value. Expiring the
                          // new row would leave the slot empty, so put the old value back
                          // through the normal write path (which also fences revisions).
                          postJson("fact", { factId: payload.factId }).then((detail) => {
                            const fact = detail?.fact;
                            if (!detail?.ok || !fact) return null;
                            return updateValue(fact.id, String(payload.previousValue), fact.recordRevision, { silent: true });
                          });
                    return done.then((result) => {
                      if (result == null) {
                        showToast({ tone: "error", key: "page.toast.restoreFailed" });
                        return null;
                      }
                      // A refused undo already surfaced its own error; never claim
                      // success on top of it.
                      if (result.ok === false) return null;
                      showToast({ key: "page.toast.proposalUndone" });
                      return null;
                    });
                  }
                : null;
            showToast({ key: "page.toast.proposal", undo, undoKey: "page.undo" });
          } else {
            showToast({ tone: "error", message: payload.error || "" });
          }
          return Promise.all([loadProposals(), loadFacts(), refreshStatus()]).then(() => payload);
        });
      };

      // Striking one row out of an aggregated card: the card stays, one detail
      // goes. Quiet on purpose — it is an edit to a draft, not a decision.
      const pruneProposal = (proposalId, dropFactIds) => {
        return postJson("proposal-prune", { proposalId, dropFactIds, ...fence() }).then((payload) => {
          if (!payload.ok) {
            showToast({ tone: "error", message: payload.error || "" });
            return payload;
          }
          return Promise.all([loadProposals(), refreshStatus()]).then(() => payload);
        });
      };

      const rejectProposal = (proposalId) => {
        patch({ op: { status: "running", kind: "proposalReject" } });
        return postJson("proposal-reject", { proposalId, ...fence() }).then((payload) => {
          patch({
            op: payload.ok
              ? { status: "done", kind: "proposalReject" }
              : { status: "failed", kind: "proposalReject", message: payload.error || "" },
          });
          if (payload.ok) showToast({ key: "page.toast.proposalRejected" });
          else showToast({ tone: "error", message: payload.error || "" });
          return loadProposals().then(() => payload);
        });
      };

      const resolveConflict = (factId, decision) => {
        patch({ op: { status: "running", kind: "resolve" } });
        return postJson("resolve", { factId, decision, ...fence() }).then((payload) => {
          patch({
            op: payload.ok
              ? { status: "done", kind: "resolve" }
              : { status: "failed", kind: "resolve", message: payload.error || "" },
          });
          if (payload.ok) showToast({ key: "page.toast.resolved" });
          else showToast({ tone: "error", message: payload.error || "" });
          return Promise.all([loadConflicts(), loadFacts(), refreshStatus()]).then(() => payload);
        });
      };

      const setGraphEntity = (entity) => patch({ graph: { ...store.getSnapshot().graph, entity } });
      const setGraphView = (view) => {
        const state = store.getSnapshot();
        patch({ graph: { ...state.graph, view } });
        if (state.graph.entity) loadGraph(state.graph.entity, view);
      };

      const loadGraph = (entity, view) => {
        const state = store.getSnapshot();
        const target = typeof entity === "string" ? entity : state.graph.entity;
        const nextView = view || state.graph.view;
        const ticket = (graphRequest += 1);
        patch({ graph: { ...store.getSnapshot().graph, entity: target, view: nextView, loading: true, error: null } });
        // The page's graph tab is the 3D map, not the one-hop tree: ask for the
        // nebula projection (bounded) and let the component fall back to the SVG
        // tree when WebGL is unavailable.
        return postJson("graph", { entity: target, view: nextView, withFacts: true, mode: "nebula", maxNodes: 600, maxEdges: 1200 }).then((payload) => {
          if (ticket !== graphRequest) return; // a newer selection owns the map
          patch({
            graph: {
              entity: target,
              view: nextView,
              loading: false,
              error: payload.ok ? null : payload.error || "failed",
              data: payload.ok ? payload : null,
            },
          });
        });
      };

      // ── extraction queue ────────────────────────────────────────────────
      // The queue answers "is anything actually running?". It is live state, so it
      // is read on entry and on demand; polling is opt-in (5/10/15/30s) and only
      // runs while the tab is visible — a hidden interval is pure noise.
      // force exists because a stuck loading flag can otherwise lock the queue out for
      // good: afterWipe sets it before the first read, and a guard on it then refuses
      // the very read that would have cleared it — the tab sat on the loading text
      // until the page was remounted. A read the user asked for always runs; overlapping
      // reads are separated by the request ticket instead of by a flag.
      const loadQueue = ({ force = false } = {}) => {
        const current = store.getSnapshot().queue;
        if (current.loading && !force) return Promise.resolve();
        const ticket = ++queueRequest;
        patch({ queue: { ...current, loading: true, error: null } });
        const settle = (next) => {
          if (ticket !== queueRequest) return;
          patch({ queue: { ...store.getSnapshot().queue, ...next } });
        };
        return postJson("queue", {})
          .then((payload) => {
            settle({ loading: false, error: payload.ok ? null : payload.error || "failed", data: payload.ok ? payload : null });
          })
          .catch((error) => {
            // postJson already swallows a dead request; this is the belt for a patch
            // or a decode that throws, so a spinner can never outlive its request.
            settle({ loading: false, error: String(error?.message ?? error ?? "failed") });
          });
      };

      const armQueueTimer = (seconds) => {
        if (queueTimer) clearInterval(queueTimer);
        queueTimer = null;
        const period = Number(seconds) || 0;
        if (period <= 0 || typeof setInterval !== "function") return;
        queueTimer = setInterval(() => {
          if (store.getSnapshot().tab === "queue") loadQueue();
        }, period * 1000);
        // Never hold the process open (tests and one-off hosts share this code).
        if (queueTimer && typeof queueTimer.unref === "function") queueTimer.unref();
      };

      const setQueueAuto = (seconds) => {
        const period = Number(seconds) || 0;
        patch({ queue: { ...store.getSnapshot().queue, auto: period } });
        armQueueTimer(period);
      };

      // One finished pass, opened in place: the page answers "what did it read?"
      // from the persisted run log, not from a live buffer that a restart erases.
      const toggleExtractRun = (runId) => {
        const id = String(runId ?? "").trim();
        if (id === "") return Promise.resolve();
        const current = store.getSnapshot().queue;
        const expanded = current.expanded || { id: "", loading: false, data: null, error: null };
        if (expanded.id === id && !expanded.loading) {
          patch({ queue: { ...current, expanded: { id: "", loading: false, data: null, error: null, shown: RUN_TEXT_CHUNK } } });
          return Promise.resolve();
        }
        patch({ queue: { ...current, expanded: { id, loading: true, data: null, error: null, shown: RUN_TEXT_CHUNK } } });
        return postJson("extract-run", { id }).then((payload) => {
          const now = store.getSnapshot().queue;
          if (!now.expanded || now.expanded.id !== id) return;
          patch({
            queue: {
              ...now,
              expanded: {
                id,
                loading: false,
                data: payload.ok ? payload.run : null,
                error: payload.ok ? null : payload.error || "failed",
                shown: RUN_TEXT_CHUNK,
              },
            },
          });
        });
      };

      // One page of stored text at a time; the panel asks for more explicitly.
      const showMoreRunText = () => {
        const queue = store.getSnapshot().queue;
        const expanded = queue.expanded;
        const total = String(expanded?.data?.inputText ?? "").length;
        if (!expanded || total === 0) return;
        const shown = Math.min(total, Number(expanded.shown ?? RUN_TEXT_CHUNK) + RUN_TEXT_CHUNK);
        patch({ queue: { ...queue, expanded: { ...expanded, shown } } });
      };

      // The interval belongs to the mounted page, not to the controller: leaving
      // the page must stop it, and coming back must resume the chosen interval.
      const stopQueuePolling = () => {
        if (queueTimer) clearInterval(queueTimer);
        queueTimer = null;
      };

      const resumeQueuePolling = () => {
        if (store.getSnapshot().tab === "queue") armQueueTimer(store.getSnapshot().queue.auto);
      };

      const indexVectors = () => {
        patch({ op: { status: "running", kind: "vectors" } });
        return postJson("index-vectors", { ...fence() }, { timeoutMs: 120000 }).then((payload) => {
          patch({
            op: payload.ok
              ? { status: "done", kind: "vectors", message: payload.indexed === undefined ? "" : `${payload.indexed}` }
              : { status: "failed", kind: "vectors", message: payload.error || "" },
          });
          return Promise.all([refreshStatus()]).then(() => payload);
        });
      };

      return {
        store,
        // Called after a factory reset: the page must drop every cached list and
        // projection instead of showing the store it had before the wipe.
        afterWipe: () => {
          patch({
            detail: null,
            facts: { loading: true, items: [], error: null, hasMore: false },
            proposals: { loading: false, items: [], error: null },
            conflicts: { loading: false, groups: [], error: null },
            graph: { entity: "", view: store.getSnapshot().graph.view, loading: true, data: null, error: null },
            queue: { loading: true, data: null, error: null, auto: store.getSnapshot().queue.auto, expanded: { id: "", loading: false, data: null, error: null, shown: RUN_TEXT_CHUNK } },
          });
          return refreshAll()
            .then(() => loadGraph("", store.getSnapshot().graph.view))
            // A wipe is exactly the moment the queue list is stale, and exactly the
            // moment loading is already set: the read has to be forced.
            .then(() => loadQueue({ force: true }));
        },
        actions: {
          refreshAll,
          // The chat header shows a badge but never mounts the panel; a light
          // status-only refresh keeps that number honest without loading facts.
          refreshBadge: refreshStatus,
          setTab,
          setQuery,
          setSearch: searchNow,
          clearQuery,
          setStatusFilter,
          loadFacts,
          loadMoreFacts,
          dismissOp,
          notifyCopied,
        notifyCopyFailed,
          dismissToast,
          runUndo,
          openFact,
          openEntity,
          closeDetail,
          updateValue,
          restoreFact,
          expireFact,
          acceptProposal,
        pruneProposal,
        markReviewSeen,
          rejectProposal,
          resolveConflict,
          setGraphEntity,
          setGraphView,
          loadGraph,
          // The toolbar refresh and the tests both call this; a manual read is
          // always allowed to run.
          loadQueue: () => loadQueue({ force: true }),
          setQueueAuto,
          toggleExtractRun,
          showMoreRunText,
          stopQueuePolling,
          resumeQueuePolling,
          indexVectors,
        },
      };
    }

    // ── icons: inline, stroke-only, so nothing depends on a host icon package ──
    function Glyph({ kind, size = 16 }) {
      const paths = {
        memory: ["M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H9l-5 4v-4a3 3 0 0 1-0 0", "M8 9h8", "M8 12.5h5"],
        search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14", "M20 20l-4.2-4.2"],
        refresh: ["M20 12a8 8 0 1 1-2.6-5.9", "M20 4v4h-4"],
        close: ["M6 6l12 12", "M18 6L6 18"],
        graph: ["M6 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5", "M18 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4", "M18 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4", "M8.4 9.6l7.4-3.4", "M8.4 11.4l7.3 4.6"],
        spark: ["M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7", "M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8"],
        alert: ["M12 4l8.5 15h-17", "M12 10v4", "M12 16.5v.5"],
        clock: ["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16", "M12 8v4.4l3 1.8"],
        check: ["M5 12.5l4.2 4.2L19 6.8"],
        edit: ["M5 19h3.5L19 8.5a2.1 2.1 0 0 0-3-3L5.5 16V19", "M14.5 6.5l3 3"],
        chevron: ["M9 6l6 6-6 6"],
        layers: ["M12 4l8 4-8 4-8-4 8-4", "M4 12l8 4 8-4", "M4 16l8 4 8-4"],
        tag: ["M4 11V5h6l9 9-6 6-9-9", "M7.5 8.5a1 1 0 1 0 0-.01"],
      };
      const list = paths[kind] || paths.memory;
      return jsxs("svg", {
        className: "FM_glyph",
        viewBox: "0 0 24 24",
        width: size,
        height: size,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.6,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
        focusable: "false",
        children: list.map((d, index) => jsx("path", { d }, `p${index}`)),
      });
    }

    function MemoryPanelIcon({ size = 18 }) {
      return jsx(Glyph, { kind: "memory", size });
    }

    function StatCell({ label, value, hint, tone }) {
      return jsxs("div", {
        className: "FM_pgStat",
        children: [
          jsx("span", { className: "FM_pgStatLabel", children: label }),
          jsx("strong", { className: tone ? `FM_pgStatValue FM_pgTone_${tone}` : "FM_pgStatValue", children: String(value ?? 0) }),
          hint ? jsx("span", { className: "FM_pgStatHint", children: hint }) : null,
        ],
      });
    }

    // Color alone is not a label: the glyph keeps the four states apart for
    // people who cannot separate the tints, and survives a black-and-white print.
    const STATUS_GLYPHS = { active: "●", scheduled: "◔", conflict: "◆", expired: "○", superseded: "◌", forgotten: "×" };

    function StatusPill({ status, t }) {
      const tone = status === "conflict" ? "danger" : status === "scheduled" ? "warn" : status === "expired" || status === "superseded" ? "muted" : "ok";
      return jsxs("span", {
        className: `FM_pgPill FM_pgPill_${tone}`,
        children: [
          jsx("span", { className: "FM_pgPillGlyph", "aria-hidden": "true", children: STATUS_GLYPHS[status] || "•" }),
          t(`page.status.${status}`),
        ],
      });
    }

    /** "3 分钟前" answers "is this current?", the timestamp on hover answers "when exactly?". */
    function TimeAgo({ iso, zone, t }) {
      if (!iso) return jsx("span", { children: "-" });
      return jsx("time", { className: "FM_pgTimeAgo", dateTime: String(iso), title: shortTime(iso, zone), children: timeAgo(iso, t) });
    }

    function FactRow({ fact, t, selected, zone, onOpen, onEntity }) {
      return jsxs("article", {
        className: selected ? "FM_pgFact FM_pgFactOn" : "FM_pgFact",
        role: "button",
        tabIndex: 0,
        onClick: () => onOpen(fact.id),
        onKeyDown: (event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen(fact.id);
          }
        },
        children: [
          jsxs("div", {
            className: "FM_pgFactTop",
            children: [
              jsx("button", {
                className: "FM_pgEntity",
                type: "button",
                title: t("page.openEntity"),
                onClick: (event) => {
                  event.stopPropagation();
                  onEntity(fact.entity);
                },
                children: fact.entity,
              }),
              jsx("span", { className: "FM_pgSep", children: "·" }),
              jsx("span", { className: "FM_pgPred", children: fact.predicate }),
              jsx(StatusPill, { status: fact.status, t }),
            ],
          }),
          jsx("p", { className: "FM_pgValue", children: fact.secret ? MASKED : fact.value }),
          jsxs("div", {
            className: "FM_pgMeta",
            children: [
              jsx(TimeAgo, { iso: fact.observedAt, zone, t }),
              jsx("span", { className: "FM_pgDot" }),
              jsx("span", { children: t(`page.evidence.${fact.evidenceLevel}`) }),
              jsx("span", { className: "FM_pgDot" }),
              jsx("span", { className: "FM_pgId", children: `#${String(fact.id).slice(0, 8)}` }),
              fact.sources ? jsx("span", { className: "FM_pgSources", children: t("page.sourceCount", { n: fact.sources }) }) : null,
            ],
          }),
        ],
      });
    }

    function EmptyState({ icon, title, hint, action }) {
      return jsxs("div", {
        className: "FM_pgEmpty",
        children: [
          jsx("span", { className: "FM_pgEmptyIcon", children: jsx(Glyph, { kind: icon, size: 22 }) }),
          jsx("p", { className: "FM_pgEmptyTitle", children: title }),
          hint ? jsx("p", { className: "FM_pgEmptyHint", children: hint }) : null,
          action || null,
        ],
      });
    }

    // A skeleton keeps the layout from jumping when rows arrive, and reads as
    // "working", not as "this page has no rows".
    function FactSkeleton({ rows = 3 }) {
      return jsx("div", {
        className: "FM_pgSkeleton",
        "aria-hidden": "true",
        children: Array.from({ length: rows }, (_unused, index) => jsx("div", { className: "FM_pgSkeletonRow" }, String(index))),
      });
    }

    function ToastView({ toast, t, onUndo, onDismiss }) {
      if (!toast) return null;
      const text = toast.key ? t(toast.key, toast.params || {}) : toast.message || "";
      return jsxs("div", {
        className: toast.tone === "error" ? "FM_pgToast FM_pgToastBad" : "FM_pgToast",
        role: "status",
        "aria-live": "polite",
        children: [
          jsxs("div", {
            className: "FM_pgToastBody",
            children: [
              jsx("p", { className: "FM_pgToastText", children: text }),
              toast.message && toast.key ? jsx("p", { className: "FM_pgToastMsg", children: toast.message }) : null,
            ],
          }),
          jsxs("div", {
            className: "FM_pgToastActions",
            children: [
              toast.undo
                ? jsx("button", { className: "FM_pgToastUndo", type: "button", onClick: onUndo, children: t(toast.undoKey || "page.undo") })
                : null,
              jsx("button", { className: "FM_pgToastClose", type: "button", "aria-label": t("page.close"), onClick: onDismiss, children: "×" }),
            ],
          }),
        ],
      });
    }

    function FactDetail({ detail, t, zone, actions }) {
      const [editing, setEditing] = useState(null);
      const [revealed, setRevealed] = useState(false);
      // The pane is reused between facts: a reveal must not follow the user to the
      // next fact, or a masked credential would show itself unasked.
      const factKey = detail.data?.fact?.id ?? null;
      useEffect(() => {
        setRevealed(false);
        setEditing(null);
      }, [factKey]);
      const fact = detail.data?.fact;
      if (!fact) return null;
      const shownValue = fact.secret && !revealed ? MASKED : fact.value;
      const history = detail.data.history || [];
      const sources = detail.data.sources || [];
      return jsxs("aside", {
        className: "FM_pgRail",
        children: [
          jsxs("div", {
            className: "FM_pgRailHead",
            children: [
              jsxs("div", {
                className: "FM_pgRailTitle",
                children: [
                  jsx("span", { className: "FM_pgEntity", children: fact.entity }),
                  jsx("span", { className: "FM_pgSep", children: "·" }),
                  jsx("span", { className: "FM_pgPred", children: fact.predicate }),
                ],
              }),
              jsx("button", { className: "FM_pgIconBtn", type: "button", "aria-label": t("page.close"), onClick: actions.closeDetail, children: jsx(Glyph, { kind: "close", size: 15 }) }),
            ],
          }),
          jsxs("div", {
            className: "FM_pgRailPills",
            children: [
              jsx(StatusPill, { status: fact.status, t }),
              fact.secret ? jsx("span", { className: "FM_pgPill FM_pgPill_warn", children: t("page.secret") }) : null,
            ],
          }),
          editing === null
            ? jsxs("div", {
                className: "FM_pgRailValueRow",
                children: [
                  jsx("p", { className: "FM_pgRailValue", children: shownValue }),
                  fact.secret
                    ? jsx("button", {
                        className: "FM_pgMiniBtn",
                        type: "button",
                        onClick: () => setRevealed((value) => !value),
                        children: t(revealed ? "page.hide" : "page.reveal"),
                      })
                    : null,
                ],
              })
            : jsxs("div", {
                className: "FM_pgEdit",
                children: [
                  jsx("input", {
                    className: "FM_pgInput",
                    value: editing,
                    type: fact.secret && !revealed ? "password" : "text",
                    autoComplete: "off",
                    spellCheck: false,
                    autoFocus: true,
                    onChange: (event) => setEditing(event.target.value),
                    onKeyDown: (event) => {
                      // Enter while an IME is composing commits the candidate,
                      // not the field: writing there stores half a value.
                      const composing = event.isComposing === true || event.keyCode === 229;
                      if (event.key === "Enter" && !composing) actions.updateValue(fact.id, editing.trim(), fact.recordRevision).then((result) => result.ok && setEditing(null));
                      if (event.key === "Escape") setEditing(null);
                    },
                  }),
                  jsxs("div", {
                    className: "FM_pgEditRow",
                    children: [
                      jsx("button", { className: "FM_pgPrimary", type: "button", disabled: editing.trim() === "" || editing.trim() === fact.value, onClick: () => actions.updateValue(fact.id, editing.trim(), fact.recordRevision).then((result) => result.ok && setEditing(null)), children: t("page.save") }),
                      jsx("button", { className: "FM_pgGhost", type: "button", onClick: () => setEditing(null), children: t("page.cancel") }),
                    ],
                  }),
                ],
              }),
          jsxs("div", {
            className: "FM_pgRailActions",
            children: [
              editing === null
                ? jsxs("button", { className: "FM_pgGhost", type: "button", onClick: () => setEditing(fact.secret && !revealed ? "" : fact.value), children: [jsx(Glyph, { kind: "edit", size: 14 }), t("page.edit")] })
                : null,
              fact.status === "active" || fact.status === "scheduled"
                ? jsxs("button", {
                    className: "FM_pgGhost FM_pgDanger",
                    type: "button",
                    onClick: () => actions.expireFact(fact.id, fact.recordRevision),
                    children: [jsx(Glyph, { kind: "clock", size: 14 }), t("page.expire")],
                  })
                : null,
            ],
          }),
          jsxs("div", {
            className: "FM_pgRailSection",
            children: [
              jsx("p", { className: "FM_pgRailLabel", children: t("page.meta") }),
              jsxs("dl", {
                className: "FM_pgMetaList",
                children: [
                  jsx("dt", { children: t("page.metaScope") }),
                  jsx("dd", { children: fact.scope || "global" }),
                  jsx("dt", { children: t("page.metaObserved") }),
                  jsx("dd", { children: jsx(TimeAgo, { iso: fact.observedAt, zone, t }) }),
                  jsx("dt", { children: t("page.metaRevision") }),
                  jsx("dd", { children: String(fact.recordRevision) }),
                  jsx("dt", { children: t("page.metaValid") }),
                  jsx("dd", { children: `${fact.validFrom ? shortTime(fact.validFrom, zone) : t("page.metaFromStart")} → ${fact.validTo ? shortTime(fact.validTo, zone) : t("page.metaOpen")}` }),
                ],
              }),
            ],
          }),
          jsxs("div", {
            className: "FM_pgRailSection",
            children: [
              jsx("p", { className: "FM_pgRailLabel", children: t("page.sources") }),
              sources.length === 0
                ? jsx("p", { className: "FM_pgMuted", children: t("page.noSources") })
                : jsx("ul", {
                    className: "FM_pgSourceList",
                    children: sources.map((source, index) =>
                      jsxs(
                        "li",
                        {
                          children: [
                            jsx("span", { className: "FM_pgSourceKind", children: source.sourceType || source.namespace || "source" }),
                            jsx("span", { className: "FM_pgSourceQuote", children: source.quote || source.evidenceHash || "" }),
                            jsx("span", { className: "FM_pgMeta", children: jsx(TimeAgo, { iso: source.observedAt || source.createdAt, zone, t }) }),
                          ],
                        },
                        `${source.id ?? index}`,
                      ),
                    ),
                  }),
            ],
          }),
          jsxs("div", {
            className: "FM_pgRailSection",
            children: [
              jsx("p", { className: "FM_pgRailLabel", children: t("page.history") }),
              jsx("ol", {
                className: "FM_pgTimeline",
                children: history.map((row, index) =>
                  jsxs(
                    "li",
                    {
                      className: row.id === fact.id ? "FM_pgTimelineOn" : "",
                      children: [
                        jsx("span", { className: `FM_pgDot FM_pgDot_${row.status === "active" ? "ok" : row.status === "conflict" ? "danger" : "muted"}` }),
                        jsxs("div", {
                          children: [
                            jsx("p", { className: "FM_pgTimelineValue", children: fact.secret && !revealed ? MASKED : row.value }),
                            jsxs("p", {
                              className: "FM_pgTimelineMeta",
                              children: [
                                jsx(StatusPill, { status: row.status, t }),
                                jsx(TimeAgo, { iso: row.observedAt, zone, t }),
                              ],
                            }),
                          ],
                        }),
                      ],
                    },
                    `${row.id}-${index}`,
                  ),
                ),
              }),
            ],
          }),
        ],
      });
    }

    function EntityDetail({ detail, t, zone, actions }) {
      if (!detail.data) return null;
      // The projection hands back the entity row; older payloads hand back a
      // name. React refuses to render an object as a child, and that throw took
      // the whole page down, so the title is always reduced to a string here.
      const entityName =
        typeof detail.data.entity === "string"
          ? detail.data.entity
          : String(detail.data.entity?.name ?? detail.data.entity?.id ?? "");
      const facts = Array.isArray(detail.data.facts) ? detail.data.facts : [];
      return jsxs("aside", {
        className: "FM_pgRail",
        children: [
          jsxs("div", {
            className: "FM_pgRailHead",
            children: [
              jsx("div", { className: "FM_pgRailTitle", children: jsx("span", { className: "FM_pgEntityLg", children: entityName }) }),
              jsx("button", { className: "FM_pgIconBtn", type: "button", "aria-label": t("page.close"), onClick: actions.closeDetail, children: jsx(Glyph, { kind: "close", size: 15 }) }),
            ],
          }),
          jsx("p", { className: "FM_pgMuted", children: t("page.entityCount", { n: facts.length }) }),
          jsx("div", {
            className: "FM_pgEntityFacts",
            children: facts.map((fact) =>
              jsxs(
                "button",
                {
                  className: "FM_pgEntityFact",
                  type: "button",
                  onClick: () => actions.openFact(fact.id),
                  children: [
                    jsx("span", { className: "FM_pgPred", children: fact.predicate }),
                    jsx("span", { className: "FM_pgValueSm", children: fact.secret ? MASKED : fact.value }),
                    jsx(StatusPill, { status: fact.status, t }),
                  ],
                },
                fact.id,
              ),
            ),
          }),
        ],
      });
    }

    // ══ nebula engine (embedded verbatim from .tmp-nebula/nebula-engine.js) ══
    // WebGL1 galaxy renderer + 2D label layer + 3D force layout. It knows
    // nothing about facts; the caller hands over nodes/edges that already carry
    // labels, and the canvas draws deep space. The standalone preview page
    // imports the same file, so there is exactly one renderer, not two.
    /* ── nebula engine ─────────────────────────────────────────────────────────
     * WebGL1 galaxy renderer + 2D label layer + 3D force layout. Self-contained and
     * framework-free: the caller hands over nodes/edges that already carry labels,
     * and it draws deep space. client.js embeds this exact block (verified by the
     * splice script) and the standalone preview page imports the same file, so
     * there is one renderer, not two.
     *
     * The pipeline is: force-ish layout in world units → perspective camera →
     * additive Gaussian point sprites for nodes (depth-tested) → depth-tested line
     * segments for edges → 2D canvas labels → 2D canvas star field behind it all.
     */

    const NEBULA_LAYOUT_VERSION = 3;
    const NEBULA_LAYOUT_CACHE = new Map();
    const NEBULA_FOV = (55 * Math.PI) / 180;

    // The probe context is expensive and browser-capped (~16 live contexts), so it
    // is created once per page lifetime. A missing document is not cached: the probe
    // may legitimately run before a DOM exists.
    let nebulaWebglProbe = null;
    function nebulaWebglAvailable() {
      if (nebulaWebglProbe !== null) return nebulaWebglProbe;
      if (typeof document === "undefined") return false;
      try {
        const probe = document.createElement("canvas");
        nebulaWebglProbe = !!(probe.getContext("webgl") || probe.getContext("experimental-webgl"));
      } catch (_error) {
        nebulaWebglProbe = false;
      }
      return nebulaWebglProbe;
    }

    function nebulaHexToRgb(hex) {
      const text = String(hex || "#9fb6cc").replace("#", "");
      const full = text.length === 3 ? text.split("").map((c) => c + c).join("") : text;
      const number = parseInt(full, 16);
      if (!Number.isFinite(number)) return [0.62, 0.72, 0.86];
      return [((number >> 16) & 255) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255];
    }

    function nebulaHash(text) {
      let hash = 2166136261 >>> 0;
      const value = String(text);
      for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      return hash >>> 0;
    }

    function nebulaClamp(value, low, high) {
      return value < low ? low : value > high ? high : value;
    }

    function nebulaMat4() {
      return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    }

    /** Column-major perspective, 1 unit = 1px at distance 1. */
    function nebulaPerspective(out, fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2);
      out.fill(0);
      out[0] = f / aspect;
      out[5] = f;
      out[10] = (far + near) / (near - far);
      out[11] = -1;
      out[14] = (2 * far * near) / (near - far);
      return out;
    }

    /** Camera sits on a sphere around its target and looks at it. */
    function nebulaLookAt(out, yaw, pitch, dist, tx, ty, tz) {
      const cy = Math.cos(yaw);
      const sy = Math.sin(yaw);
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const ex = tx + dist * cp * sy;
      const ey = ty + dist * sp;
      const ez = tz + dist * cp * cy;
      let zx = ex - tx;
      let zy = ey - ty;
      let zz = ez - tz;
      let length = Math.hypot(zx, zy, zz) || 1;
      zx /= length;
      zy /= length;
      zz /= length;
      let xx = zz;
      let xy = 0;
      let xz = -zx;
      length = Math.hypot(xx, xy, xz) || 1;
      xx /= length;
      xy /= length;
      xz /= length;
      const yx = zy * xz - zz * xy;
      const yy = zz * xx - zx * xz;
      const yz = zx * xy - zy * xx;
      out[0] = xx;
      out[1] = yx;
      out[2] = zx;
      out[3] = 0;
      out[4] = xy;
      out[5] = yy;
      out[6] = zy;
      out[7] = 0;
      out[8] = xz;
      out[9] = yz;
      out[10] = zz;
      out[11] = 0;
      out[12] = -(xx * ex + xy * ey + xz * ez);
      out[13] = -(yx * ex + yy * ey + yz * ez);
      out[14] = -(zx * ex + zy * ey + zz * ez);
      out[15] = 1;
      return out;
    }

    /** Palette: entity types own the galaxy's hue, conflict is always warm red. */
    const NEBULA_TYPE_COLOR = {
      person: [0.5, 0.94, 0.78],
      project: [0.42, 0.78, 1.0],
      host: [1.0, 0.85, 0.54],
      service: [0.55, 0.88, 1.0],
      convention: [0.76, 0.61, 1.0],
    };
    const NEBULA_VALUE_COLOR = [0.5, 0.62, 0.8];

    function nebulaColorOf(node) {
      if (node.status === "conflict") return [1.0, 0.4, 0.3];
      if (node.status === "scheduled") return [1.0, 0.76, 0.36];
      if (node.kind === "entity") return NEBULA_TYPE_COLOR[node.entityType] || [0.62, 0.78, 0.98];
      return NEBULA_VALUE_COLOR;
    }

    function createNebulaEngine(options) {
      const settings = options || {};
      const glCanvas = settings.glCanvas;
      const labelCanvas = settings.labelCanvas;
      const bgCanvas = settings.bgCanvas || null;
      const loadingText = String(settings.loadingText || "…");
      const maxNodes = Math.max(1, Number(settings.maxNodes) || 600);
      const maxEdges = Math.max(1, Number(settings.maxEdges) || 1200);
      if (!glCanvas) throw new Error("nebula: no canvas");

      const gl = glCanvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: false, depth: true });
      if (!gl) throw new Error("nebula: WebGL unavailable");
      const lctx = labelCanvas ? labelCanvas.getContext("2d") : null;
      const bctx = bgCanvas ? bgCanvas.getContext("2d") : null;

      const state = {
        nodes: [],
        edges: [],
        byId: new Map(),
        hover: null,
        spin: settings.spin !== false,
        labels: settings.labels !== false,
        cam: { yaw: 0.62, pitch: 0.24, dist: 1900, tx: 0, ty: 0, tz: 0 },
        size: { w: 1, h: 1, dpr: 1 },
        drag: null,
        lastPointer: null,
        // Idle rotation may resume immediately on first paint; any interaction then
        // pushes it 3 s into the future.
        lastInteraction: -1e9,
        proj: nebulaMat4(),
        view: nebulaMat4(),
        layout: { running: false, alpha: 0.95, iter: 0, ticks: 160, cacheKey: "", signature: "" },
        stars: [],
        starSignature: "",
        backdrop: null,
        backdropSignature: "",
        raf: 0,
        running: false,
        disposed: false,
        needDraw: true,
        lastFrame: 0,
        tmp: [0, 0, 0, 0],
        bufferDirty: true,
      };

      // ---------- GL programs ----------
      function compile(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("nebula shader: " + gl.getShaderInfoLog(shader));
        return shader;
      }
      function program(vertexSource, fragmentSource) {
        const result = gl.createProgram();
        gl.attachShader(result, compile(gl.VERTEX_SHADER, vertexSource));
        gl.attachShader(result, compile(gl.FRAGMENT_SHADER, fragmentSource));
        gl.linkProgram(result);
        if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error("nebula program: " + gl.getProgramInfoLog(result));
        return result;
      }

      // Nodes: a billboard whose fragment shader is a Gaussian glow. The sprite is
      // depth-tested and writes depth inside its disc, so near stars occlude far
      // stars and edges run behind them instead of through them.
      const nodeProgram = program(
        [
          "attribute vec3 aCenter;",
          "attribute vec3 aColor;",
          "attribute float aSize;",
          "attribute float aAlpha;",
          "uniform mat4 uProj;",
          "uniform mat4 uView;",
          "uniform float uPxScale;",
          "uniform vec2 uFog;",
          "varying vec3 vColor;",
          "varying float vAlpha;",
          "varying float vFog;",
          "void main() {",
          "  vec4 mv = uView * vec4(aCenter, 1.0);",
          "  gl_Position = uProj * mv;",
          "  float dist = max(1.0, -mv.z);",
          "  gl_PointSize = clamp((aSize * uPxScale) / dist, 2.0, 140.0);",
          "  vColor = aColor;",
          "  vAlpha = aAlpha;",
          "  vFog = clamp((dist - uFog.x) / uFog.y, 0.0, 0.82);",
          "}",
        ].join("\n"),
        [
          "precision mediump float;",
          "varying vec3 vColor;",
          "varying float vAlpha;",
          "varying float vFog;",
          "void main() {",
          "  vec2 p = gl_PointCoord * 2.0 - 1.0;",
          "  float r = length(p);",
          "  if (r > 1.0) discard;",
          "  float core = exp(-r * r * 4.6);",
          "  float halo = pow(max(0.0, 1.0 - r), 2.2) * 0.72;",
          "  vec3 color = vColor * (1.0 + 0.55 * core);",
          "  float alpha = (core * 1.0 + halo * 0.85) * vAlpha * (1.0 - vFog * 0.62);",
          "  gl_FragColor = vec4(color, alpha);",
          "}",
        ].join("\n"),
      );
      const nodeLoc = {
        center: gl.getAttribLocation(nodeProgram, "aCenter"),
        color: gl.getAttribLocation(nodeProgram, "aColor"),
        size: gl.getAttribLocation(nodeProgram, "aSize"),
        alpha: gl.getAttribLocation(nodeProgram, "aAlpha"),
        proj: gl.getUniformLocation(nodeProgram, "uProj"),
        view: gl.getUniformLocation(nodeProgram, "uView"),
        pxScale: gl.getUniformLocation(nodeProgram, "uPxScale"),
        fog: gl.getUniformLocation(nodeProgram, "uFog"),
      };

      // Edges: world-space line segments, depth-tested against the node depth
      // buffer, additive and dim, with fog. Emitted as one draw call per frame.
      const edgeProgram = program(
        [
          "attribute vec3 aPos;",
          "attribute vec4 aColor;",
          "uniform mat4 uProj;",
          "uniform mat4 uView;",
          "uniform vec2 uFog;",
          "varying vec4 vColor;",
          "void main() {",
          "  vec4 mv = uView * vec4(aPos, 1.0);",
          "  gl_Position = uProj * mv;",
          "  float dist = max(1.0, -mv.z);",
          "  float fog = clamp((dist - uFog.x) / uFog.y, 0.0, 0.9);",
          "  vColor = vec4(aColor.rgb, aColor.a * (1.0 - fog * 0.78));",
          "}",
        ].join("\n"),
        ["precision mediump float;", "varying vec4 vColor;", "void main() { gl_FragColor = vColor; }"].join("\n"),
      );
      const edgeLoc = {
        pos: gl.getAttribLocation(edgeProgram, "aPos"),
        color: gl.getAttribLocation(edgeProgram, "aColor"),
        proj: gl.getUniformLocation(edgeProgram, "uProj"),
        view: gl.getUniformLocation(edgeProgram, "uView"),
        fog: gl.getUniformLocation(edgeProgram, "uFog"),
      };

      const buffers = {
        nodeCenter: gl.createBuffer(),
        nodeColor: gl.createBuffer(),
        nodeSize: gl.createBuffer(),
        nodeAlpha: gl.createBuffer(),
        edgePos: gl.createBuffer(),
        edgeColor: gl.createBuffer(),
      };

      // ---------- colours / sizes ----------
      function prepareNodes(nodes) {
        for (const node of nodes) {
          const rgb = nebulaColorOf(node);
          node._rgb = rgb;
          const weight = Math.log2(2 + Math.max(0, Number(node.factCount) || 0) + Math.max(0, Number(node.degree) || 0) * 1.1);
          // Large stars, not dots: additive glow is most of what makes this a
          // nebula instead of a scatter plot, so size scales with evidence weight.
          node._worldR = node.kind === "entity" ? 26 + weight * 13 : 17 + weight * 9;
          node._alpha = node.kind === "entity" ? 1.0 : 0.9;
        }
      }

      // ---------- layout ----------
      function layoutSignature(data) {
        const ids = state.nodes.map((node) => node.id).join("|");
        return "nb:" + NEBULA_LAYOUT_VERSION + ":" + (data.view || "") + ":" + (data.seeds || []).length + ":" + nebulaHash(ids);
      }

      function seedPositions() {
        const nodes = state.nodes;
        const golden = Math.PI * (3 - Math.sqrt(5));
        nodes.forEach((node, index) => {
          const y = 1 - (index / Math.max(1, nodes.length - 1)) * 2;
          const ring = Math.sqrt(Math.max(0, 1 - y * y));
          const theta = golden * index;
          const shell = 340 + (nebulaHash(node.id) % 1000) / 1000 * 300;
          node.x = Math.cos(theta) * ring * shell;
          node.y = y * shell * 0.62;
          node.z = Math.sin(theta) * ring * shell;
          node.vx = 0;
          node.vy = 0;
          node.vz = 0;
        });
      }

      function restoreLayout() {
        const cached = NEBULA_LAYOUT_CACHE.get(state.layout.cacheKey);
        if (!cached || cached.length !== state.nodes.length * 3) return false;
        state.nodes.forEach((node, index) => {
          node.x = cached[index * 3];
          node.y = cached[index * 3 + 1];
          node.z = cached[index * 3 + 2];
          node.vx = 0;
          node.vy = 0;
          node.vz = 0;
        });
        return true;
      }

      function saveLayout() {
        try {
          const flat = new Array(state.nodes.length * 3);
          state.nodes.forEach((node, index) => {
            flat[index * 3] = Math.round(node.x);
            flat[index * 3 + 1] = Math.round(node.y);
            flat[index * 3 + 2] = Math.round(node.z);
          });
          // Cache by dataset, but never grow without bound: the map holds at most
          // a screenful of recently visited subjects.
          if (NEBULA_LAYOUT_CACHE.size >= 24) {
            const oldest = NEBULA_LAYOUT_CACHE.keys().next().value;
            if (oldest !== undefined) NEBULA_LAYOUT_CACHE.delete(oldest);
          }
          NEBULA_LAYOUT_CACHE.set(state.layout.cacheKey, flat);
        } catch (_error) {
          /* the cache is an optimisation, never a requirement */
        }
      }

      /**
       * One force step: pairwise repulsion (O(n^2/2), bounded by maxNodes), spring
       * per edge with rest length growing with fact count, and weak gravity toward
       * the origin so a sparse graph does not drift away from the camera.
       */
      function forceStep(alpha) {
        const nodes = state.nodes;
        const count = nodes.length;
        const repulse = 26000;
        for (let i = 0; i < count; i++) {
          const a = nodes[i];
          for (let j = i + 1; j < count; j++) {
            const b = nodes[j];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const dz = a.z - b.z;
            const distanceSquared = dx * dx + dy * dy + dz * dz + 60;
            if (distanceSquared > 900000) continue;
            const factor = repulse / distanceSquared;
            const inverse = 1 / Math.sqrt(distanceSquared);
            const fx = dx * inverse * factor;
            const fy = dy * inverse * factor;
            const fz = dz * inverse * factor;
            a.vx += fx;
            a.vy += fy;
            a.vz += fz;
            b.vx -= fx;
            b.vy -= fy;
            b.vz -= fz;
          }
        }
        for (const edge of state.edges) {
          const a = edge._a;
          const b = edge._b;
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dz = b.z - a.z;
          const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.001;
          const rest = 92 + Math.min(120, (Number(edge.factCount) || 1) * 26);
          const strength = (0.028 * (distance - rest)) / distance;
          const fx = dx * strength;
          const fy = dy * strength;
          const fz = dz * strength;
          a.vx += fx;
          a.vy += fy;
          a.vz += fz;
          b.vx -= fx;
          b.vy -= fy;
          b.vz -= fz;
        }
        for (const node of nodes) {
          node.vx -= node.x * 0.00042;
          node.vy -= node.y * 0.00062;
          node.vz -= node.z * 0.00042;
          node.vx *= 0.86;
          node.vy *= 0.86;
          node.vz *= 0.86;
          const step = Math.hypot(node.vx, node.vy, node.vz);
          const limit = 14;
          if (step > limit) {
            node.vx = (node.vx / step) * limit;
            node.vy = (node.vy / step) * limit;
            node.vz = (node.vz / step) * limit;
          }
          node.x += node.vx * alpha;
          node.y += node.vy * alpha;
          node.z += node.vz * alpha;
          if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.z)) {
            node.x = 0;
            node.y = 0;
            node.z = 0;
            node.vx = 0;
            node.vy = 0;
            node.vz = 0;
          }
        }
      }

      function fitCamera(instant) {
        let radius = 1;
        for (const node of state.nodes) radius = Math.max(radius, Math.hypot(node.x, node.y, node.z));
        const distance = nebulaClamp((radius / Math.tan(NEBULA_FOV / 2)) * 1.28, 420, 14000);
        if (instant) {
          state.cam.dist = distance;
          state.cam.tx = 0;
          state.cam.ty = 0;
          state.cam.tz = 0;
        } else {
          state.cam.dist = distance;
        }
        state.needDraw = true;
      }

      // ---------- data ----------
      function setData(data) {
        const sourceNodes = Array.isArray(data && data.nodes) ? data.nodes : [];
        const nodes = sourceNodes.slice(0, maxNodes).map((node) => ({
          ...node,
          x: 0,
          y: 0,
          z: 0,
          vx: 0,
          vy: 0,
          vz: 0,
        }));
        const ids = new Set(nodes.map((node) => node.id));
        const byId = new Map(nodes.map((node) => [node.id, node]));
        const edges = (Array.isArray(data && data.edges) ? data.edges : [])
          .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
          .slice(0, maxEdges)
          .map((edge) => ({ ...edge, _a: byId.get(edge.source), _b: byId.get(edge.target) }));
        prepareNodes(nodes);
        state.nodes = nodes;
        state.edges = edges;
        state.byId = byId;
        state.hover = null;
        state.layout.running = nodes.length > 1;
        state.layout.alpha = 0.95;
        state.layout.iter = 0;
        // 600 nodes cost ~180k pair computations per step; 150 steps keeps the
        // first paint under a fifth of a second and still settles the shape.
        state.layout.ticks = nodes.length >= 300 ? 150 : 260;
        state.layout.cacheKey = (data && data.cacheKey) || layoutSignature(data || {});
        state.layout.signature = layoutSignature(data || {});
        state.layoutDone = false;
        state.bufferDirty = true;
        if (nodes.length === 0) {
          state.layout.running = false;
          state.layoutDone = true;
          state.needDraw = true;
          return;
        }
        if (nodes.length === 1) {
          const only = nodes[0];
          only.x = 0;
          only.y = 0;
          only.z = 0;
          state.layout.running = false;
          state.layoutDone = true;
          fitCamera(true);
          return;
        }
        if (restoreLayout()) {
          state.layout.running = false;
          state.layoutDone = true;
          fitCamera(true);
        } else {
          seedPositions();
        }
        state.needDraw = true;
      }

      // ---------- mat / projection ----------
      function updateMatrices() {
        const { w, h } = state.size;
        nebulaPerspective(state.proj, NEBULA_FOV, Math.max(0.2, w / h), 1, 40000);
        nebulaLookAt(state.view, state.cam.yaw, state.cam.pitch, state.cam.dist, state.cam.tx, state.cam.ty, state.cam.tz);
      }

      /** Same maths as the vertex shader, in JS: labels, picking and hit rings need it. */
      function project(x, y, z, out) {
        const v = state.view;
        const p = state.proj;
        const vx = v[0] * x + v[4] * y + v[8] * z + v[12];
        const vy = v[1] * x + v[5] * y + v[9] * z + v[13];
        const vz = v[2] * x + v[6] * y + v[10] * z + v[14];
        const cx = p[0] * vx + p[8] * vz;
        const cy = p[5] * vy + p[9] * vz;
        const cw = -vz || 1;
        out[0] = (cx / cw) * 0.5 * state.size.w + state.size.w * 0.5;
        out[1] = state.size.h * 0.5 - (cy / cw) * 0.5 * state.size.h;
        out[2] = -vz;
        out[3] = (p[5] * state.size.h * 0.5) / Math.max(1, -vz);
        return out;
      }

      // ---------- buffers ----------
      function rebuildNodeBuffers() {
        const nodes = state.nodes;
        const count = nodes.length;
        const centers = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);
        const sizes = new Float32Array(count);
        const alphas = new Float32Array(count);
        const hover = state.hover;
        const highlighted = new Set();
        if (hover) {
          highlighted.add(hover);
          for (const edge of state.edges) {
            if (edge.source === hover) highlighted.add(edge.target);
            if (edge.target === hover) highlighted.add(edge.source);
          }
        }
        for (let index = 0; index < count; index++) {
          const node = nodes[index];
          centers[index * 3] = node.x;
          centers[index * 3 + 1] = node.y;
          centers[index * 3 + 2] = node.z;
          const rgb = node._rgb;
          const focus = hover ? (highlighted.has(node.id) ? 1 : 0.22) : 1;
          colors[index * 3] = rgb[0];
          colors[index * 3 + 1] = rgb[1];
          colors[index * 3 + 2] = rgb[2];
          sizes[index] = node._worldR * (hover && node.id === hover ? 1.7 : 1);
          alphas[index] = node._alpha * focus * (hover && node.id === hover ? 1.25 : 1);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.nodeCenter);
        gl.bufferData(gl.ARRAY_BUFFER, centers, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.nodeColor);
        gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.nodeSize);
        gl.bufferData(gl.ARRAY_BUFFER, sizes, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.nodeAlpha);
        gl.bufferData(gl.ARRAY_BUFFER, alphas, gl.DYNAMIC_DRAW);
        state.nodeCount = count;
      }

      function rebuildEdgeBuffers() {
        const edges = state.edges;
        const positions = new Float32Array(edges.length * 6);
        const colors = new Float32Array(edges.length * 8);
        const hover = state.hover;
        for (let index = 0; index < edges.length; index++) {
          const edge = edges[index];
          const a = edge._a;
          const b = edge._b;
          positions[index * 6] = a.x;
          positions[index * 6 + 1] = a.y;
          positions[index * 6 + 2] = a.z;
          positions[index * 6 + 3] = b.x;
          positions[index * 6 + 4] = b.y;
          positions[index * 6 + 5] = b.z;
          const conflict = edge.status === "conflict";
          const scheduled = edge.status === "scheduled";
          const base = conflict ? [1.0, 0.48, 0.38] : scheduled ? [1.0, 0.84, 0.46] : [0.6, 0.8, 1.0];
          const onPath = !hover || edge.source === hover || edge.target === hover;
          const strength = Math.min(1, 0.3 + (Number(edge.factCount) || 1) * 0.16);
          const alpha = (hover ? (onPath ? 0.8 : 0.05) : 0.34 + strength * 0.36) * (conflict ? 1.2 : 1);
          for (let corner = 0; corner < 2; corner++) {
            colors[index * 8 + corner * 4] = base[0];
            colors[index * 8 + corner * 4 + 1] = base[1];
            colors[index * 8 + corner * 4 + 2] = base[2];
            colors[index * 8 + corner * 4 + 3] = alpha;
          }
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.edgePos);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.edgeColor);
        gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
        state.edgeCount = edges.length;
      }

      function drawScene() {
        updateMatrices();
        if (state.bufferDirty) {
          rebuildNodeBuffers();
          rebuildEdgeBuffers();
          state.bufferDirty = false;
        }
        const width = glCanvas.width;
        const height = glCanvas.height;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        gl.clearColor(0, 0, 0, 0);
        gl.clearDepth(1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);

        // Nodes first so their depth masks the edges behind them.
        gl.useProgram(nodeProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.nodeCenter);
        gl.enableVertexAttribArray(nodeLoc.center);
        gl.vertexAttribPointer(nodeLoc.center, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.nodeColor);
        gl.enableVertexAttribArray(nodeLoc.color);
        gl.vertexAttribPointer(nodeLoc.color, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.nodeSize);
        gl.enableVertexAttribArray(nodeLoc.size);
        gl.vertexAttribPointer(nodeLoc.size, 1, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.nodeAlpha);
        gl.enableVertexAttribArray(nodeLoc.alpha);
        gl.vertexAttribPointer(nodeLoc.alpha, 1, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(nodeLoc.proj, false, state.proj);
        gl.uniformMatrix4fv(nodeLoc.view, false, state.view);
        // gl_PointSize is in device pixels, so the CSS-pixel world scale is
        // multiplied back by the device pixel ratio.
        gl.uniform1f(nodeLoc.pxScale, state.proj[5] * state.size.h * state.size.dpr * 0.5);
        gl.uniform2f(nodeLoc.fog, 950, 6200);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
        gl.depthMask(true);
        gl.drawArrays(gl.POINTS, 0, state.nodeCount || 0);

        gl.useProgram(edgeProgram);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.edgePos);
        gl.enableVertexAttribArray(edgeLoc.pos);
        gl.vertexAttribPointer(edgeLoc.pos, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, buffers.edgeColor);
        gl.enableVertexAttribArray(edgeLoc.color);
        gl.vertexAttribPointer(edgeLoc.color, 4, gl.FLOAT, false, 0, 0);
        gl.uniformMatrix4fv(edgeLoc.proj, false, state.proj);
        gl.uniformMatrix4fv(edgeLoc.view, false, state.view);
        gl.uniform2f(edgeLoc.fog, 950, 6200);
        gl.depthMask(false);
        gl.drawArrays(gl.LINES, 0, (state.edgeCount || 0) * 2);
        gl.depthMask(true);
        gl.disable(gl.BLEND);
      }

      // ---------- background: deep space gradient + procedural stars ----------
      function buildStars() {
        const width = state.size.w;
        const height = state.size.h;
        const signature = width + "x" + height;
        if (state.starSignature === signature && state.stars.length > 0) return;
        state.starSignature = signature;
        const count = nebulaClamp(Math.round((width * height) / 3000), 220, 1000);
        const stars = [];
        for (let index = 0; index < count; index++) {
          const roll = Math.random();
          stars.push({
            x: Math.random(),
            y: Math.random(),
            radius: roll < 0.86 ? 0.6 : roll < 0.97 ? 1.15 : 1.8,
            alpha: 0.25 + Math.random() * 0.62,
            phase: Math.random() * Math.PI * 2,
            speed: 0.5 + Math.random() * 1.6,
            tint: Math.random() < 0.16 ? [0.78, 0.84, 1.0] : Math.random() < 0.1 ? [1.0, 0.9, 0.76] : [0.82, 0.9, 1.0],
          });
        }
        state.stars = stars;
      }

      /**
       * The backdrop is static except for a slow pulse. Paint the four radial
       * gradients and every star once per size change instead of redrawing them
       * on each animation frame.
       */
      function buildBackdrop() {
        const { w, h, dpr } = state.size;
        if (w < 2 || h < 2 || state.stars.length === 0) return;
        const signature = Math.round(w) + "x" + Math.round(h) + "@" + dpr;
        if (state.backdropSignature === signature && state.backdrop) return;
        const layer = () => {
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(w * dpr));
          canvas.height = Math.max(1, Math.round(h * dpr));
          const context = canvas.getContext("2d");
          context.setTransform(dpr, 0, 0, dpr, 0, 0);
          return { canvas, context };
        };
        const clouds = layer();
        const cloudSprites = [
          { x: w * 0.28, y: h * 0.3, r: Math.max(w, h) * 0.6, color: "rgba(64,92,180,0.4)" },
          { x: w * 0.76, y: h * 0.72, r: Math.max(w, h) * 0.54, color: "rgba(128,68,180,0.34)" },
          { x: w * 0.52, y: h * 0.46, r: Math.max(w, h) * 0.36, color: "rgba(40,74,150,0.3)" },
          { x: w * 0.42, y: h * 0.86, r: Math.max(w, h) * 0.3, color: "rgba(58,120,190,0.2)" },
        ];
        for (const cloud of cloudSprites) {
          const gradient = clouds.context.createRadialGradient(cloud.x, cloud.y, 0, cloud.x, cloud.y, cloud.r);
          gradient.addColorStop(0, cloud.color);
          gradient.addColorStop(1, "rgba(0,0,0,0)");
          clouds.context.fillStyle = gradient;
          clouds.context.fillRect(0, 0, w, h);
        }
        const stars = layer();
        for (const star of state.stars) {
          stars.context.fillStyle = "rgba(" + Math.round(star.tint[0] * 255) + "," + Math.round(star.tint[1] * 255) + "," + Math.round(star.tint[2] * 255) + "," + star.alpha.toFixed(3) + ")";
          stars.context.beginPath();
          stars.context.arc(star.x * w, star.y * h, star.radius, 0, Math.PI * 2);
          stars.context.fill();
        }
        state.backdrop = { clouds: clouds.canvas, stars: stars.canvas };
        state.backdropSignature = signature;
      }

      function drawBackground(now) {
        if (!bctx) return;
        const { w, h, dpr } = state.size;
        bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        bctx.clearRect(0, 0, w, h);
        if (!state.backdrop) buildBackdrop();
        if (!state.backdrop) return;
        bctx.drawImage(state.backdrop.clouds, 0, 0, w, h);
        // One global pulse keeps the field alive without touching every star.
        bctx.globalAlpha = 0.78 + 0.22 * (0.5 + 0.5 * Math.sin(now / 1600));
        bctx.drawImage(state.backdrop.stars, 0, 0, w, h);
        bctx.globalAlpha = 1;
      }

      // ---------- labels ----------
      function roundRect(context, x, y, width, height, radius) {
        context.beginPath();
        context.moveTo(x + radius, y);
        context.arcTo(x + width, y, x + width, y + height, radius);
        context.arcTo(x + width, y + height, x, y + height, radius);
        context.arcTo(x, y + height, x, y, radius);
        context.arcTo(x, y, x + width, y, radius);
        context.closePath();
      }

      function drawLabels() {
        if (!lctx) return;
        const { w, h, dpr } = state.size;
        lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lctx.clearRect(0, 0, w, h);
        lctx.font = '500 11.5px Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
        lctx.textAlign = "center";
        lctx.textBaseline = "middle";
        const tmp = state.tmp;
        const candidates = [];
        for (const node of state.nodes) {
          project(node.x, node.y, node.z, tmp);
          if (tmp[2] <= 1) continue;
          const screenRadius = Math.max(2, node._worldR * tmp[3]);
          if (tmp[0] < -60 || tmp[0] > w + 60 || tmp[1] < -40 || tmp[1] > h + 40) continue;
          const rank = node.id === state.hover ? 1e9 : screenRadius + Math.min(40, (Number(node.factCount) || 0) * 2);
          candidates.push({ node, x: tmp[0], y: tmp[1], radius: screenRadius, rank });
        }
        candidates.sort((left, right) => right.rank - left.rank);
        const boxed = [];
        let drawn = 0;
        const limit = state.labels ? 26 : 3;
        for (const candidate of candidates) {
          const isHover = candidate.node.id === state.hover;
          if (!state.labels && !isHover && candidate.node.id !== state.hover) continue;
          if (drawn >= limit) break;
          const text = String(candidate.node.label ?? "").slice(0, 34);
          if (text.trim() === "") continue;
          const textWidth = lctx.measureText(text).width;
          const x = nebulaClamp(candidate.x, textWidth / 2 + 14, w - textWidth / 2 - 14);
          const y = nebulaClamp(candidate.y - candidate.radius - 13, 20, h - 16);
          const box = { left: x - textWidth / 2 - 7, right: x + textWidth / 2 + 7, top: y - 10, bottom: y + 10 };
          const collides = boxed.some((other) => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top);
          if (collides && !isHover) continue;
          boxed.push(box);
          drawn += 1;
          lctx.fillStyle = isHover ? "rgba(8,12,24,0.86)" : "rgba(5,8,16,0.6)";
          roundRect(lctx, x - textWidth / 2 - 7, y - 10, textWidth + 14, 20, 9);
          lctx.fill();
          if (isHover) {
            lctx.strokeStyle = "rgba(190,220,255,0.45)";
            lctx.lineWidth = 1;
            lctx.stroke();
          }
          const rgb = candidate.node._rgb;
          lctx.fillStyle = "rgb(" + Math.round(210 + rgb[0] * 45) + "," + Math.round(210 + rgb[1] * 45) + "," + Math.round(210 + rgb[2] * 45) + ")";
          lctx.fillText(text, x, y);
        }
        // Hover ring so the picked star is unambiguous even before the label lands.
        if (state.hover && state.byId.has(state.hover)) {
          const node = state.byId.get(state.hover);
          project(node.x, node.y, node.z, tmp);
          if (tmp[2] > 1) {
            const radius = nebulaClamp(node._worldR * tmp[3] + 6, 8, 40);
            lctx.beginPath();
            lctx.arc(tmp[0], tmp[1], radius, 0, Math.PI * 2);
            lctx.strokeStyle = "rgba(224,240,255,0.85)";
            lctx.lineWidth = 1.4;
            lctx.stroke();
          }
        }
      }

      function drawLoading() {
        if (!lctx) return;
        const { w, h, dpr } = state.size;
        lctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        lctx.clearRect(0, 0, w, h);
        lctx.font = '500 12px Inter, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
        lctx.textAlign = "center";
        lctx.textBaseline = "middle";
        lctx.fillStyle = "rgba(196,216,246,0.85)";
        lctx.fillText(loadingText + " " + Math.round((state.layout.iter / Math.max(1, state.layout.ticks)) * 100) + "%", w / 2, h / 2);
      }

      // ---------- frame loop ----------
      function draw(now) {
        if (state.size.w < 2 || state.size.h < 2) return;
        drawBackground(now || 0);
        drawScene();
        if (state.layout.running) drawLoading();
        else drawLabels();
      }

      function tick(timestamp) {
        if (state.disposed) return;
        state.raf = requestAnimationFrame(tick);
        const now = typeof timestamp === "number" ? timestamp : 0;
        const delta = state.lastFrame ? Math.min(64, now - state.lastFrame) : 16;
        state.lastFrame = now;
        if (state.layout.running) {
          const steps = state.nodes.length >= 300 ? 6 : 10;
          for (let step = 0; step < steps && state.layout.running; step++) {
            forceStep(state.layout.alpha);
            state.layout.alpha *= 0.985;
            state.layout.iter += 1;
            if (state.layout.iter >= state.layout.ticks || state.layout.alpha < 0.04) {
              state.layout.running = false;
              state.layoutDone = true;
              saveLayout();
              fitCamera(true);
              state.bufferDirty = true;
            }
          }
          state.bufferDirty = true;
          draw(now);
          return;
        }
        const idleFor = now - state.lastInteraction;
        if (state.spin && !state.drag && idleFor > 3000) state.cam.yaw += 0.00034 * (delta / 16.67);
        if (state.drag) state.bufferDirty = false;
        const moving = state.spin && !state.drag && idleFor > 3000;
        if (moving || state.needDraw) {
          state.needDraw = false;
          draw(now);
        }
      }

      // ---------- sizing ----------
      function resize() {
        const rect = glCanvas.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        state.size = { w: rect.width, h: rect.height, dpr };
        for (const canvas of [glCanvas, labelCanvas, bgCanvas]) {
          if (!canvas) continue;
          canvas.width = Math.round(rect.width * dpr);
          canvas.height = Math.round(rect.height * dpr);
        }
        buildStars();
        buildBackdrop();
        state.needDraw = true;
        return true;
      }

      // ---------- picking / pointer ----------
      function pick(screenX, screenY) {
        let best = null;
        let bestScore = Infinity;
        const tmp = state.tmp;
        for (const node of state.nodes) {
          project(node.x, node.y, node.z, tmp);
          if (tmp[2] <= 1) continue;
          const tolerance = nebulaClamp(node._worldR * tmp[3] + 9, 10, 30);
          const distance = Math.hypot(tmp[0] - screenX, tmp[1] - screenY);
          if (distance > tolerance) continue;
          const score = distance + tmp[2] * 0.02;
          if (score < bestScore) {
            bestScore = score;
            best = node;
          }
        }
        return best;
      }

      function pointerPosition(event) {
        const rect = glCanvas.getBoundingClientRect();
        return [event.clientX - rect.left, event.clientY - rect.top];
      }

      function handlePointerDown(event) {
        const [x, y] = pointerPosition(event);
        const panOnly = event.button !== 0;
        if (panOnly) event.preventDefault();
        try {
          glCanvas.setPointerCapture(event.pointerId);
        } catch (_error) {
          /* pointer capture is a nicety */
        }
        state.drag = {
          type: panOnly ? "pan" : "orbit",
          startX: x,
          startY: y,
          lastX: x,
          lastY: y,
          moved: false,
          button: event.button,
          yaw: state.cam.yaw,
          pitch: state.cam.pitch,
          tx: state.cam.tx,
          ty: state.cam.ty,
          tz: state.cam.tz,
        };
        state.lastInteraction = performance.now();
        glCanvas.style.cursor = "grabbing";
      }

      function handlePointerMove(event) {
        const [x, y] = pointerPosition(event);
        const drag = state.drag;
        if (drag) {
          const dx = x - drag.lastX;
          const dy = y - drag.lastY;
          if (!drag.moved && Math.hypot(x - drag.startX, y - drag.startY) > 4) drag.moved = true;
          drag.lastX = x;
          drag.lastY = y;
          state.lastInteraction = performance.now();
          if (drag.type === "pan") {
            const cam = state.cam;
            const cy = Math.cos(cam.yaw);
            const sy = Math.sin(cam.yaw);
            const cp = Math.cos(cam.pitch);
            const sp = Math.sin(cam.pitch);
            const right = [cy, 0, -sy];
            const up = [-sp * sy, cp, -sp * cy];
            const scale = (2 * cam.dist * Math.tan(NEBULA_FOV / 2)) / Math.max(1, state.size.h);
            cam.tx += (-dx * right[0] + dy * up[0]) * scale;
            cam.ty += (-dx * right[1] + dy * up[1]) * scale;
            cam.tz += (-dx * right[2] + dy * up[2]) * scale;
          } else {
            const nextYaw = drag.yaw - (x - drag.startX) * 0.0055;
            const nextPitch = nebulaClamp(drag.pitch + (y - drag.startY) * 0.0045, -1.35, 1.35);
            state.cam.yaw = nextYaw;
            state.cam.pitch = nextPitch;
          }
          state.needDraw = true;
          return;
        }
        const node = pick(x, y);
        glCanvas.style.cursor = node ? "pointer" : "grab";
        const nextHover = node ? node.id : null;
        if (nextHover !== state.hover) {
          state.hover = nextHover;
          // The host paints the tooltip; the renderer stays ignorant of the DOM
          // outside its own canvases.
          if (typeof settings.onHover === "function") {
            try {
              settings.onHover(node || null, { x, y });
            } catch (_error) {
              /* a host callback must never stop the render loop */
            }
          }
          state.bufferDirty = true;
          state.needDraw = true;
        }
        state.lastPointer = [x, y];
      }

      function handlePointerUp(event) {
        const drag = state.drag;
        state.drag = null;
        glCanvas.style.cursor = "grab";
        state.lastInteraction = performance.now();
        if (!drag) return;
        const [x, y] = pointerPosition(event);
        const moved = drag.moved || Math.hypot(x - drag.startX, y - drag.startY) > 4;
        if (drag.button !== 0 || moved) return;
        const node = pick(x, y);
        if (node && typeof settings.onSelect === "function") settings.onSelect(node);
      }

      function handleWheel(event) {
        event.preventDefault();
        const factor = Math.exp(nebulaClamp(event.deltaY, -220, 220) * 0.0016);
        state.cam.dist = nebulaClamp(state.cam.dist * factor, 240, 26000);
        state.lastInteraction = performance.now();
        state.needDraw = true;
      }

      function handleDoubleClick() {
        api.reset();
      }

      function handleVisibility() {
        if (typeof document === "undefined") return;
        if (document.hidden) api.stop();
        else api.start();
      }

      const listeners = [];
      function listen(target, name, handler, opts) {
        if (!target || typeof target.addEventListener !== "function") return;
        target.addEventListener(name, handler, opts);
        listeners.push(() => target.removeEventListener(name, handler, opts));
      }

      // ---------- public api ----------
      const api = {
        setData,
        resize,
        start() {
          if (state.disposed || state.running) return;
          state.running = true;
          if (!state.raf) state.raf = requestAnimationFrame(tick);
        },
        stop() {
          state.running = false;
          if (state.raf) cancelAnimationFrame(state.raf);
          state.raf = 0;
        },
        reset() {
          state.cam.yaw = 0.62;
          state.cam.pitch = 0.24;
          state.cam.tx = 0;
          state.cam.ty = 0;
          state.cam.tz = 0;
          fitCamera(true);
          state.lastInteraction = 0;
          state.needDraw = true;
        },
        setSpin(value) {
          state.spin = !!value;
          state.needDraw = true;
        },
        setLabels(value) {
          state.labels = !!value;
          state.needDraw = true;
        },
        getSpin() {
          return state.spin;
        },
        dispose() {
          state.disposed = true;
          api.stop();
          for (const remove of listeners) remove();
          listeners.length = 0;
          try {
            for (const buffer of Object.values(buffers)) gl.deleteBuffer(buffer);
            gl.deleteProgram(nodeProgram);
            gl.deleteProgram(edgeProgram);
          } catch (_error) {
            /* a lost context cannot be cleaned up, and does not need to be */
          }
        },
        debug() {
          return {
            nodes: state.nodes.length,
            edges: state.edges.length,
            layoutRunning: state.layout.running,
            layoutIter: state.layout.iter,
            hover: state.hover,
            size: { ...state.size },
            camera: { ...state.cam },
          };
        },
        projectToScreen(id) {
          const node = state.byId.get(id);
          if (!node) return null;
          const tmp = [0, 0, 0, 0];
          project(node.x, node.y, node.z, tmp);
          return { x: tmp[0], y: tmp[1], z: tmp[2] };
        },
      };

      listen(glCanvas, "pointerdown", handlePointerDown);
      listen(glCanvas, "pointermove", handlePointerMove);
      listen(glCanvas, "pointerup", handlePointerUp);
      listen(glCanvas, "pointercancel", handlePointerUp);
      listen(glCanvas, "wheel", handleWheel, { passive: false });
      listen(glCanvas, "dblclick", handleDoubleClick);
      // Leaving the canvas must drop the tooltip even when no pointermove follows.
      listen(glCanvas, "pointerleave", () => {
        if (state.hover === null) return;
        state.hover = null;
        state.bufferDirty = true;
        state.needDraw = true;
        if (typeof settings.onHover === "function") settings.onHover(null);
      });
      listen(glCanvas, "mousedown", (event) => {
        if (event.button === 1 || event.button === 2) event.preventDefault();
      }, { passive: false });
      listen(glCanvas, "contextmenu", (event) => event.preventDefault());
      listen(glCanvas, "auxclick", (event) => {
        if (event.button === 1) event.preventDefault();
      });
      listen(window, "resize", resize);
      listen(document, "visibilitychange", handleVisibility);

      if (typeof ResizeObserver === "function") {
        const observer = new ResizeObserver(() => resize());
        observer.observe(glCanvas);
        listeners.push(() => observer.disconnect());
      }

      // Browsers hand back a 0x0 rect while the tab is hidden; try again next frame
      // rather than baking a 1x1 framebuffer.
      const prime = () => {
        if (state.disposed) return;
        if (resize()) {
          state.needDraw = true;
        } else {
          requestAnimationFrame(prime);
        }
      };
      prime();

      return api;
    }

    // ══ nebula canvas: the page's 3D surface ═══════════════════════════════
    // GraphTree below is the fallback surface: no WebGL, a failed engine, or an
    // empty projection all land there instead of a blank rectangle. The edge
    // list under the canvas stays mounted either way, so the page never depends
    // on the GPU to be readable.
    // ── nebula view: the whole projection as a 3D galaxy ───────────────────
    // GraphTree below is the fallback surface: no WebGL, a failed engine, or an
    // empty projection all land there instead of a blank rectangle. The edge
    // list under the canvas stays mounted either way, so the page never depends
    // on the GPU to be readable.
    function NebulaCanvas({ graph, t, actions }) {
      const data = graph && graph.data;
      const nodes = data && Array.isArray(data.nodes) ? data.nodes : [];
      const edges = data && Array.isArray(data.edges) ? data.edges : [];
      const reducedMotion =
        typeof window !== "undefined" && typeof window.matchMedia === "function"
          ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
          : false;
      const [spin, setSpin] = react.useState(!reducedMotion);
      const [labels, setLabels] = react.useState(true);
      const [failed, setFailed] = react.useState(false);
      const [hover, setHover] = react.useState(null);
      // The nebula keeps its deep-space palette, but the frame around it follows
      // the host theme: a black slab on a light page reads as an embedded video.
      const [tone, setTone] = react.useState("dark");
      const [holder] = react.useState(() => ({ engine: null, gl: null, label: null, bg: null }));
      const webgl = !failed && nebulaWebglAvailable();

      useEffect(() => {
        if (typeof window === "undefined" || typeof document === "undefined") return undefined;
        try {
          const probe = document.querySelector(".FM_pg") || document.body;
          // backgroundColor is transparent behind the page's gradient; the label
          // color is the reliable signal (dark text on light, light text on dark).
          const computed = window.getComputedStyle(probe).color || "";
          const match = computed.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/i);
          if (match) {
            const luminance = (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255;
            setTone(luminance > 0.5 ? "dark" : "light");
          }
        } catch (_error) {
          /* a host without computed styles keeps the dark frame */
        }
        return undefined;
      }, []);

      const prepared = react.useMemo(() => {
        // A value node opens the fact that first mentioned it: nodes are pure
        // projections, the evidence lives on the edges.
        const factByNode = new Map();
        for (const edge of edges) {
          const factId = Array.isArray(edge.factIds) && edge.factIds.length > 0 ? edge.factIds[0] : null;
          if (!factId) continue;
          if (!factByNode.has(edge.target)) factByNode.set(edge.target, factId);
          if (!factByNode.has(edge.source)) factByNode.set(edge.source, factId);
        }
        return {
          nodes: nodes.map((node) => ({ ...node, factId: factByNode.get(node.id) || null })),
          edges,
          view: (data && data.view) || (graph && graph.view) || "current",
          seeds: (data && data.seeds) || [],
          // Same entity + same view keeps the same layout when the user flips
          // back and forth between tabs or reloads the same subject.
          cacheKey: [
            graph && graph.entity ? graph.entity : "",
            (data && data.view) || (graph && graph.view) || "current",
            data && data.seeds ? data.seeds.join(",") : "",
            // Identity, not just count: a store that gained facts between two
            // loads must not inherit the old layout for a different node set.
            nodes.map((node) => node.id).join(","),
          ].join("|"),
        };
      }, [nodes, edges, data, graph]);

      useEffect(() => {
        if (!webgl || !holder.gl || !holder.label) return undefined;
        let engine = null;
        try {
          engine = createNebulaEngine({
            glCanvas: holder.gl,
            labelCanvas: holder.label,
            bgCanvas: holder.bg,
            maxNodes: 600,
            maxEdges: 1200,
            spin,
            labels,
            loadingText: t("page.graph.nebulaLoading"),
            onSelect: (node) => {
              if (!node) return;
              if (node.kind === "entity") {
                if (actions && typeof actions.openEntity === "function") actions.openEntity(node.label);
                return;
              }
              if (node.factId && actions && typeof actions.openFact === "function") actions.openFact(node.factId);
            },
            // A star with no label is a mystery: name it under the pointer, and
            // say which kind of node it is before the click commits.
            onHover: (node, point) => {
              setHover(
                node
                  ? {
                      label: node.label,
                      kind: node.kind,
                      factCount: node.factCount ?? null,
                      x: point && Number.isFinite(point.x) ? point.x : 0,
                      y: point && Number.isFinite(point.y) ? point.y : 0,
                    }
                  : null,
              );
            },
          });
          engine.setData(prepared);
          engine.resize();
          engine.start();
          holder.engine = engine;
        } catch (error) {
          try {
            if (engine) engine.dispose();
          } catch (_disposeError) {
            /* a half-built engine has nothing useful to release */
          }
          holder.engine = null;
          setFailed(true);
          return undefined;
        }
        return () => {
          if (engine) engine.dispose();
          holder.engine = null;
        };
        // The engine is created once per WebGL availability; data changes flow
        // through setData below instead of rebuilding camera and buffers.
      }, [webgl]);

      useEffect(() => {
        if (holder.engine && prepared) holder.engine.setData(prepared);
      }, [prepared]);

      useEffect(() => {
        if (holder.engine) holder.engine.setSpin(spin);
      }, [spin]);
      useEffect(() => {
        if (holder.engine) holder.engine.setLabels(labels);
      }, [labels]);

      if (!webgl) {
        return jsxs("div", {
          className: "FM_pgNebula FM_pgNebulaFallback",
          children: [
            nodes.length > 0
              ? jsx(GraphTree, { data, t, actions })
              : jsx(EmptyState, { icon: "graph", title: t("page.graph.empty"), hint: t("page.graph.emptyHint") }),
            jsx("p", { className: "FM_pgMuted", children: t("page.graph.webglFallback") }),
          ],
        });
      }
      const truncated = data && data.truncated ? data.truncated : null;
      return jsxs("div", {
        className: "FM_pgNebula",
        children: [
          jsxs("div", {
            className: "FM_pgNebulaBar",
            children: [
              jsx("button", {
                className: "FM_pgNebulaBtn",
                type: "button",
                onClick: () => {
                  if (holder.engine) holder.engine.reset();
                },
                children: t("page.graph.resetView"),
              }),
              jsx("button", {
                className: spin ? "FM_pgNebulaBtn FM_pgNebulaBtnOn" : "FM_pgNebulaBtn",
                type: "button",
                onClick: () => setSpin((value) => !value),
                children: spin ? t("page.graph.spinPause") : t("page.graph.spinResume"),
              }),
              jsx("button", {
                className: labels ? "FM_pgNebulaBtn FM_pgNebulaBtnOn" : "FM_pgNebulaBtn",
                type: "button",
                onClick: () => setLabels((value) => !value),
                children: labels ? t("page.graph.labelsHide") : t("page.graph.labelsShow"),
              }),
              jsx("span", { className: "FM_pgNebulaHint", children: t("page.graph.nebulaHint") }),
            ],
          }),
          jsxs("div", {
            className: "FM_pgNebulaStage",
            "data-tone": tone,
            children: [
              jsx("canvas", {
                className: "FM_pgNebulaBg",
                ref: (element) => {
                  holder.bg = element;
                },
              }),
              jsx("canvas", {
                className: "FM_pgNebulaGl",
                ref: (element) => {
                  holder.gl = element;
                },
              }),
              jsx("canvas", {
                className: "FM_pgNebulaLabel",
                ref: (element) => {
                  holder.label = element;
                },
              }),
              jsx("div", { className: "FM_pgNebulaVignette" }),
              hover
                ? jsxs("div", {
                    className: "FM_pgNebulaTip",
                    style: { left: `${Math.round(hover.x)}px`, top: `${Math.round(hover.y)}px` },
                    children: [
                      jsx("b", { children: hover.label }),
                      jsx("span", {
                        children:
                          hover.kind === "entity"
                            ? t("page.graph.tipEntity", { n: hover.factCount ?? 0 })
                            : t("page.graph.tipValue", { n: hover.factCount ?? 0 }),
                      }),
                    ],
                  })
                : null,
            ],
          }),
          truncated && (Number(truncated.nodes) > 0 || Number(truncated.edges) > 0)
            ? jsx("p", {
                className: "FM_pgMuted",
                children: t("page.graph.nebulaTruncated", { nodes: Number(truncated.nodes || 0), edges: Number(truncated.edges || 0) }),
              })
            : null,
          jsx("p", {
            className: "FM_pgNebulaFoot",
            children: t("page.graph.nebulaCounts", { nodes: nodes.length, edges: edges.length }),
          }),
        ],
      });
    }

    // ══ SVG fallback: the one-hop tree for environments without WebGL ══════
    function GraphTree({ data, t, actions }) {
      if (!data) return null;
      const nodes = data.nodes || [];
      const edges = data.edges || [];
      const seedName = (data.seeds || [])[0] || "";
      const seedNode = nodes.find((node) => node.kind === "entity" && node.label === seedName) || nodes.find((node) => node.kind === "entity");
      const labelOf = (id) => nodes.find((node) => node.id === id)?.label || String(id).replace(/^[ev]:/, "");
      if (!seedNode || edges.length === 0) {
        return jsx(EmptyState, { icon: "graph", title: t("page.graph.empty"), hint: t("page.graph.emptyHint") });
      }
      // One-hop relations read far better as a tree than as a force blob: the
      // subject is a fixed anchor and every relation is its own labelled row, so
      // long Chinese values never collide.
      const rows = edges.map((edge) => {
        const outgoing = edge.source === seedNode.id;
        const other = outgoing ? edge.target : edge.source;
        const otherNode = nodes.find((node) => node.id === other);
        return {
          edge,
          key: `${edge.source}|${edge.predicate}|${edge.target}`,
          direction: outgoing ? "out" : "in",
          predicate: edge.predicate,
          otherLabel: clipText(otherNode?.label ?? labelOf(other), 46),
          otherKind: otherNode?.kind ?? "value",
          danger: edge.status === "conflict",
          factId: (edge.factIds || [])[0],
        };
      });
      // Eight rows is what a 46px lane can show without the SVG being scaled
      // down to illegibility; the edge list below carries the rest.
      const visible = rows.slice(0, 8);
      const rowHeight = 46;
      const top = 40;
      const height = Math.max(220, top * 2 + visible.length * rowHeight);
      const width = 1000;
      const seedX = 24;
      const seedW = 236;
      const cy = height / 2;
      const laneX = seedX + seedW + 26;
      const textX = seedX + seedW + 74;
      return jsxs("div", {
        className: "FM_pgCanvasWrap",
        children: [
          jsxs("svg", {
            className: "FM_pgCanvas",
            viewBox: `0 0 ${width} ${height}`,
            role: "img",
            "aria-label": t("page.graph.relations"),
            children: [
              visible.map((row, index) => {
                const y = top + index * rowHeight;
                const midX = (laneX + textX) / 2;
                return jsxs(
                  "g",
                  {
                    className: "FM_pgRowGroup",
                    onClick: () => row.factId && actions.openFact(row.factId),
                    children: [
                      jsx("path", {
                        className: row.danger ? "FM_pgLink FM_pgLinkDanger" : "FM_pgLink",
                        d: `M${seedX + seedW} ${cy} C ${laneX - 18} ${cy}, ${midX - 24} ${y + 5}, ${textX - 10} ${y + 5}`,
                      }),
                      jsx("rect", { x: textX - 10, y: y - 13, width: width - textX, height: 30, rx: 8, className: "FM_pgRowHit" }),
                      jsx("text", { x: textX - 18, y: y + 4, className: "FM_pgRowPred", textAnchor: "end", children: row.direction === "in" ? `← ${row.predicate}` : row.predicate }),
                      jsx("text", { x: textX, y: y + 4, className: row.danger ? "FM_pgRowValue FM_pgRowValueDanger" : "FM_pgRowValue", children: `${row.otherLabel}` }),
                      row.otherKind === "entity"
                        ? jsx("text", { x: textX + String(row.otherLabel).length * 7.4 + 10, y: y + 4, className: "FM_pgRowTag", children: t("page.graph.entityNode") })
                        : null,
                    ],
                  },
                  row.key,
                );
              }),
              jsx("rect", { x: seedX, y: cy - 26, width: seedW, height: 52, rx: 12, className: "FM_pgSeedBox" }),
              jsx("text", { x: seedX + 16, y: cy - 4, className: "FM_pgSeedName", children: seedName }),
              jsx("text", { x: seedX + 16, y: cy + 14, className: "FM_pgSeedMeta", children: t("page.graph.seedMeta", { n: edges.length }) }),
            ],
          }),
          rows.length > visible.length
            ? jsx("p", { className: "FM_pgMuted", children: t("page.graph.truncated", { n: rows.length - visible.length }) })
            : data.truncated && (data.truncated.nodes > 0 || data.truncated.edges > 0)
              ? jsx("p", { className: "FM_pgMuted", children: t("page.graph.truncated", { n: data.truncated.nodes + data.truncated.edges }) })
              : null,
        ],
      });
    }

    function entityLabel(value) {
      const text = typeof value === "string" ? value.trim() : "";
      return text === "" || text === "[object Object]" ? "—" : text;
    }

    function clipText(value, max) {
      const text = String(value ?? "");
      return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    }

    // ══ conversation surfaces ═════════════════════════════════════════════
    // Memory meets the conversation in three places: a right-hand drawer for one
    // look without leaving the thread, a per-turn card saying what this turn
    // taught it, and a dot on the sidebar row of every session that wrote
    // anything. All three read the same two routes (`activity`, `sessions`) so
    // the numbers cannot disagree with the library page.
    const DRAWER_KIND = "factMemory";
    const DRAWER_TAB_ID = "dsh-fact-memory/fact";

    function createSurfaceController(ctx, page) {
      const drawer = createStore({
        open: false,
        sessionId: "",
        sinceSeq: 0,
        facts: [],
        lastRun: null,
        loading: false,
        error: null,
      });
      const sessions = createStore({ items: {}, at: 0, loading: false });
      // One activity lookup per session, shared by every turn card: the card only
      // says what the latest pass wrote, so N cards must not mean N requests.
      const turn = createStore({ bySession: {} });
      // The host restores a tab's layout record but not the parameters its opener
      // passed, so the last request is kept here and replayed when the body mounts.
      let lastRequest = null;
      // The drawer follows the session whose card was clicked; a slow /activity
      // answer must not paint the previous session into it.
      let drawerRequest = 0;
      // The second placement attempt runs after the pane mounts; an old timer
      // must not reopen a tab the user already closed.
      let drawerPlaceTimer = null;
      const turnTimers = new Map();
      let fetchedAt = 0;

      const refreshSessions = (force) => {
        if (!force && Date.now() - fetchedAt < 60_000) return Promise.resolve();
        fetchedAt = Date.now();
        sessions.patch({ loading: true });
        return postJson("sessions", {}).then((payload) => {
          if (payload.ok) sessions.set({ items: payload.sessions || {}, at: Date.now(), loading: false });
          else sessions.patch({ loading: false });
        });
      };

      const loadActivity = (sessionId, sinceSeq) => {
        const ticket = (drawerRequest += 1);
        drawer.patch({ loading: true, error: null });
        return postJson("activity", { sessionId, sinceSeq, limit: 40 }).then((payload) => {
          if (ticket !== drawerRequest) return;
          if (!payload.ok) {
            drawer.patch({ loading: false, error: payload.error || "failed" });
            return;
          }
          drawer.patch({ loading: false, facts: payload.facts || [], lastRun: payload.lastRun ?? null });
        });
      };

      // Extraction is asynchronous: the configured delay, the model call and the
      // per-session queue can add up to well over a minute, so three fixed probes
      // missed slow passes altogether. Poll until the extraction for this turn
      // settles, then stop.
      const TURN_POLL_MS = 4000;
      const TURN_POLL_WINDOW_MS = 120_000;
      // One poll per turn, not one per session: every turn tail mounts its own card,
      // and a shared key let an older card's unmount silence the newest one.
      const turnKey = (sessionId, seq) => `${sessionId}\u0000${Number(seq ?? 0) || 0}`;

      /**
       * Stop one turn's poll. Omitting seq cancels every turn of that session, which
       * is what a card that lost its seq needs; a card that knows its seq must only
       * ever cancel its own poll.
       */
      const cancelTurn = (sessionId, seq) => {
        const id = String(sessionId ?? "");
        if (id === "") return;
        const clear = (key) => {
          const timers = turnTimers.get(key);
          if (!timers) return;
          for (const timer of timers) clearTimeout(timer);
          turnTimers.delete(key);
        };
        if (seq === undefined || seq === null) {
          const prefix = id + "\u0000";
          for (const key of [...turnTimers.keys()]) if (key.startsWith(prefix)) clear(key);
          return;
        }
        clear(turnKey(id, seq));
      };

      const refreshTurn = (sessionId, seq) => {
        const id = String(sessionId ?? "");
        if (id === "") return Promise.resolve(null);
        const target = Number(seq ?? 0) || 0;
        const key = turnKey(id, target);
        let settledSeq = -1;
        let running = false;
        let queued = 0;
        // A pass that owns no queue slot: armed in the debounce window, waiting out
        // a retry, or parked until a model is available.
        let armed = false;
        // Auto extraction off means no pass will ever consume this turn.
        let enabled = true;
        let found = false;
        const look = () =>
          postJson("activity", { sessionId: id, sinceSeq: 0, seq: target, limit: 3 }).then((payload) => {
            if (!payload.ok) return null;
            const state = payload.extraction ?? null;
            if (state) {
              if (Number.isFinite(Number(state.settledSeq))) settledSeq = Number(state.settledSeq);
              running = state.running === true;
              queued = Number(state.queued ?? 0) || 0;
              armed = Boolean(state.waiting || state.retrying || state.deferred);
              enabled = state.enabled !== false;
            }
            const run = payload.lastRun ?? null;
            if (!run || Math.abs((run.toSeq ?? 0) - target) > 4) return null;
            found = true;
            turn.set((current) => ({ bySession: { ...current.bySession, [id]: { seq: target, run } } }));
            // A fresh summary means this conversation just wrote facts: the sidebar
            // mark is cached for a minute, so ask for it again right away.
            refreshSessions(true);
            return run;
          });
        const existing = turnTimers.get(key);
        if (existing) for (const timer of existing) clearTimeout(timer);
        const timers = [];
        turnTimers.set(key, timers);
        const started = Date.now();
        let polls = 0;
        const poll = () => {
          if (found) return;
          const timer = setTimeout(() => {
            polls += 1;
            look().then((run) => {
              if (run || found) return cancelTurn(id, target);
              // The pass consumed this turn already: whatever it decided is final.
              if (settledSeq >= 0 && settledSeq >= target) return cancelTurn(id, target);
              if (!enabled) return cancelTurn(id, target);
              const idleFor = Date.now() - started;
              // Queued, running, armed on a timer or parked for a model: a pass is
              // still coming for this turn, so the gap is not an empty result.
              if (running || queued > 0 || armed) {
                if (idleFor >= TURN_POLL_WINDOW_MS) return cancelTurn(id, target);
                return poll();
              }
              // Nothing is scheduled at all: no pass is queued, running, armed on a
              // timer or parked for a model. Two such probes in a row mean this turn
              // will never produce a card, so stop instead of spinning.
              if (polls >= 2) return cancelTurn(id, target);
              if (idleFor >= TURN_POLL_WINDOW_MS) return cancelTurn(id, target);
              poll();
            });
          }, TURN_POLL_MS);
          timers.push(timer);
        };
        return look().then((run) => {
          if (run || found) cancelTurn(id, target);
          else poll();
          return run;
        });
      };

      const openDrawer = (options) => {
        const sessionId = String(options?.sessionId ?? "");
        const sinceSeq = Number(options?.sinceSeq ?? 0) || 0;
        lastRequest = { sessionId, sinceSeq };
        drawer.set({ open: true, sessionId, sinceSeq, facts: [], lastRun: null, loading: true, error: null });
        const params = { sessionId, sinceSeq };
        // A tab can only be placed in a mounted pane, so reveal the right column
        // first and retry once the pane has adopted this session. Both calls are
        // best-effort: hosts without a right sidebar still fill the store.
        const layout = ctx.get?.("layout") ?? ctx.layout;
        const place = () => {
          try {
            ctx.get?.("sidebarRight")?.openTab?.(DRAWER_KIND, { params });
          } catch {
            /* pane not mounted yet; the retry below covers it */
          }
        };
        try {
          layout?.openRightbar?.(true, false);
        } catch {
          /* older host */
        }
        place();
        if (drawerPlaceTimer) clearTimeout(drawerPlaceTimer);
        drawerPlaceTimer = setTimeout(() => {
          drawerPlaceTimer = null;
          place();
        }, 200);
        return loadActivity(sessionId, sinceSeq);
      };

      const openInPanel = (factId) => {
        const layout = ctx.get?.("layout") ?? ctx.layout;
        try {
          layout?.selectPanel?.(PANEL_ID);
        } catch {
          /* older host without a panel switcher */
        }
        if (factId) page.actions.openFact(factId);
      };

      const resumeDrawer = () => (lastRequest ? loadActivity(lastRequest.sessionId, lastRequest.sinceSeq) : Promise.resolve());

      return {
        drawer,
        sessions,
        turn,
        resumeDrawer,
        refreshTurn,
        cancelTurn,
        refreshSessions,
        openDrawer,
        closeDrawer: () => {
          drawerRequest += 1;
          if (drawerPlaceTimer) clearTimeout(drawerPlaceTimer);
          drawerPlaceTimer = null;
          drawer.patch({ open: false });
        },
        openInPanel,
        // The drawer, the turn cards and the sidebar marks all cache what the
        // store said; a wipe makes every one of those numbers a lie.
        resetAfterWipe: () => {
          drawerRequest += 1;
          if (drawerPlaceTimer) clearTimeout(drawerPlaceTimer);
          drawerPlaceTimer = null;
          drawer.patch({ sessionId: "", sinceSeq: 0, facts: [], lastRun: null, loading: false, error: null });
          sessions.patch({ items: {}, at: 0, loading: false });
          turn.set({ bySession: {} });
          fetchedAt = 0;
        },
      };
    }

    function DrawerFactRow({ fact, t, zone, onOpen }) {
      const statusKey = `page.status.${fact.status}`;
      return jsxs("button", {
        className: "FM_drRow",
        type: "button",
        title: t("drawer.open"),
        onClick: () => onOpen(fact.factId),
        children: [
          jsxs("span", {
            className: "FM_drRowMain",
            children: [
              jsxs("span", {
                className: "FM_drRowHead",
                children: [
                  jsx("span", { className: "FM_drEntity", children: fact.entity }),
                  jsx("span", { className: "FM_drDot", children: "·" }),
                  jsx("span", { className: "FM_drPred", children: fact.predicate }),
                ],
              }),
              jsx("span", {
                className: "FM_drValue",
                children: fact.secret ? MASKED : fact.value,
              }),
            ],
          }),
          jsxs("span", {
            className: "FM_drRowMeta",
            children: [
              jsx("span", { className: `FM_pgStatus FM_pgStatus_${fact.status}`, children: t(statusKey) }),
              jsx("span", { className: "FM_drTime", children: shortTime(fact.observedAt, zone) }),
            ],
          }),
        ],
      });
    }

    function MemoryDrawer(props) {
      const { t, zone, useDrawer, close, openFact, resume } = props;
      const state = useDrawer((snapshot) => snapshot);
      const facts = state.facts || [];
      useEffect(() => {
        if (!state.sessionId && typeof resume === "function") resume();
      }, []);
      return jsxs("div", {
        className: "FM_dr",
        children: [
          jsxs("div", {
            className: "FM_drHead",
            children: [
              jsxs("div", {
                className: "FM_drHeadText",
                children: [
                  jsx("strong", { children: t("drawer.title") }),
                  jsx("span", { className: "FM_drSub", children: t("drawer.subtitle") }),
                ],
              }),
              jsx("button", {
                className: "FM_pgIconBtn",
                type: "button",
                title: t("page.close"),
                onClick: () => close(),
                children: jsx(Glyph, { kind: "close", size: 14 }),
              }),
            ],
          }),
          state.loading
            ? jsx("p", { className: "FM_pgMuted", children: t("drawer.loading") })
            : state.error
              ? jsx("p", { className: "FM_pgMuted", children: t("drawer.failed", { error: state.error }) })
              : !state.sessionId
                ? jsx("p", { className: "FM_pgMuted", children: t("drawer.hint") })
                : facts.length === 0
                  ? jsx("p", { className: "FM_pgMuted", children: t("drawer.empty") })
                : jsxs("div", {
                    className: "FM_drList",
                    children: [
                      jsx("div", { className: "FM_drCount", children: t("drawer.count", { n: facts.length }) }),
                      ...facts.map((fact) => jsx(DrawerFactRow, { fact, t, zone, onOpen: openFact }, fact.factId)),
                    ],
                  }),
        ],
      });
    }

    function MemoryDrawerTitle(props) {
      const { t, useDrawer } = props;
      const count = useDrawer((snapshot) => (snapshot.facts || []).length);
      return jsxs("span", {
        className: "FM_drTitle",
        children: [jsx(Glyph, { kind: "memory", size: 13 }), jsx("span", { children: t("drawer.title") }), count > 0 ? jsx("span", { className: "FM_drTitleCount", children: count }) : null],
      });
    }

    function TurnMemoryCard(props) {
      const { t, sessionId, seq, openDrawer, useTurn, refreshTurn, cancelTurn } = props;
      const entry = useTurn((snapshot) => (sessionId ? snapshot.bySession[sessionId] : null));
      useEffect(() => {
        if (typeof refreshTurn === "function") refreshTurn(sessionId, seq);
        // A card that scrolled away must not keep polling for two minutes.
        return () => {
          if (typeof cancelTurn === "function") cancelTurn(sessionId, seq);
        };
      }, [sessionId, seq]);
      const run = entry && Math.abs((entry.run?.toSeq ?? 0) - (seq ?? 0)) <= 4 ? entry.run : null;
      if (!run) return null;
      const saved = Number(run.saved ?? 0);
      const pending = Number(run.proposals ?? 0);
      const conflicts = Number(run.conflicts ?? 0);
      if (saved + pending + conflicts <= 0) return null;
      return jsxs("div", {
        className: "FM_turnCard",
        children: [
          jsx(Glyph, { kind: "memory", size: 14 }),
          jsx("span", { className: "FM_turnLabel", children: t("turn.title") }),
          saved > 0 ? jsx("span", { className: "FM_turnStat", children: t("turn.saved", { n: saved }) }) : null,
          pending > 0 ? jsx("span", { className: "FM_turnStat FM_turnStat_pending", children: t("turn.pending", { n: pending }) }) : null,
          conflicts > 0 ? jsx("span", { className: "FM_turnStat FM_turnStat_conflict", children: t("turn.conflict", { n: conflicts }) }) : null,
          jsx("button", {
            className: "FM_turnView",
            type: "button",
            onClick: () => openDrawer({ sessionId, sinceSeq: run.fromSeq ?? 0 }),
            children: t("turn.view"),
          }),
        ],
      });
    }

    function SessionMemoryMark(props) {
      const { t, sessionId, useSessions, refreshSessions } = props;
      const items = useSessions((snapshot) => snapshot.items);
      useEffect(() => {
        if (typeof refreshSessions === "function") refreshSessions();
      }, []);
      const entry = sessionId ? items?.[sessionId] : null;
      if (!entry || !entry.facts) return null;
      // A status dot would read as "unread"; the memory glyph reads as "this
      // conversation taught the library something".
      return jsx("span", {
        className: "FM_rowMark",
        title: t("row.mark", { n: entry.facts }),
        children: jsx(Glyph, { kind: "memory", size: 12 }),
      });
    }

    // ── extraction queue panel ──────────────────────────────────────────────
    // One row per pass the scheduler is holding. The point is legibility: "the
    // model is working" and "nothing has happened for ten minutes" must look
    // different at a glance, including the auto-refresh choice (off by default).
    function QueueStatePill({ state, t }) {
      const tone =
        state === "running"
          ? "ok"
          : state === "error" || state === "failed"
            ? "danger"
            : state === "waiting" || state === "retrying" || state === "skipped" || state === "unconfigured"
              ? "warn"
              : "muted";
      return jsx("span", { className: `FM_pgPill FM_pgPill_${tone}`, children: t(`page.queue.state.${state}`) });
    }

    /**
     * A finished pass answers two questions at once: did it write anything, and
     * how long did it take. "写入 2 条 · 用时 3.4 秒" is legible; a bare seq is not.
     */
    function queueRecentDetail(row, t) {
      if (row.state === "skipped") {
        if (row.reason === "no_user_text") return t("page.queue.reason.noText");
        // The prefilter runs before any model call: saying "read it, nothing
        // worth saving" here would be a lie.
        if (row.reason === "no_signal") return t("page.queue.reason.noSignal");
        // The model did answer; it was the ledger's shape gate that refused it. That
        // is a different sentence from "read it, nothing worth saving".
        if (row.reason === "policy_rejected") return t("page.queue.reason.policyRejected");
        // The assistant stored this turn itself: no pass ran, by design.
        if (row.reason === "manual_capture") return t("page.queue.reason.manualCapture");
        return t("page.queue.reason.noCandidates");
      }
      if (row.state === "unconfigured") return t("page.queue.reason.unconfigured");
      if (row.state === "error" || row.state === "failed") {
        const reason = String(row.reason || "").replace(/\s+/g, " ").slice(0, 80);
        return reason ? t("page.queue.reason.failed", { reason }) : t("page.queue.state.error");
      }
      const bits = [];
      if (Number(row.saved) > 0) bits.push(t("page.queue.detail.saved", { n: Number(row.saved) }));
      if (Number(row.proposals) > 0) bits.push(t("page.queue.detail.proposals", { n: Number(row.proposals) }));
      if (Number(row.conflicts) > 0) bits.push(t("page.queue.detail.conflicts", { n: Number(row.conflicts) }));
      if (bits.length === 0) bits.push(t("page.queue.detail.nothing"));
      if (Number(row.durationMs) > 0) bits.push(t("page.queue.detail.took", { s: (Number(row.durationMs) / 1000).toFixed(1) }));
      return bits.join(" · ");
    }

    function queueRowDetail(row, t) {
      if (row.state === "queued") return t("page.queue.rowQueued", { n: row.count ?? 1 });
      if (row.state === "waiting") return t("page.queue.rowDue", { s: Math.max(1, Math.ceil(Number(row.dueInMs ?? 0) / 1000)) });
      if (row.state === "retrying") {
        return t("page.queue.rowRetry", { n: row.attempt ?? 0, s: Math.max(1, Math.ceil(Number(row.dueInMs ?? 0) / 1000)) });
      }
      if (row.seq) return t("page.queue.rowSeq", { n: row.seq });
      return String(row.reason ?? "");
    }

    function extractRejectLabel(reason, t) {
      const code = String(reason || "");
      if (/^(entity|predicate|value)_/.test(code)) return t("page.queue.detailShape");
      const known = ["no_quote", "quote_not_in_source", "missing_field", "not_an_object", "too_long", "duplicate_in_batch"];
      return known.includes(code) ? t(`page.queue.reject.${code}`) : code;
    }

    /** The text the model read, and what it refused to accept from its answer. */
    function ExtractRunDetail({ run, t, shown, onMore }) {
      if (!run) return null;
      const input = String(run.inputText ?? "");
      const visible = input.slice(0, Math.max(1, Number(shown) || RUN_TEXT_CHUNK));
      const truncated = run.inputTruncated === true;
      const rejected = Array.isArray(run.rejected) ? run.rejected : [];
      // Two finished passes never called the model, and each needs its own sentence:
      // the prefilter skipped it, or the assistant had already stored the turn.
      const notCalled =
        run.reason === "no_signal"
          ? t("page.queue.detailNotCalled")
          : run.reason === "manual_capture"
            ? t("page.queue.detailManual")
            : null;
      return jsxs("div", {
        className: "FM_pgQueueDetail",
        children: [
          notCalled ? jsx("p", { className: "FM_pgQueueNote", children: notCalled }) : null,
          jsxs("div", {
            className: "FM_pgQueueDetailHead",
            children: [
              jsx("span", { className: "FM_pgRailLabel", children: t(notCalled ? "page.queue.detailTurnText" : "page.queue.detailInput") }),
              truncated
                ? jsx("span", { className: "FM_pgQueueMeta", children: t("page.queue.detailTruncated", { n: input.length }) })
                : null,
            ],
          }),
          jsx("pre", { className: "FM_pgQueueInput", children: visible || t("page.queue.detailNoInput") }),
          input.length > visible.length
            ? jsx("button", {
                className: "FM_pgQueueMore",
                type: "button",
                onClick: onMore,
                children: t("page.queue.detailMore", { shown: visible.length, total: input.length }),
              })
            : input.length > 0
              ? jsx("span", { className: "FM_pgQueueMeta", children: t("page.queue.detailAll", { n: input.length }) })
              : null,
          jsxs("div", {
            className: "FM_pgQueueDetailHead",
            children: [
              jsx("span", {
                className: "FM_pgQueueMeta",
                children: t("page.queue.detailMeta", {
                  messages: Number(run.messages ?? 0),
                  chunks: Number(run.chunks ?? 1),
                  model: String(run.model || "") || t("page.queue.detailNoModel"),
                }),
              }),
              Number(run.durationMs) > 0
                ? jsx("span", { className: "FM_pgQueueMeta", children: t("page.queue.detailTook", { s: (Number(run.durationMs) / 1000).toFixed(1) }) })
                : null,
            ],
          }),
          rejected.length > 0
            ? jsxs("div", {
                className: "FM_pgQueueReject",
                children: [
                  jsx("span", { className: "FM_pgRailLabel", children: t("page.queue.detailRejected") }),
                  ...rejected.map((item, index) =>
                    jsx(
                      "span",
                      {
                        className: "FM_pgQueueRejectPill",
                        title: String(item.reason ?? ""),
                        children: `${extractRejectLabel(item.reason, t)} ×${Number(item.count) || 1}`,
                      },
                      String(index),
                    ),
                  ),
                ],
              })
            : run.reason === "no_signal"
              ? null
              : jsx("span", { className: "FM_pgQueueMeta", children: t("page.queue.detailRejectedNone") }),
        ],
      });
    }

    function QueuePanel({ queue, t, zone, actions }) {
      const data = queue.data;
      const totals = data?.totals || {};
      const live = data
        ? [...(data.running || []), ...(data.queued || []), ...(data.waiting || []), ...(data.retrying || [])]
        : [];
      const pending = data?.pending || [];
      const recent = data?.recent || [];
      const bar = jsxs("div", {
        className: "FM_pgQueueBar",
        children: [
          jsx("span", { className: "FM_pgRailLabel", children: t("page.queue.auto") }),
          jsx("div", {
            className: "FM_pgSeg",
            children: [0, 5, 10, 15, 30].map((seconds) =>
              jsx(
                "button",
                {
                  className: queue.auto === seconds ? "FM_pgSegBtn FM_pgSegOn" : "FM_pgSegBtn",
                  type: "button",
                  onClick: () => actions.setQueueAuto(seconds),
                  children: seconds === 0 ? t("page.queue.autoOff") : t("page.queue.seconds", { s: seconds }),
                },
                String(seconds),
              ),
            ),
          }),
          jsx("button", {
            className: "FM_pgIconBtn",
            type: "button",
            title: t("page.queue.refresh"),
            "aria-label": t("page.queue.refresh"),
            onClick: () => actions.loadQueue(),
            children: jsx(Glyph, { kind: "refresh", size: 15 }),
          }),
          data?.at
            ? jsx("span", { className: "FM_pgMuted FM_pgQueueAt", children: t("page.queue.updated", { time: shortTime(data.at, zone) }) })
            : null,
          queue.loading ? jsx("span", { className: "FM_pgMuted", children: t("page.loading") }) : null,
        ],
      });
      const rowOf = (row, key) =>
        jsxs(
          "div",
          {
            className: "FM_pgQueueRow",
            children: [
              jsx(QueueStatePill, { state: row.state === "ok" ? "done" : row.state, t }),
              jsx("span", {
                className: "FM_pgQueueSession",
                children: row.title || t("page.queue.session", { id: String(row.sessionId ?? "").slice(0, 12) }),
              }),
              jsx("span", { className: "FM_pgQueueMeta", children: queueRowDetail(row, t) }),
              jsx("span", { className: "FM_pgQueueMeta", children: shortTime(row.at || row.since, zone) }),
            ],
          },
          key,
        );
      const recentRow = (row, key) => {
        const expanded = queue.expanded && queue.expanded.id === row.id;
        const canOpen = Boolean(row.id) && typeof actions.toggleExtractRun === "function";
        const toggle = () => {
          if (canOpen) actions.toggleExtractRun(row.id);
        };
        const head = jsxs(
          "div",
          {
            className: canOpen ? "FM_pgQueueRow FM_pgQueueRowRecent FM_pgQueueRowClick" : "FM_pgQueueRow FM_pgQueueRowRecent",
            role: canOpen ? "button" : undefined,
            tabIndex: canOpen ? 0 : undefined,
            "aria-expanded": canOpen ? (expanded ? "true" : "false") : undefined,
            title: canOpen ? t("page.queue.openHint") : undefined,
            onClick: canOpen ? toggle : undefined,
            onKeyDown: canOpen
              ? (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    toggle();
                  }
                }
              : undefined,
            children: [
              jsx(QueueStatePill, { state: row.state === "ok" ? "done" : row.state, t }),
              jsx("span", {
                className: "FM_pgQueueSession",
                children: row.title || t("page.queue.session", { id: String(row.sessionId ?? "").slice(0, 12) }),
              }),
              jsx("span", { className: "FM_pgQueueMeta", children: queueRecentDetail(row, t) }),
              jsx("span", { className: "FM_pgQueueMeta", title: shortTime(row.at, zone), children: timeAgo(row.at, t) }),
              jsx("span", { className: expanded ? "FM_pgQueueCaret FM_pgQueueCaretOn" : "FM_pgQueueCaret", "aria-hidden": "true", children: "▸" }),
            ],
          },
          key,
        );
        if (!expanded) return jsx("div", { className: "FM_pgQueueItem", children: head }, key);
        const body = queue.expanded.loading
          ? jsx("p", { className: "FM_pgQueueNote", children: t("page.loading") })
          : queue.expanded.error
            ? jsx("p", { className: "FM_pgQueueNote", children: queue.expanded.error })
            : jsx(ExtractRunDetail, {
                run: queue.expanded.data,
                t,
                shown: queue.expanded.shown,
                onMore: actions.showMoreRunText,
              });
        return jsxs("div", { className: "FM_pgQueueItem", children: [head, body] }, key);
      };
      const pendingRow = (item) =>
        jsxs(
          "div",
          {
            className: "FM_pgQueueRow FM_pgQueueRowPending",
            children: [
              jsx("span", { className: "FM_pgPill FM_pgPill_danger", children: t("page.queue.state.failed") }),
              jsx("span", { className: "FM_pgQueueMeta", children: t("page.queue.chars", { n: item.chars ?? 0 }) }),
              jsx("span", { className: "FM_pgQueuePreview", children: item.preview || item.reason || "" }),
              jsx("span", { className: "FM_pgQueueMeta", children: shortTime(item.at, zone) }),
            ],
          },
          item.id,
        );
      const sections = [
        jsxs("div", {
          className: "FM_pgQueueChips",
          children: [
            jsx("span", { className: "FM_pgPill FM_pgPill_ok", children: t("page.queue.running", { n: totals.running ?? 0 }) }),
            jsx("span", { className: "FM_pgPill FM_pgPill_muted", children: t("page.queue.queued", { n: totals.queued ?? 0 }) }),
            jsx("span", { className: "FM_pgPill FM_pgPill_warn", children: t("page.queue.waiting", { n: totals.waiting ?? 0 }) }),
            jsx("span", { className: "FM_pgPill FM_pgPill_warn", children: t("page.queue.retrying", { n: totals.retrying ?? 0 }) }),
            jsx("span", { className: "FM_pgPill FM_pgPill_muted", children: t("page.queue.pending", { n: totals.pending ?? 0 }) }),
          ],
        }),
        jsx("p", {
          className: "FM_pgMuted FM_pgQueueConfig",
          children: data?.config?.enabled
            ? t("page.queue.configOn", { s: Math.round(Number(data.config.delayMs ?? 0) / 1000), model: data.config.model || "host" })
            : t("page.queue.configOff"),
        }),
        jsx("p", { className: "FM_pgRailLabel", children: t("page.queue.current") }),
        live.length === 0
          ? jsx("p", { className: "FM_pgMuted", children: t("page.queue.idle") })
          : jsx("div", {
              className: "FM_pgQueueList",
              children: live.map((row, index) => rowOf(row, `live-${row.state}-${row.sessionId}-${index}`)),
            }),
      ];
      if (pending.length > 0) {
        sections.push(jsx("p", { className: "FM_pgRailLabel", children: t("page.queue.pendingTitle") }));
        sections.push(jsx("div", { className: "FM_pgQueueList", children: pending.map(pendingRow) }));
      }
      // Always drawn, even when empty: a missing section reads as "this page has
      // no such feature", while an explained empty state reads as "nothing has
      // run yet" — the difference between a broken plugin and an idle one.
      sections.push(
        jsxs("div", {
          className: "FM_pgQueueRecentHead",
          children: [
            jsx("span", { className: "FM_pgRailLabel", children: t("page.queue.recent") }),
            jsx("span", { className: "FM_pgQueueRecentHint", children: t("page.queue.recentHint") }),
          ],
        }),
      );
      sections.push(
        recent.length > 0
          ? jsx("div", {
              className: "FM_pgQueueList",
              children: recent
                .slice(0, 10)
                .map((row, index) => recentRow(row, `recent-${row.sessionId}-${index}-${row.at ?? ""}`)),
            })
          : jsx("p", {
              className: "FM_pgQueueRecentEmpty",
              children: data?.config?.enabled ? t("page.queue.recentEmpty") : t("page.queue.recentEmptyOff"),
            }),
      );
      return jsxs("div", {
        className: "FM_pgQueue",
        children: [
          bar,
          queue.error ? jsx("p", { className: "FM_pgOp FM_pgOpBad", children: queue.error }) : null,
          data
            ? jsx("div", { className: "FM_pgQueueBody", children: sections })
            : jsx(EmptyState, { icon: "clock", title: t("page.queue.empty"), hint: t("page.queue.emptyHint") }),
        ],
      });
    }

    // A health-check card is a batch, not a single diff: the row list is the
    // content, and each row can be struck out before the batch is accepted.
    const AUDIT_DETAILS_SHOWN = 12;
    function AuditDetails(props) {
      const { proposal, t, onPrune } = props;
      const details = Array.isArray(proposal.details) ? proposal.details : [];
      if (details.length === 0) return jsx("p", { className: "FM_pgReason", children: t("page.audit.noDetails") });
      const shown = details.slice(0, AUDIT_DETAILS_SHOWN);
      const rest = details.length - shown.length;
      // An alias card is one two-row decision; dropping a row would leave nothing
      // to merge into, so the strike-out button only appears on fact batches.
      const pruneable = proposal.action === "retire" || proposal.action === "fold_log";
      return jsxs("div", {
        children: [
          jsx("ul", {
            className: "FM_pgList",
            children: shown.map((detail, index) =>
              jsxs(
                "li",
                {
                  className: "FM_pgListItem",
                  children: [
                    jsx("span", {
                      className: "FM_pgListValue",
                      children:
                        detail.kind === "entity"
                          ? String(detail.name ?? "")
                          : detail.missing
                            ? t("page.proposalNone")
                            : String(detail.value ?? ""),
                    }),
                    detail.role === "canonical" ? jsx("span", { className: "FM_pgPill", children: t("page.audit.canonicalTag") }) : null,
                    detail.role === "keep" ? jsx("span", { className: "FM_pgPill", children: t("page.audit.keepTag") }) : null,
                    pruneable && detail.kind === "fact" && detail.factId && detail.role !== "keep"
                      ? jsx("button", {
                          className: "FM_pgMiniBtn",
                          type: "button",
                          title: t("page.audit.prune"),
                          "aria-label": t("page.audit.prune"),
                          onClick: () => onPrune(detail.factId),
                          children: "✕",
                        })
                      : null,
                  ],
                },
                `${proposal.id}-${index}`,
              ),
            ),
          }),
          rest > 0 ? jsx("p", { className: "FM_pgCardMeta", children: t("page.audit.more", { n: rest }) }) : null,
        ],
      });
    }

    function MemoryPage(props) {
      const state = props.useMemoryPage((snapshot) => snapshot);
      const { t, actions } = props;
      const status = state.status;
      const zone = status?.storeTimezone || undefined;
      const stats = status?.stats || {};
      const tabs = [
        { id: "facts", label: t("page.tab.facts"), count: stats.facts ?? 0 },
        { id: "graph", label: t("page.tab.graph"), count: null },
        { id: "proposals", label: t("page.tab.proposals"), count: status?.proposals?.pending ?? 0 },
        { id: "conflicts", label: t("page.tab.conflicts"), count: status?.conflicts?.open ?? 0 },
        // Anything the scheduler is holding: in flight, queued, in the debounce
        // window, or waiting out a retry. That is the number the user asked for.
        {
          id: "queue",
          label: t("page.tab.queue"),
          count:
            (status?.extraction?.running ?? 0) +
            (status?.extraction?.queued ?? 0) +
            (status?.extraction?.waiting ?? 0) +
            (status?.extraction?.retrying ?? 0),
        },
      ];
      // The digest is the controller's snapshot, not a derived count: marking the
      // queue seen zeroes the server side on the very next refresh.
      const digest = state.reviewDigest;
      useEffect(() => {
        actions.refreshAll();
        // The queue poll is page-scoped: resume it on mount, drop it on unmount.
        if (typeof actions.resumeQueuePolling === "function") actions.resumeQueuePolling();
        return () => {
          if (typeof actions.stopQueuePolling === "function") actions.stopQueuePolling();
        };
      }, []);
      // "/" focuses the search from anywhere on the page, and never steals a
      // keystroke from a field the user is already typing in.
      useEffect(() => {
        if (typeof document === "undefined") return undefined;
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
          const target = event.target;
          const typing =
            target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable === true);
          if (event.key === "Escape" && !typing) {
            // The narrow-screen detail pane is a drawer; Escape must close it
            // without hunting for the backdrop.
            if (typeof actions.closeDetail === "function") actions.closeDetail();
            return;
          }
          if (event.key !== "/" || typing) return;
          const input = document.querySelector(".FM_pgSearchInput");
          if (input && typeof input.focus === "function") {
            event.preventDefault();
            input.focus();
          }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
      }, []);
      // The inline receipt is a receipt: fade it instead of leaving "已完成"
      // under the tabs for the rest of the session.
      useEffect(() => {
        if (!state.op || state.op.status === "running") return undefined;
        const timer = setTimeout(() => actions.dismissOp(), 5000);
        if (timer && typeof timer.unref === "function") timer.unref();
        return () => clearTimeout(timer);
      }, [state.op]);
      // Graph edges carry node ids; the relation list must read like prose.
      const nodeLabels = new Map((state.graph.data?.nodes || []).map((node) => [node.id, node.label]));
      const labelOfNode = (id) => nodeLabels.get(id) ?? String(id ?? "").replace(/^[ev]:/, "");
      const opText =
        state.op && state.op.status === "done"
          ? t(`page.done.${state.op.kind}`)
          : state.op && state.op.status === "failed"
            ? state.op.message || t(`page.failed.${state.op.kind}`)
            : state.op && state.op.status === "running"
              ? t(`page.running.${state.op.kind}`)
              : null;
      return jsxs("div", {
        className: "FM_pg",
        children: [
          jsxs("header", {
            className: "FM_pgHead",
            children: [
              jsxs("div", {
                className: "FM_pgHeadMain",
                children: [
                  jsx("span", { className: "FM_pgBrand", children: jsx(Glyph, { kind: "memory", size: 20 }) }),
                  jsxs("div", {
                    children: [
                      jsx("h1", { className: "FM_pgTitle", children: t("panel.title") }),
                      jsxs("p", {
                        className: "FM_pgSubtitle",
                        children: [
                          status?.ok ? t("page.subtitle", { n: stats.facts ?? 0 }) : t("page.unavailable"),
                          status?.extraction?.enabled ? jsx("span", { className: "FM_pgInlinePill", children: t("page.autoOn") }) : null,
                          status?.semantic?.embeddingConfigured ? jsx("span", { className: "FM_pgInlinePill", children: t("page.semanticOn", { model: status.semantic.embeddingModel || "" }) }) : null,
                        ],
                      }),
                    ],
                  }),
                ],
              }),
              jsxs("div", {
                className: "FM_pgHeadActions",
                children: [
                  jsxs("label", {
                    className: "FM_pgSearch",
                    children: [
                      jsx(Glyph, { kind: "search", size: 15 }),
                      jsx("input", {
                        className: "FM_pgSearchInput",
                        placeholder: t("page.searchPlaceholder"),
                        title: t("page.searchHint"),
                        value: state.query,
                        onChange: (event) => actions.setQuery(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key === "Enter") actions.setSearch(event.target.value);
                          if (event.key === "Escape") {
                            event.preventDefault();
                            event.currentTarget.blur();
                            actions.clearQuery();
                          }
                        },
                      }),
                      state.query
                        ? jsx("button", {
                            className: "FM_pgSearchClear",
                            type: "button",
                            title: t("page.searchClear"),
                            "aria-label": t("page.searchClear"),
                            onClick: () => actions.clearQuery(),
                            children: "×",
                          })
                        : jsx("span", { className: "FM_pgKbd", children: "/" }),
                    ],
                  }),
                  jsx("button", {
                    className: "FM_pgIconBtn",
                    type: "button",
                    title: t("page.refresh"),
                    onClick: () => actions.refreshAll(),
                    children: jsx(Glyph, { kind: "refresh", size: 16 }),
                  }),
                ],
              }),
            ],
          }),
          state.recentSearches && state.recentSearches.length > 0
            ? jsxs("div", {
                className: "FM_pgRecentSearches",
                children: [
                  jsx("span", { children: t("page.recentSearches") }),
                  state.recentSearches.map((query) =>
                    jsx("button", { className: "FM_pgRecentChip", type: "button", onClick: () => actions.setSearch(query), children: query }, query),
                  ),
                ],
              })
            : null,
          jsxs("div", {
            className: "FM_pgStats",
            children: [
              jsx(StatCell, { label: t("page.stat.facts"), value: stats.facts ?? 0, hint: t("page.stat.factsHint", { n: stats.active ?? 0 }) }),
              jsx(StatCell, { label: t("page.stat.proposals"), value: status?.proposals?.pending ?? 0, hint: t("page.stat.proposalsHint"), tone: (status?.proposals?.pending ?? 0) > 0 ? "warn" : null }),
              jsx(StatCell, { label: t("page.stat.conflicts"), value: status?.conflicts?.open ?? 0, hint: t("page.stat.conflictsHint"), tone: (status?.conflicts?.open ?? 0) > 0 ? "danger" : null }),
              jsxs("div", {
                className: "FM_pgStat",
                children: [
                  jsx("span", { className: "FM_pgStatLabel", children: t("page.stat.vectors") }),
                  jsx("strong", { className: "FM_pgStatValue", children: String(status?.semantic?.vectors ?? 0) }),
                  jsxs("div", {
                    className: "FM_pgStatFoot",
                    children: [
                      jsx("span", { className: "FM_pgStatHint", children: status?.semantic?.embeddingConfigured ? t("page.stat.vectorsOn") : t("page.stat.vectorsOff") }),
                      status?.semantic?.embeddingConfigured
                        ? jsx("button", { className: "FM_pgMiniBtn", type: "button", onClick: () => actions.indexVectors(), children: t("page.stat.vectorsBuild") })
                        : null,
                    ],
                  }),
                ],
              }),
            ],
          }),
          jsx("nav", {
            className: "FM_pgTabs",
            role: "tablist",
            "aria-label": t("page.tabsLabel"),
            children: tabs.map((tab) =>
              jsxs(
                "button",
                {
                  className: state.tab === tab.id ? "FM_pgTab FM_pgTabOn" : "FM_pgTab",
                  type: "button",
                  role: "tab",
                  "aria-selected": state.tab === tab.id,
                  onClick: () => actions.setTab(tab.id),
                  children: [
                    jsx(Glyph, { kind: tab.id === "facts" ? "layers" : tab.id === "graph" ? "graph" : tab.id === "proposals" ? "spark" : tab.id === "queue" ? "clock" : "alert", size: 15 }),
                    tab.label,
                    tab.count === null ? null : jsx("span", { className: "FM_pgTabCount", children: tab.count }),
                  ],
                },
                tab.id,
              ),
            ),
          }),
          opText ? jsx("p", { className: state.op && state.op.status === "failed" ? "FM_pgOp FM_pgOpBad" : "FM_pgOp", children: opText }) : null,
          state.tab === "proposals" && digest
            ? jsxs("p", {
                className: "FM_pgReviewDigest",
                children: [
                  jsx("span", { children: t("page.review.digest", { n: digest.n }) }),
                  Object.keys(digest.byKind).length > 0
                    ? jsx("span", {
                        className: "FM_pgReviewKinds",
                        children: Object.keys(digest.byKind)
                          .filter((kind) => Number(digest.byKind[kind]) > 0)
                          .map((kind) => t("page.review.kind", { kind: t(`page.proposalKind.${kind}`), n: Number(digest.byKind[kind]) }))
                          .join(" · "),
                      })
                    : null,
                ],
              })
            : null,
          jsxs("div", {
            className: state.detail ? "FM_pgBody FM_pgBodySplit" : "FM_pgBody",
            children: [
              jsxs("section", {
                className: "FM_pgMain",
                children: [
                  state.tab === "facts"
                    ? jsxs("div", {
                        className: "FM_pgFacts",
                        children: [
                          jsx("div", {
                            className: "FM_pgChips",
                            children: [
                              { id: "live", label: t("page.filter.live") },
                              { id: "conflict", label: t("page.filter.conflict") },
                              { id: "scheduled", label: t("page.filter.scheduled") },
                              { id: "expired", label: t("page.filter.expired") },
                              { id: "all", label: t("page.filter.all") },
                            ].map((chip) =>
                              jsx(
                                "button",
                                {
                                  className: state.statusFilter === chip.id ? "FM_pgChip FM_pgChipOn" : "FM_pgChip",
                                  type: "button",
                                  onClick: () => actions.setStatusFilter(chip.id),
                                  children: chip.label,
                                },
                                chip.id,
                              ),
                            ),
                          }),
                          state.facts.loading && state.facts.items.length === 0
                            ? jsx(FactSkeleton, { rows: 3 })
                            : state.facts.items.length === 0
                              ? jsx(EmptyState, {
                                  icon: "memory",
                                  title: state.query ? t("page.facts.emptySearch") : t("page.facts.emptyTitle"),
                                  hint: state.query ? t("page.facts.emptySearchHint") : t("page.facts.emptyIntro"),
                                  action: state.query
                                    ? jsx("button", { className: "FM_pgMiniBtn", type: "button", onClick: () => actions.clearQuery(), children: t("page.searchClear") })
                                    : jsxs("div", {
                                        className: "FM_pgStart",
                                        children: [
                                          jsx("p", { className: "FM_pgStartLabel", children: t("page.facts.tryTitle") }),
                                          jsx("code", { className: "FM_pgStartCode", children: t("page.facts.tryExample") }),
                                          jsxs("div", {
                                            className: "FM_pgStartRow",
                                            children: [
                                              jsx("span", { className: "FM_pgMuted", children: t("page.facts.tryHint") }),
                                              jsx("button", {
                                                className: "FM_pgMiniBtn",
                                                type: "button",
                                                onClick: () => {
                                                  const text = t("page.facts.tryExample");
                                                  const clip = typeof navigator !== "undefined" && navigator ? navigator.clipboard : null;
                                                  if (clip && typeof clip.writeText === "function") {
                                                    clip.writeText(text).then(() => actions.notifyCopied()).catch(() => actions.notifyCopyFailed());
                                                  } else {
                                                    // A host without clipboard access must not
                                                    // claim the text made it there.
                                                    actions.notifyCopyFailed();
                                                  }
                                                },
                                                children: t("page.facts.tryCopy"),
                                              }),
                                            ],
                                          }),
                                        ],
                                      }),
                                })
                              : jsxs("div", {
                                  className: "FM_pgFactListWrap",
                                  children: [
                                    jsx("div", {
                                      className: "FM_pgFactList",
                                      children: state.facts.items.map((fact) =>
                                        jsx(
                                          FactRow,
                                          {
                                            fact,
                                            t,
                                            zone,
                                            selected: state.detail && state.detail.kind === "fact" && state.detail.data?.fact?.id === fact.id,
                                            onOpen: actions.openFact,
                                            onEntity: actions.openEntity,
                                          },
                                          fact.id,
                                        ),
                                      ),
                                    }),
                                    state.facts.hasMore
                                      ? jsxs("div", {
                                          className: "FM_pgLoadMore",
                                          children: [
                                            jsx("button", {
                                              className: "FM_pgGhost",
                                              type: "button",
                                              disabled: state.facts.loading,
                                              onClick: () => actions.loadMoreFacts(),
                                              children: state.facts.loading ? t("page.loading") : t("page.loadMore"),
                                            }),
                                            jsx("span", { className: "FM_pgLoadMoreMeta", children: t("page.loadMoreMeta", { n: state.facts.items.length }) }),
                                          ],
                                        })
                                      : jsx("p", { className: "FM_pgLoadMoreMeta", children: t("page.loadMoreEnd", { n: state.facts.items.length }) }),
                                  ],
                                }),
                        ],
                      })
                    : null,
                  state.tab === "graph"
                    ? jsxs("div", {
                        className: "FM_pgGraphTab",
                        children: [
                          jsxs("div", {
                            className: "FM_pgGraphBar",
                            children: [
                              jsxs("label", {
                                className: "FM_pgSearch FM_pgSearchGrow",
                                children: [
                                  jsx(Glyph, { kind: "tag", size: 15 }),
                                  jsx("input", {
                                    className: "FM_pgSearchInput",
                                    placeholder: t("page.graph.entityPlaceholder"),
                                    value: state.graph.entity,
                                    onChange: (event) => actions.setGraphEntity(event.target.value),
                                    onKeyDown: (event) => {
                                      if (event.key === "Enter") actions.loadGraph(state.graph.entity, state.graph.view);
                                    },
                                  }),
                                ],
                              }),
                              jsx("button", {
                                className: "FM_pgPrimary",
                                type: "button",
                                disabled: !state.graph.entity,
                                onClick: () => actions.loadGraph(state.graph.entity, state.graph.view),
                                children: t("page.graph.load"),
                              }),
                              jsx("button", {
                                className: "FM_pgIconBtn",
                                type: "button",
                                title: t("page.graph.refresh"),
                                "aria-label": t("page.graph.refresh"),
                                onClick: () => actions.loadGraph(state.graph.entity, state.graph.view),
                                children: jsx(Glyph, { kind: "refresh", size: 15 }),
                              }),
                              jsx("div", {
                                className: "FM_pgSeg",
                                children: [
                                  { id: "current", label: t("page.graph.current") },
                                  { id: "all", label: t("page.graph.all") },
                                ].map((item) =>
                                  jsx(
                                    "button",
                                    {
                                      className: state.graph.view === item.id ? "FM_pgSegBtn FM_pgSegOn" : "FM_pgSegBtn",
                                      type: "button",
                                      onClick: () => actions.setGraphView(item.id),
                                      children: item.label,
                                    },
                                    item.id,
                                  ),
                                ),
                              }),
                            ],
                          }),
                          state.graph.loading ? jsx("p", { className: "FM_pgMuted", children: t("page.loading") }) : null,
                          state.graph.error ? jsx("p", { className: "FM_pgOp FM_pgOpBad", children: state.graph.error }) : null,
                          state.graph.data
                            ? jsx(NebulaCanvas, { graph: state.graph, t, actions })
                            : jsx(EmptyState, { icon: "graph", title: t("page.graph.prompt"), hint: t("page.graph.promptHint") }),
                          state.graph.data
                            ? jsxs("div", {
                                className: "FM_pgEdgeList",
                                children: [
                                  jsx("p", { className: "FM_pgRailLabel", children: t("page.graph.relations") }),
                                  (state.graph.data.edges || []).map((edge, index) =>
                                    jsxs(
                                      "div",
                                      {
                                        className: "FM_pgEdgeRow",
                                        children: [
                                          jsx("span", { className: "FM_pgNodeName", children: labelOfNode(edge.source) }),
                                          jsx(Glyph, { kind: "chevron", size: 13 }),
                                          jsx("span", { className: "FM_pgPred", children: edge.predicate }),
                                          jsx(Glyph, { kind: "chevron", size: 13 }),
                                          jsx("span", { className: "FM_pgNodeName", children: labelOfNode(edge.target) }),
                                          jsx("span", { className: "FM_pgEdgeCount", children: t("page.graph.factCount", { n: (edge.factIds || []).length }) }),
                                          jsx(StatusPill, { status: edge.status, t }),
                                        ],
                                      },
                                      `edge-row-${index}`,
                                    ),
                                  ),
                                ],
                              })
                            : null,
                        ],
                      })
                    : null,
                  state.tab === "proposals"
                    ? state.proposals.items.length === 0
                      ? jsx(EmptyState, { icon: "spark", title: t("page.proposals.empty"), hint: t("page.proposals.emptyHint") })
                      : jsx("div", {
                          className: "FM_pgCards",
                          children: state.proposals.items.map((proposal) =>
                            jsxs(
                              "article",
                              {
                                className: "FM_pgCard",
                                children: [
                                  jsxs("div", {
                                    className: "FM_pgCardHead",
                                    children: [
                                      jsx("span", { className: "FM_pgEntity", children: entityLabel(proposal.entity) }),
                                      jsx("span", { className: "FM_pgSep", children: "·" }),
                                      jsx("span", { className: "FM_pgPred", children: proposal.predicate }),
                                      jsx("span", { className: "FM_pgPill FM_pgPill_warn", children: t(`page.proposalKind.${proposal.kind}`) }),
                                    ],
                                  }),
                                  proposal.kind === "audit"
                                    ? jsx(AuditDetails, {
                                        proposal,
                                        t,
                                        onPrune: (factId) => actions.pruneProposal(proposal.id, [factId]),
                                      })
                                    : jsxs("div", {
                                        className: "FM_pgDiff",
                                        children: [
                                          jsx("span", { className: "FM_pgDiffOld", children: proposal.current ?? t("page.proposalNone") }),
                                          jsx("span", { className: "FM_pgArrow", children: "→" }),
                                          jsx("span", { className: "FM_pgDiffNew", children: proposal.value }),
                                        ],
                                      }),
                                  jsxs("p", {
                                    className: "FM_pgCardMeta",
                                    children: [
                                      proposal.confidence !== null && proposal.confidence !== undefined
                                        ? t("page.proposalConfidence", { n: Math.round(proposal.confidence * 100) })
                                        : t("page.proposalNoConfidence"),
                                      jsx("span", { className: "FM_pgDot" }),
                                      t("page.proposalRevision", { n: proposal.revision }),
                                    ],
                                  }),
                                  proposal.reason ? jsx("p", { className: "FM_pgReason", children: proposal.reason }) : null,
                                  jsxs("div", {
                                    className: "FM_pgCardActions",
                                    children: [
                                      jsx("button", { className: "FM_pgPrimary", type: "button", onClick: () => actions.acceptProposal(proposal.id), children: t("page.accept") }),
                                      jsx("button", { className: "FM_pgGhost", type: "button", onClick: () => actions.rejectProposal(proposal.id), children: t("page.reject") }),
                                    ],
                                  }),
                                ],
                              },
                              proposal.id,
                            ),
                          ),
                        })
                    : null,
                  state.tab === "conflicts"
                    ? state.conflicts.groups.length === 0
                      ? jsx(EmptyState, { icon: "check", title: t("page.conflicts.empty"), hint: t("page.conflicts.emptyHint") })
                      : jsx("div", {
                          className: "FM_pgCards",
                          children: state.conflicts.groups.map((group) =>
                            jsxs(
                              "article",
                              {
                                className: "FM_pgCard FM_pgCardDanger",
                                children: [
                                  jsxs("div", {
                                    className: "FM_pgCardHead",
                                    children: [
                                      jsx(Glyph, { kind: "alert", size: 15 }),
                                      jsx("span", { className: "FM_pgEntity", children: group.rows[0]?.entity ?? "" }),
                                      jsx("span", { className: "FM_pgSep", children: "·" }),
                                      jsx("span", { className: "FM_pgPred", children: group.rows[0]?.predicate ?? "" }),
                                      jsx("span", { className: "FM_pgPill FM_pgPill_danger", children: t("page.conflictOpen") }),
                                    ],
                                  }),
                                  jsx("p", { className: "FM_pgMuted", children: t("page.conflictHint") }),
                                  jsx("div", {
                                    className: "FM_pgConflictRows",
                                    children: (group.rows || []).map((row) =>
                                      jsxs(
                                        "div",
                                        {
                                          className: "FM_pgConflictRow",
                                          children: [
                                            jsx("span", { className: "FM_pgValueSm", children: row.value }),
                                            jsx("span", { className: "FM_pgMeta", children: shortTime(row.observedAt, zone) }),
                                            jsx(StatusPill, { status: row.status, t }),
                                            jsxs("div", {
                                              className: "FM_pgConflictActions",
                                              children: [
                                                jsx("button", { className: "FM_pgPrimary", type: "button", onClick: () => actions.resolveConflict(row.factId, "keep"), children: t("page.keepThis") }),
                                                jsx("button", { className: "FM_pgGhost", type: "button", onClick: () => actions.resolveConflict(row.factId, "multi"), children: t("page.keepBoth") }),
                                                jsx("button", { className: "FM_pgGhost FM_pgDanger", type: "button", onClick: () => actions.resolveConflict(row.factId, "drop"), children: t("page.dropAll") }),
                                              ],
                                            }),
                                          ],
                                        },
                                        row.factId,
                                      ),
                                    ),
                                  }),
                                ],
                              },
                              group.id,
                            ),
                          ),
                        })
                    : null,
                  state.tab === "queue" ? jsx(QueuePanel, { queue: state.queue, t, zone, actions }) : null,
                ],
              }),
              state.detail
                ? state.detail.loading
                  ? jsx("aside", { className: "FM_pgRail", children: jsx("p", { className: "FM_pgMuted", children: t("page.loading") }) })
                  : state.detail.kind === "fact"
                    ? jsx(FactDetail, { detail: state.detail, t, zone, actions })
                    : jsx(EntityDetail, { detail: state.detail, t, zone, actions })
                : null,
            ],
          }),
          state.detail
            ? jsx("div", { className: "FM_pgSheetBackdrop", onClick: () => actions.closeDetail() })
            : null,
          jsx(ToastView, { toast: state.toast, t, onUndo: () => actions.runUndo(), onDismiss: () => actions.dismissToast() }),
        ],
      });
    }

    function MemoryHeaderButton(props) {
      const { t, open, refreshBadge, useMemoryBadge } = props;
      const badge = useMemoryBadge((snapshot) => snapshot.status);
      useEffect(() => {
        if (typeof refreshBadge === "function") refreshBadge();
      }, []);
      // Pending proposals and open conflict groups are the two things waiting for a human.
      const count = (badge?.proposals?.pending ?? 0) + (badge?.conflicts?.open ?? 0);
      return jsxs("button", {
        className: "FM_pgHeaderBtn",
        type: "button",
        title: t("page.openPanel"),
        onClick: () => open(),
        children: [
          jsx(Glyph, { kind: "memory", size: 15 }),
          jsx("span", { children: t("panel.label") }),
          count > 0 ? jsx("span", { className: "FM_pgHeaderBadge", children: count > 99 ? "99+" : String(count) }) : null,
        ],
      });
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: { ...zh, ...zhPage }, en: { ...en, ...enPage } }), "dsh-fact-memory: dictionaries");
      const t = ctx.locale.bind(NS);
      const form = createFormController(ctx.configForms.get(NS));
      const page = createPageController(ctx);
      ctx.effect(
        () => {
          form.refreshStatus();
          return () => {};
        },
        "dsh-fact-memory: initial status",
      );
      // The library is a first-class panel, not a settings sub-page: browsing,
      // editing and resolving is the daily job, configuration is the rare one.
      ctx.effect(
        () => {
          const disposers = [];
          disposers.push(
            ctx.slots.inject("main", () =>
              ctx.slots.register(
                {
                  name: "main",
                  key: PANEL_ID,
                  locale: NS,
                  inject: () => ({ hooks: { memoryPage: page.store }, actions: page.actions }),
                },
                MemoryPage,
              ),
            ),
          );
          disposers.push(
            ctx.slots.inject("sidebar.panellist", () =>
              ctx.slots.register(
                {
                  name: "sidebar.panellist",
                  id: PANEL_ID,
                  order: 12,
                  locale: NS,
                  label: () => t("panel.title"),
                },
                MemoryPanelIcon,
              ),
            ),
          );
          disposers.push(
            ctx.slots.inject("conversation.session.header.utilities", () =>
              ctx.slots.register(
                {
                  name: "conversation.session.header.utilities",
                  id: "fact-memory-entry",
                  order: -4,
                  locale: NS,
                  inject: () => ({
                    hooks: { memoryBadge: page.store },
                    refreshBadge: page.actions.refreshBadge,
                    open: () => {
                      // `ctx.layout` is only readable once the layout service is
                      // provided; at apply time it may still be absent, which made
                      // the button look dead. Resolve it on click instead.
                      const layout = ctx.get?.("layout") ?? ctx.layout;
                      try {
                        layout?.selectPanel?.(PANEL_ID);
                      } catch {
                        /* older host without a panel switcher */
                      }
                    },
                  }),
                },
                MemoryHeaderButton,
              ),
            ),
          );
          const surfaces = createSurfaceController(ctx, page);
      onWipeHook = () => {
        page.afterWipe();
        surfaces.resetAfterWipe();
      };
          disposers.push(
            ctx.slots.inject("conversation.chat.turnTail", () =>
              ctx.slots.register(
                {
                  name: "conversation.chat.turnTail",
                  id: "fact-memory-turn",
                  order: 30,
                  locale: NS,
                  inject: (sessionId) => ({
                    sessionId,
                    openDrawer: surfaces.openDrawer,
                    hooks: { turn: surfaces.turn },
                    refreshTurn: surfaces.refreshTurn,
                    cancelTurn: surfaces.cancelTurn,
                  }),
                },
                TurnMemoryCard,
              ),
            ),
          );
          disposers.push(
            ctx.slots.inject("sidebar.session.row.leading", () =>
              ctx.slots.register(
                {
                  name: "sidebar.session.row.leading",
                  id: "fact-memory-mark",
                  order: 12,
                  locale: NS,
                  inject: () => ({ hooks: { sessions: surfaces.sessions }, refreshSessions: surfaces.refreshSessions }),
                },
                SessionMemoryMark,
              ),
            ),
          );
          // The right drawer needs a tab *kind* before openTab() has anything to
          // show. `sidebarRightTabs` is provided by another plugin, so wait for it
          // instead of sampling it once at apply time (a later provider would be
          // missed and the drawer would silently never open).
          ctx.inject(["sidebarRightTabs"], (scope) => {
            const inner = [];
            inner.push(
              scope.sidebarRightTabs.register({
                id: DRAWER_TAB_ID,
                kind: DRAWER_KIND,
                priority: "builtin",
                title: () => t("drawer.title"),
              }),
            );
            inner.push(
              scope.slots.inject("sidebar.right.pane.tab", () =>
                scope.slots.register(
                  {
                    name: "sidebar.right.pane.tab",
                    key: DRAWER_TAB_ID,
                    locale: NS,
                    inject: () => ({
                      hooks: { drawer: surfaces.drawer },
                      close: surfaces.closeDrawer,
                      openFact: surfaces.openInPanel,
                      resume: surfaces.resumeDrawer,
                    }),
                  },
                  MemoryDrawer,
                ),
              ),
            );
            inner.push(
              scope.slots.inject("sidebar.right.pane.tab.title", () =>
                scope.slots.register(
                  {
                    name: "sidebar.right.pane.tab.title",
                    key: DRAWER_TAB_ID,
                    locale: NS,
                    inject: () => ({ hooks: { drawer: surfaces.drawer } }),
                  },
                  MemoryDrawerTitle,
                ),
              ),
            );
            return () => {
              for (const dispose of inner) {
                if (typeof dispose === "function") dispose();
              }
            };
          });
          return () => {
            onWipeHook = null;
            for (const dispose of disposers) {
              if (typeof dispose === "function") dispose();
            }
          };
        },
        "dsh-fact-memory: page registration",
      );

      ctx.effect(
        () =>
          ctx.configForms.whileServed([NS], () =>
            ctx.slots.inject("plugins.item", () =>
              ctx.slots.register(
                {
                  name: "plugins.item",
                  id: NS,
                  order: 30,
                  label: () => t("card.title"),
                  locale: NS,
                  inject: () => ({
                    hooks: { factMemory: form.store },
                    // The card can stay mounted for a long time; it refreshes on
                    // its own so its counts never contradict the page.
                    refresh: form.refreshStatus,
                    ...form.actions,
                  }),
                },
                FactMemoryCard,
              ),
            ),
          ),
        "dsh-fact-memory: card registration",
      );
    }

    exports.apply = apply;
    exports.inject = INJECT_SERVICES;
    return module.exports;
  },
});
