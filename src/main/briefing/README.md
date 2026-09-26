# 每日简报模板（briefing）

固定的邮件模板，Apple 式设计：藏青品牌头图（Logo 为内联 SVG，不依赖外部图片）、
四色指标、四色分区（待审批橙 / 新增命题蓝 / 主题追踪青 / 冲突红）。

## 文件

- `template.html` — 固定模板，占位符 `{{...}}`。纯 table + 内联样式，Apple Mail / Gmail / Outlook 可用。
- `render.mjs` — 填充器：只读账本，输出成品 HTML。不写账本、不调 LLM。

## 用法

```bash
# 用真实账本渲染今日简报
node src/main/briefing/render.mjs --out /tmp/briefing.html

# 指定账本 / 日期 / 追踪命中
node src/main/briefing/render.mjs \
  --ledger ~/.config/脉络/meridian.json \
  --date 2026-09-27 \
  --watch /tmp/watch.json \
  --out /tmp/briefing.html
```

`--watch` 的 JSON 格式：

```json
[
  { "theme": "光互连", "hits": [
    { "title": "标题", "source": "来源", "url": "https://…", "why": "与主题相关的原因" }
  ]}
]
```

环境变量 `MERIDIAN_LEDGER` 可代替 `--ledger`。

## 定时发送（待用户确认后接入）

计划：每天 08:00（Asia/Shanghai）由 cron 生成 HTML，经 Gmail 发出；
无新内容时不发送。收件地址、时间、空内容策略由用户定，见任务记录。
