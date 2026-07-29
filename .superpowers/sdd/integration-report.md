# 双专题重构集成报告

## 实现内容

- 新增可重复执行的 `scripts/patch_renzhi_topic_restructure.py`。
- 补丁只通过 `scripts/edit-bundle.py` 读取、重排、插页、回填和验证 bundle。
- 使用 `eb.move_page()` 将 Self-Evaluation 章重排为平台专题、训练专题两条连续主线。
- 使用 `eb.insert_page()` 新增：
  - P14 `kc-train-outcomes`，导航短码 `训战`。
  - P18 `ai-coding-reflection`，导航短码 `AI码`。
- 重建 `专业知识`、`kc-resp-proj`、`kc-sol-agent`、`kc-mgmt`、`kc-resp-cap`、`kc-sol-a3`。
- 统一 21 页 `data-idx=0–20`、企业页脚 `Page 1–21`，章节起点为 `[2, 5, 17]`。
- 实现完成态幂等检测，以及部分完成态/非基线状态的明确拒绝。

## RED 证据

- RED 测试提交：`3a71532 test: 添加认知答辩双专题验收断言`。
- 章节匹配范围修正提交：`9c98725 test: 限定认知答辩章节起点匹配范围`。
- 实现前运行：

  ```text
  python3 scripts/verify/test_renzhi_topic_restructure.py
  AssertionError: 页面顺序错误:
  ['封面页', '目录页', '工作经历', '主要项目', '目录页', '专业知识',
   'kc-resp-proj', 'kc-resp-cap', 'kc-sol-agent', 'kc-sol-a3',
   'kc-iss-ctc', 'kc-iss-cad', 'kc-mgmt', 'kc-comm', '专业回馈',
   '目录页', '反思建议', '待改进', '结语']
  ```

## GREEN 命令与完整结果摘要

```text
$ python3 scripts/patch_renzhi_topic_restructure.py
slide-fit=21  sections=21  nav=21  nav_seq_ok=True
chapters: ["name:'Working Experience', start:2",
           "name:'Self-Evaluation', start:5",
           "name:'Reflections & Suggestions', start:17"]

$ python3 scripts/verify/test_renzhi_topic_restructure.py
slide-fit=21  sections=21  nav=21  nav_seq_ok=True
chapters: ["name:'Working Experience', start:2",
           "name:'Self-Evaluation', start:5",
           "name:'Reflections & Suggestions', start:17"]
PASS: renzhi topic restructure

$ python3 scripts/patch_renzhi_topic_restructure.py
deck 已是双专题完成态，未重复修改

$ python3 scripts/edit-bundle.py Deck-Projects/renzhi/renzhi-deck.html
slide-fit=21  sections=21  nav=21  nav_seq_ok=True
chapters: ["name:'Working Experience', start:2",
           "name:'Self-Evaluation', start:5",
           "name:'Reflections & Suggestions', start:17"]
```

四条命令退出码均为 `0`。

## 修改文件与提交

- 提交文件：`scripts/patch_renzhi_topic_restructure.py`
- 生成但不提交：`Deck-Projects/renzhi/renzhi-deck.html`
- 不提交：`AGENTS.md`
- 提交：`518116c feat: 完成认知答辩双专题 bundle 重构`

## 自审

- 未修改 `scripts/edit-bundle.py` 或验收测试。
- deck 未被编辑器或补丁工具直接修改；完成态由生产补丁脚本生成。
- 两张新增页均使用规定的 `slide-fit → slide-canvas → section` 外壳。
- 所有必需 token 与禁止性断言由验收测试覆盖并通过。
- 新增正文最小字号为 `21px`；脚本中低于 `21px` 的唯一字号是企业页脚 `15px`。
- 未添加外部图片、外部依赖、内联 `onclick` 或自动动画。
- `build` 均挂在可见外层容器，动画组未提前显示空框。
- `git diff --check` 无错误。

## 未解决风险

- 专门视觉 QA 由后续任务继续。集成期间曾对全页运行溢出检查，21 页 section overflow 均为 `0`；未改动的 `kc-iss-ctc` 保留基线已有的 4 条 nested clip 提示。
- P7、P11、P14、P15、P18 已完成首轮截图检查并做过一次容器比例/垂直对齐修正；最终逐拍与截图复核留给后续视觉 QA。

## 审查修复 TDD 证据

### 修复范围

- P7 平台构建扩展为四个等宽证据节点，补充 `X+ Field Practice` 与 `Cluster Integration Agent`，保留 `Middle-Lane + Lower-Lane Agents`。
- P11 第四治理块替换为有结果证据的闭环案例：
  `All sprint items closed; core migration modules delivered; security inspection passed; HIS production online.`
- 完成态快路径先执行完整结构验证，并额外静默校验 nav 数量、序号与 label；只有通过后才打印幂等提示。

### RED

扩充验收测试后、修改生产脚本前运行：

```text
$ python3 scripts/verify/test_renzhi_topic_restructure.py
AssertionError: kc-resp-proj 缺少文案: X+ Field Practice
退出码：1
```

### GREEN

```text
$ python3 scripts/verify/test_renzhi_topic_restructure.py
slide-fit=21  sections=21  nav=21  nav_seq_ok=True
chapters: ["name:'Working Experience', start:2",
           "name:'Self-Evaluation', start:5",
           "name:'Reflections & Suggestions', start:17"]
PASS: renzhi topic restructure
退出码：0

$ python3 scripts/patch_renzhi_topic_restructure.py
deck 已是双专题完成态，未重复修改
退出码：0

$ python3 scripts/edit-bundle.py Deck-Projects/renzhi/renzhi-deck.html
slide-fit=21  sections=21  nav=21  nav_seq_ok=True
chapters: ["name:'Working Experience', start:2",
           "name:'Self-Evaluation', start:5",
           "name:'Reflections & Suggestions', start:17"]
退出码：0
```

验收测试另用临时 deck 分别破坏 nav 数量、序号和 label；三种场景均在幂等成功提示前抛出对应错误，标准输出保持为空。

审查修复提交：`9d5a78c fix: 补齐双专题证据与幂等校验`

## P7 复审回归修复

- 回归原因：P7 四卡加入 `X+ Field Practice` 与 `Cluster Integration Agent` 时，误删设计要求的 `Model Migration & Tuning Agent`。
- 修复方式：保留四张等宽卡，在 `Middle-Lane + Lower-Lane Agents` 卡内增加 21px 第二行 `Model Migration & Tuning Agent`。

### RED

```text
$ python3 scripts/verify/test_renzhi_topic_restructure.py
AssertionError: kc-resp-proj 缺少文案: Model Migration & Tuning Agent
退出码：1
```

### GREEN

```text
$ python3 scripts/verify/test_renzhi_topic_restructure.py
slide-fit=21  sections=21  nav=21  nav_seq_ok=True
chapters: ["name:'Working Experience', start:2",
           "name:'Self-Evaluation', start:5",
           "name:'Reflections & Suggestions', start:17"]
PASS: renzhi topic restructure
退出码：0

$ python3 scripts/patch_renzhi_topic_restructure.py
deck 已是双专题完成态，未重复修改
退出码：0

$ python3 scripts/edit-bundle.py Deck-Projects/renzhi/renzhi-deck.html
slide-fit=21  sections=21  nav=21  nav_seq_ok=True
chapters: ["name:'Working Experience', start:2",
           "name:'Self-Evaluation', start:5",
           "name:'Reflections & Suggestions', start:17"]
退出码：0
```

P7 回归修复提交：`33fd336 fix: 恢复 P7 模型迁移智能体证据`

## 视觉 QA 聚焦修复

### 修改

- P6：六个主题条目改为完整语句单容器垂直居中，左右主题卡保持等高，原文与字号不变。
- P7：四张 Platform Construction 卡纵向撑满区域；Collaborative Operating Model 增加闭环回流说明：
  `Closure evidence and knowledge feedback return to the next field task`。
- P8：增加 Mid-Route → Platform Core → Down-Route 红色主流程箭头，以及三域向下连接 OCC 的箭头；十个能力框文字垂直居中。
- P13：Training Taskforce 与 Enablement 两栏共八个能力条目文字垂直居中；底部三项数据与原文保持不变。
- 未新增外部素材、自动动画或未经确认的 A5 硬件事实。

### 验证结果

```text
$ python3 scripts/patch_renzhi_topic_restructure.py
slide-fit=21  sections=21  nav=21  nav_seq_ok=True
chapters: ["name:'Working Experience', start:2",
           "name:'Self-Evaluation', start:5",
           "name:'Reflections & Suggestions', start:17"]
退出码：0

$ python3 scripts/verify/test_renzhi_topic_restructure.py
slide-fit=21  sections=21  nav=21  nav_seq_ok=True
chapters: ["name:'Working Experience', start:2",
           "name:'Self-Evaluation', start:5",
           "name:'Reflections & Suggestions', start:17"]
PASS: renzhi topic restructure
退出码：0

$ python3 scripts/edit-bundle.py Deck-Projects/renzhi/renzhi-deck.html
slide-fit=21  sections=21  nav=21  nav_seq_ok=True
chapters: ["name:'Working Experience', start:2",
           "name:'Self-Evaluation', start:5",
           "name:'Reflections & Suggestions', start:17"]
退出码：0

$ node scripts/verify/measure_overflow.mjs Deck-Projects/renzhi/renzhi-deck.html --all
21 页 section overflow 均为 Y=0、X=0
P6/P7/P8/P13 nested clips 均为 0
未改动 P10 保留基线已有的 4 条 nested clip 提示
退出码：0
```

### 最终截图与目检

- P6：`/tmp/renzhi-topic-visual-fix/p06-overview.jpg`
- P7：`/tmp/renzhi-topic-visual-fix/p07-platform.jpg`
- P8：`/tmp/renzhi-topic-visual-fix/p08-architecture.jpg`
- P13：`/tmp/renzhi-topic-visual-fix/p13-taskforce.jpg`

四页均未发现新重叠、裁切或页脚遮挡；垂直居中、P7 闭环回流和 P8 架构连接均清晰可见。

本轮提交主题：`fix: 优化双专题页面视觉连接与对齐`

## 最终独立评审修复

### 内容与完成态防回归

- P7 补充来源脚注：
  `Source: AICO platform and integrated-delivery operating records`。
- P14 补齐 Qwen2.5-7B GRPO 的 20% 结果、MS-RL / VeRL 八项加速验证和四层产品知识栈明细；动画步骤固定为 `{0, 1, 2, 3}`。
- P15 补齐 `Mresident ∝ Ptotal`、`Ftoken ∝ Pactive`，拆分 `Prune Layers` 与 `Reduce Total Experts`，补充单节点代理测量阶段和边界；动画步骤固定为 `{0, 1, 2, 3, 4}`。
- P18 将 Practice 明确拆为 `Infra Development` 与 `Agent Development`，分离 Boundaries / Human Accountability、Verification、Core View / Open Question；动画步骤固定为 `{0, 1, 2, 3}`。
- `validate_complete()` 新增四页关键文案、三页精确动画步骤和 P14 A5 禁止性硬件事实校验。
- 验收测试新增关键文案破坏、动画步骤破坏、A5 硬件事实注入三个完成态负向场景；均要求在幂等成功提示前静默拒绝。

### RED / GREEN

扩充验收后、修改生产补丁前：

```text
$ python3 scripts/verify/test_renzhi_topic_restructure.py
AssertionError: kc-resp-proj 缺少文案: Source: AICO platform and integrated-delivery operating records
退出码：1
```

从原始 19 页基线重新生成后：

```text
$ python3 scripts/patch_renzhi_topic_restructure.py
slide-fit=21  sections=21  nav=21  nav_seq_ok=True
chapters: ["name:'Working Experience', start:2",
           "name:'Self-Evaluation', start:5",
           "name:'Reflections & Suggestions', start:17"]
退出码：0

$ python3 scripts/verify/test_renzhi_topic_restructure.py
slide-fit=21  sections=21  nav=21  nav_seq_ok=True
chapters: ["name:'Working Experience', start:2",
           "name:'Self-Evaluation', start:5",
           "name:'Reflections & Suggestions', start:17"]
PASS: renzhi topic restructure
退出码：0
```

验收测试中的 nav 数量、序号、label、关键文案、动画步骤和 A5 禁止事实六类破坏场景均被完成态快路径拒绝，且标准输出为空。

### 结构、溢出与视觉复核

```text
$ eb.verify(Deck-Projects/renzhi/renzhi-deck.html)
slide-fit=21  sections=21  nav=21  nav_seq_ok=True
chapters: ["name:'Working Experience', start:2",
           "name:'Self-Evaluation', start:5",
           "name:'Reflections & Suggestions', start:17"]
退出码：0

$ node scripts/verify/measure_overflow.mjs Deck-Projects/renzhi/renzhi-deck.html --all
21 页 section overflow 均为 Y=0、X=0
P7/P14/P15/P18 nested clips 均为 0
未改动 P10 保留基线已有的 4 条 nested clip 提示
退出码：0
```

终态截图：

- P7：`/tmp/renzhi-topic-final-review/p07-platform.jpg`
- P14：`/tmp/renzhi-topic-final-review/p14-training-outcomes.jpg`
- P15：`/tmp/renzhi-topic-final-review/p15-a3-estimate.jpg`
- P18：`/tmp/renzhi-topic-final-review/p18-ai-coding.jpg`

逐拍结果：

- P11：5 帧，`/tmp/renzhi-topic-final-review/steps-p11/`
- P14：5 帧，`/tmp/renzhi-topic-final-review/steps-p14/`
- P15：6 帧，`/tmp/renzhi-topic-final-review/steps-p15/`
- P18：5 帧，`/tmp/renzhi-topic-final-review/steps-p18/`

已逐帧目检 21 张图片：每个点击步骤均新增对应可见内容，未发现新增重叠、裁切、页脚遮挡或中间步骤空容器。

本轮提交主题：`fix: 落实认知答辩最终评审修复`
