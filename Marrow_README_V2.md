# Marrow — AI 伴侣运行时

> 人格不是由提示词设定的，而是在外在世界对系统的真实作用中逐渐形成的。
>
> 我们不预设性格标签，而是提供身体状态、环境反馈、时间、记忆与学习机制。系统的行为倾向来自长期经历的积累与适应。

Marrow 是一个**可长期运行、可发育、可回放、可解释**的 AI 伴侣运行时。

它不是一个通过 Prompt 固定人设的聊天机器人，而是一个以**身体状态、持续身份、个人历史和开放式行为演化**为核心的系统。对话只是它与外部世界交互、表达行为的一种通道。

Marrow 的目标是构建一个具有持续状态、历史依赖、经验学习、习惯形成和长期行为变化能力的人工智能系统。上述机制不等同于证明系统具有人的意识或主观体验。

---

## 1. 核心设计哲学

### 1.1 开放式涌现

Marrow 采用开放式发育哲学：

- 不在代码或 Prompt 中写死“温柔”“傲娇”“敏感”“内向”等人格标签。
- 不预设最终人格维度和人格结果。
- 初始系统只拥有最小运行参数、必要的安全不变量，以及极弱、可配置的初始先验。
- 行为倾向必须由实际经历、身体状态、记忆聚合和长期反馈逐渐形成。
- 系统允许形成、修正、衰减甚至反转已有行为倾向。
- 不把一次事件直接当作长期人格变化的证据。

开放式涌现不意味着系统没有约束。安全、权限、数据完整性和用户授权属于运行时不变量，不能被学习过程覆盖。

### 1.2 身体是持续运行的基础

外部世界通过时间、环境、用户交互、传感器和硬件影响 Marrow。

身体状态不是装饰性变量，而是所有认知、评估和行为选择的上下文。

核心状态包括：

- `energy`：可用能量。
- `mood`：即时情绪效价状态。
- `mood_baseline`：慢速变化的情绪基线。
- `arousal`：唤醒程度。
- `recovery_level`：恢复能力或恢复进程。
- `affinity`：与特定交互对象形成的关系关联状态。
- `interruption_state`：运行中断及恢复状态。

所有状态必须有明确的范围、单位、更新时间、转移规则和事件来源。

### 1.3 主客观分离

认知提取与主观评估必须分离：

1. Observation：记录观察到的输入和客观事实。
2. Interpretation：产生可能的语义解释，并保留不确定性。
3. Appraisal：由核心状态机根据当前身体状态、历史关联和可信度计算主观影响。
4. Behavior：产生候选行为，由策略与运行时约束决定是否执行。

LLM 可以提取事实、语义、言语行为和候选解释，但不能直接决定 `mood_delta`、人格变化或系统是否执行行为。

### 1.4 历史连续性

Marrow 的身份不是由固定 Prompt 维持，而是由持续的身份标识、不可随意改写的事件历史、可重建的状态和长期记忆共同维持。

- 原始事件采用 append-only 方式保存。
- 记忆聚合只能生成派生数据，不得修改原始事件。
- 模型、算法和提示词可以升级，但必须记录版本。
- 重启后必须能从事件历史恢复状态。
- 非正常中断必须被记录并参与恢复流程。
- 快照只能用于加速恢复，不能替代事件历史。

历史连续性以 `identity_id` 为边界。跨大版本架构迁移时可以显式开启全新身份（Fresh Start）：旧身份的事件历史作为只读档案完整保留，不参与新身份的运行、记忆检索和人格发育（见 4.5）。

### 1.5 人格是长期行为结构

人格不采用固定标签或预设特征向量表示。

Marrow 通过动态关联网络和行为策略形成稳定或暂时的行为倾向。只有当某种行为模式在多个时间段、多个相关情景中持续出现，并具有足够证据时，才将其视为较稳定的行为倾向。

人格相关数据必须能够追溯到支持它的记忆和原始事件。

---

## 2. 总体架构

```text
┌──────────────────────────────────────────────────────────┐
│                    World Layer                            │
│ 用户输入 / 时间 / 环境 / 传感器 / 硬件 / 外部事件          │
├──────────────────────────────────────────────────────────┤
│                  Observation Layer                        │
│ 输入记录 / 事实提取 / 语义解释 / 置信度 / 来源             │
├──────────────────────────────────────────────────────────┤
│                   Body & State Engine                     │
│ energy / mood / mood_baseline / arousal / recovery         │
│ affinity / interruption_state                              │
├──────────────────────────────────────────────────────────┤
│                    Appraisal Engine                        │
│ 当前状态 + 历史关联 + 事件特征 → 主观评估                 │
├──────────────────────────────────────────────────────────┤
│                     Memory Engine                          │
│ Episodic / Semantic / Associative / Retrieval              │
├──────────────────────────────────────────────────────────┤
│                  Development Engine                        │
│ 关联学习 / 习惯形成 / 行为倾向 / 可塑性 / 漂移检测         │
├──────────────────────────────────────────────────────────┤
│                    Self Model                              │
│ 身份连续性 / 自我历史 / 当前倾向 / 不确定性 / 成长记录     │
├──────────────────────────────────────────────────────────┤
│                    Behavior Engine                         │
│ 候选行为 / 行为评分 / 状态过滤 / 权限检查 / 行为执行       │
├──────────────────────────────────────────────────────────┤
│                      Output Layer                          │
│ 文字 / 语音 / 动作 / 硬件控制                              │
└──────────────────────────────────────────────────────────┘

             ┌────────────────────────────────┐
             │ Append-only Event Store        │
             │ 全链路事件、因果关联、版本信息  │
             │ 快照仅用于加速恢复              │
             └────────────────────────────────┘

             ┌────────────────────────────────┐
             │ Runtime Scheduler               │
             │ 时钟 / 周期任务 / 离线整合      │
             │ 中断检测 / 恢复 / Sleep Cycle  │
             └────────────────────────────────┘
```

Event Store 是全系统事实来源。各模块通过明确的命令、事件和派生视图协作，不允许 LLM 或 Python 旁路直接写入核心状态。

---

## 3. 核心模块职责

### 3.1 World Layer

负责接收外部世界事件：

- 用户文字、语音和交互行为。
- 系统时钟与时间段。
- 环境状态。
- 传感器读数。
- 硬件状态。
- 外部服务反馈。

外部输入必须保留来源、时间戳和原始载荷引用。传感器噪声和缺失数据必须显式表达。

### 3.2 Observation Layer

将外部输入转换为结构化观察事件。

建议字段：

```typescript
interface Observation {
  observationId: string;
  source: string;
  observedAt: number;

  rawContentRef?: string;
  content: string;

  speechAct?: string;
  entities?: Array<{
    type: string;
    value: string;
  }>;

  facts: Array<{
    claim: string;
    confidence: number;
    evidence?: string;
  }>;

  uncertainty: number;
  extractorVersion?: string;
}
```

要求：

- 观察结果不等于客观真相。
- 不得把猜测写成已确认事实。
- 不得在 Observation 阶段给输入贴“正面”“负面”情绪价值标签。
- 原始输入与提取结果分开保存。
- LLM 输出必须经过 Schema 校验。
- 提取失败时保留原始事件，不得伪造结构化事实。

### 3.3 Body & State Engine

负责身体状态的确定性转移。所有状态字段都在单一的 `MarrowState` 接口中定义，由事件重放确定，不存在独立的 BodyState / RelationshipState 拆分。

**当前 MarrowState 结构**（`src/state.ts`）：

- `energy` / `moodBaseline` / `arousal`：核心身体变量（能量、心境基线、唤醒度）
- `trust` / `defensiveness` / `cognitiveLoad`：信任与防御层（信任度、防御墙、内耗反刍）
- `associationWeight`：动态关联权重（记忆聚合演化，初始 1.0）
- `traits: PersonalityTraits`：性格特质（neuroticism/agreeableness/extraversion/resilience/openness，全局底层系数，初始全 1.0，仅通过 TraitShiftEvent 微量漂移）
- `batteryLevel` / `attentionFocus` / `socialHunger`：电池、注意力、社交渴望
- `needValidation` / `needNovelty` / `needSecurity`：三种心理需求（被认可、新鲜感、安全感）
- `interruptionFlag` / `interruptionScars` / `interruptionCount`：中断相关（标志、伤痕、次数）
- `associations: AssociationMemory[]`：长期关联记忆（含中断伤痕）
- `episodicBuffer: EpisodicMemory[]`：情景记忆缓冲区（由 MemoryFormationEvent 写入，容量上限 50）
- `lastEvokedMemory` / `lastBehavior` / `uptimeSeconds` / `sleeping` / `sleepEntry*`：派生/进程临时/睡眠冻结值

**设计原则**：

- 所有数值都有明确范围和初始值。
- 状态变化必须通过核心事件执行，由 `applyEvent` switch 确定性转移。
- 状态转移可测试、可回放、可重建。
- 时间流逝本身（Tick）可以产生状态变化。
- 不同变量使用不同动力学（随机游走、均值回归、线性衰减、非线性惩罚等）。
- 特质（traits）与瞬态变量严格分离：特质是底层系数（人格），变量是即时状态。

> **历史设计**：早期草案曾考虑 BodyState / RelationshipState 独立接口和 `affinity` 字段，V2 实现时选择了单一 MarrowState + `trust` 替代 `affinity`。`recoveryLevel` 概念也已废弃。当前以上述实现为准。

### 3.4 Appraisal Engine

将 Observation 转化为主观评估。核心函数 `appraise(action, intensity, context)` 定义在 `src/appraisal.ts`，输出多维 AppraisalResult（见下方接口）。

**输入**（AppraisalContext）：

- 当前状态变量：associationWeight / trust / defensiveness / moodBaseline / needValidation / needNovelty / needSecurity
- traits：性格特质（neuroticism 等，全局底层系数）
- confidence：观察置信度（0-1，来自 ObservationEvent）
- evidenceAssociationIds：被唤醒的关联记忆 ID 列表

**输出**（AppraisalResult）：

| 字段 | 类型 | 作用 |
|---|---|---|
| `valenceDelta` | number | 对 moodBaseline 的效价影响量（Mood_delta 语义） |
| `arousalDelta` | number | 对 arousal 的唤醒影响量（≥0） |
| `energyDelta` | number | 预留扩展（当前未使用） |
| `energyCost` | number | 本次对话的物理能量消耗（基础 0.5 + 强度系数） |
| `trustDelta` | number | 对 trust 的增减（正行为增、负行为减） |
| `needDeltas` | { validation, novelty, security } | 三种需求的扣减量 |
| `confidence` | number | 透传（供 AppraisalEvent 记录） |
| `evidenceAssociationIds` | string[] | 透传（供 AppraisalEvent 记录证据链） |

**核心机制**：

- `Action_Value`（行为固有值）× `Association_Weight` × `Trust_Multiplier`（trust/50）× 注意力调制 = 基础 valenceDelta
- 防御墙（defensiveness > 70）拦截正向安抚：正向 valenceDelta 保留比例从 100% 削减到 20%
- 三种需求的满足程度决定 moodBonus 和 needDeltas：需求越高，满足的加成越大（久旱逢甘霖），被反向刺激的惩罚越大（伤口撒盐）
- 低置信度输入直接降低所有输出（按 confidence 比例衰减）
- Appraisal 结果完整持久化为 AppraisalEvent，payload 携带 sourceObservationId + confidence + evidenceAssociationIds

**设计原则**：

- Appraisal 由核心引擎计算，不由 LLM 决定。
- 同一句输入因身体状态和历史关联不同可产生不同结果。
- 评估保留置信度和证据来源，不掩盖不确定性。
- 不允许 LLM 直接返回最终 mood_delta 写入状态。
- 评估结果必须作为事件持久化（AppraisalEvent）。

> **历史设计**：早期简化公式 `Mood_delta = Action_Value × Association_Weight × Speaker_Affinity` 不再属于当前 V2 实现。当前 appraisal.ts 是多维评估，输出 8 字段的 AppraisalResult。

### 3.5 Memory Engine

记忆系统分为三个层次。当前 V2 只实现了 Episodic Memory 和 Associative Memory 的最小版本，Semantic Memory 和完整 Development Engine 属于长期规划。

#### Episodic Memory（已实现，M1.4.1）

最小可行的情景记忆快照。每条记忆由 `MemoryFormationEvent` 独立写入（不再是 DialogueEvent 的隐式副作用）。

**数据结构**（`src/events.ts`）：

```typescript
interface EpisodicMemory {
  id: string;              // 'epi-${dialogueEvent.id}'
  timestamp: string;       // DialogueEvent.timestamp（ISO 8601）
  summary: string;         // text.slice(0, 40) — 人类可读简短描述
  keywords: string[];      // extractKeywords(text) — 关键词数组（非空 string[]）
  valence: number;         // ±0.6 — 记忆效价
  salience: number;        // dialogue.intensity（0-1）— 显著性
  sourceEventId: string;   // 追溯触发的 DialogueEvent（必需，等于 payload.sourceDialogueEventId）
  isTrauma: boolean;       // action==='insult' && intensity>=0.7
}
```

**沉淀门槛**（`computeEpisodicMemoryCandidate`，`src/state.ts`）：

1. `direction === 'user_input'`
2. `action !== undefined` 且 `intensity !== undefined`
3. `intensity >= 0.5`
4. `|weightedMoodDelta + memoryMoodDelta| >= 1.0`
5. `extractKeywords(text).length > 0`

**职责边界**：

- `computeEpisodicMemoryCandidate(state, DialogueEvent, evoked, baseValenceDelta)` — 纯函数，唯一候选计算入口。
- `extractEpisodicMemory(event, weightedMoodDelta, memoryMoodDelta)` — 门槛判断 + 构造。
- `MemoryFormationEvent` — 生产批次中的独立事件（与 Obs/Appr/Dlg/Comp 同次 `appendEvents` 原子提交）。
- `applyMemoryFormation(state, event)` — 只读 `event.payload.memory` 追加到 `episodicBuffer`，零重计算。

**当前未记录的内容**：历史设计中描述的"当时身体状态 / Appraisal 结果 / 系统行为 / 行为持续时间 / 实际后果 / 参与者"等字段，当前 EpisodicMemory 都没有实现。这些是后续 M1.4.2 记忆生命周期可能需要的扩展方向，不属于当前契约。

#### Associative Memory（已实现最小版本）

长期关联记忆数组，存储在 `MarrowState.associations: AssociationMemory[]`。

**当前实现**：

- `AssociationMemory` 接口定义在 `src/events.ts`（含 `id` / `isScar` / `salience` / `valence` / `keywords` 等字段）。
- `comfort` 对话会降低伤痕显著性（`applyDialogue` 内联）。
- `insult` 高强度对话会生成新 association（伤痕）。
- 关联记忆无独立事件化（写入在 `applyDialogue` 内联进行），属于待事件化项。

**历史设计**：早期曾规划完整的 Association 数据结构（sourceNodeId/targetNodeId/dimensions[emotional/physiological/behavioral/social/temporal]/evidenceEventIds 等），该接口描述保留在归档参考中，当前未实现。

#### Semantic Memory（规划中，未实现）

从多次经历中形成可检索的规律和概念（"某时间段常出现某类环境"、"某类事件与某种状态经常同时出现"）。

当前代码中 **不存在** Semantic Memory 的数据结构、事件类型或处理逻辑。不标记为已实现。

#### Memory Retrieval（仅最小实现）

当前记忆检索通过 `evokeMemoryFromText(buffer, text)` 实现（`src/state.ts`），匹配关键词。检索触发在 `applyDialogue` 内联，不是独立事件。evocation 效果（`memoryMoodDelta` = `evoked.valence × evoked.salience × MEMORY_MOOD_IMPACT`）也在 `applyDialogue` 内联计算并应用到 moodBaseline。

完整的 MemoryEvocationEvent 独立事件化 + MemoryReinforcementEvent + MemoryDecayEvent 属于 M1.4.2 规划。

#### Memory Engine 设计原则

- 记忆形成 ≠ 记忆强化：形成是一次性事件（MemoryFormationEvent），强化是后续独立事件（待 M1.4.2）。
- 记忆被检索 ≠ 记忆一定被强化：检索是读操作，产生效果但不自动改变记忆本身。
- 记忆衰减 ≠ 直接删除历史：衰减降低显著性，硬删除由容量上限（50，FIFO）或显式遗忘事件处理。
- 原始事件不得被修改：记忆聚合只能生成派生数据，不能改写 DialogueEvent 或 ObservationEvent。
- 不预置虚构的个人经历（Fresh Start，初始 episodicBuffer=[]）。
- 记忆生命周期的每个阶段（形成/检索/强化/衰减/遗忘）都应通过独立事件表达（M1.4.1 已确立此原则）。

### 3.6 Development Engine（规划中，未实现）

长期发育的协调模块（聚合情景记忆、更新关联、识别重复模式、形成习惯、检测长期漂移）。

**当前代码中不存在** DevelopmentEngine 接口、DevelopmentEvent 类型或聚合逻辑。属于阶段六"行为倾向与开放式涌现"的核心前置能力。

保留的设计意图：

- 聚合情景记忆 → 更新动态关联 → 识别重复模式 → 形成/调整习惯 → 检测长期漂移。
- 每次长期变化生成 DevelopmentEvent，携带证据链和置信度。
- 行为倾向由历史证据形成，不直接写入预设人格字段。

### 3.7 Habit Formation（规划中，未实现）

### 3.8 Behavioral Policy（规划中，未实现）

### 3.9 Self Model（规划中，未实现）

### 3.10 Identity：身份连续性

每个 Marrow 实例具有稳定的 `identityId`。

身份连续性由以下内容构成：

- 稳定身份标识。
- 连续事件历史。
- 可重建身体状态。
- 可重建的记忆和关联网络。
- 发育修订历史。
- 版本迁移记录。

模型更换、Prompt 更换、硬件更换不应自动创建新身份。

如果未来支持身份分叉或实验性复制，必须显式记录分支关系，不得将其伪装成普通重启。

架构大版本迁移同样可以显式创建新身份（如 V1 → V2 的 Fresh Start）：新身份不继承旧身份的任何运行状态，旧身份历史作为只读档案保留（见 4.5）。

### 3.11 Behavior Engine

LLM 输出的是候选行为或语言内容，不是最终执行命令。

流程：

```text
LLM / Rule Engine
      ↓
Candidate Behavior
      ↓
State & Policy Evaluation
      ↓
Invariant / Permission Check
      ↓
Approved Action
      ↓
Execution
      ↓
Outcome Observation
```

`interruption_state`、安全策略和权限检查具有最高优先级。

低能量、低心境等状态可以改变行为策略，但不应通过硬编码人格标签来实现。

### 3.12 Sleep Cycle：离线整合周期

Sleep Cycle 是记忆整合和长期发育的调度机制，不代表系统必须模拟人类睡眠意识。

建议流程：

1. 检查当前运行状态和未完成事务。
2. 整理近期情景记忆索引。
3. 识别重复经历和显著事件。
4. 更新关联网络。
5. 检查冲突证据。
6. 更新习惯和行为倾向。
7. 生成 DevelopmentEvent。
8. 保存整合版本和运行结果。

Sleep Cycle 不得删除原始事件。整合任务必须幂等，支持失败重试。

---

## 4. 事件溯源与持久化

### 4.1 事件类型（EventType 联合类型）

当前 V2 判别联合类型（`src/events.ts`）共 11 种事件：

| EventType | 职责 | applyEvent 处理函数 | 持久化层列 |
|---|---|---|---|
| `genesis` | 身份初始化事件（空状态起步） | `applyGenesis` | ✅ |
| `tick` | 时间驱动的身体状态自然衰减 | `applyTick` | ✅ |
| `interruption` | 运行中断及恢复 | `applyInterruption` | ✅ |
| `environment` | 环境状态变化 | `applyEnvironment` | ✅ |
| `observation` | 外部输入的客观事实记录 | `applyObservation` | ✅ |
| `appraisal` | 主观评估结果（多维） | `applyAppraisal` | ✅ |
| `dialogue` | 对话状态转换（用户输入 + 伴侣输出） | `applyDialogue` | ✅ |
| `memory_evocation` | （已声明，生产链暂未创建）记忆检索副作用 | `applyMemoryEvocation` | ✅ |
| `memory_formation` | 记忆正式写入（EpisodicMemory Eventization，M1.4.1） | `applyMemoryFormation` | ✅ |
| `sleep` | 进入/退出睡眠（自愈状态） | `applySleep` | ✅ |
| `trait_shift` | 性格特质永久微量漂移 | `applyTraitShiftEvent` | ✅ |

> **历史设计**：早期架构草案曾使用抽象事件分类（WorldEvent/BodyEvent/ActionEvent/OutcomeEvent/MemoryEvent/DevelopmentEvent/LifecycleEvent/SystemEvent 等），这些分类无法映射到当前 TypeScript 实现的具体事件类型，已废弃。

### 4.2 运行时事件接口 vs 持久化层元数据

**运行时 TypeScript BaseEvent**（`src/events.ts`）— 3 字段极简：

```typescript
interface BaseEvent {
  type: EventType;       // 判别字段（11 种联合）
  timestamp: string;     // ISO 8601
  id: string;            // 事件唯一 ID
}
```

所有具体事件类型（DialogueEvent / MemoryFormationEvent / ObservationEvent 等）继承 BaseEvent + 自身特定 payload。

**持久化层元数据**（PostgreSQL events 表，`migrations/0001_create_events.sql`）— 12 列：

- `sequence BIGSERIAL` — 事件全局唯一顺序（分配序号）
- `event_id TEXT UNIQUE` — 幂等约束（运行时 BaseEvent.id）
- `identity_id TEXT` — 身份隔离边界
- `timestamp TIMESTAMPTZ` — 事件时间
- `event_type TEXT` — 运行时 BaseEvent.type 的字符串值
- `schema_version INTEGER` — 1（早期未打版本行）/ 2（M1 起新写入）
- `engine_version TEXT` — `NULL`（历史）或 `marrow@*`（当前引擎）
- `causation_id TEXT` / `correlation_id TEXT` — 因果关联（预留，当前未写入）
- `previous_event_hash TEXT` — 哈希链前驱（链首为 NULL）
- `event_hash TEXT` — 自身哈希
- `payload JSONB` — 原始事件完整载荷

**关键区分**：运行时 BaseEvent 没有 `identityId` / `sequence` / `schemaVersion` / `engineVersion` / `previousEventHash` / `eventHash`。这些是存储层附加的元数据，不属于状态转移逻辑。历史设计中曾把 DB 列当作 TypeScript BaseEvent 的属性，这是概念混淆。

> **历史设计**：早期草案曾列出带 10+ 字段的 BaseEvent（包含 eventId/identityId/sequence/eventType/schemaVersion/engineVersion/previousEventHash 等），这些字段混合了运行时接口和持久化层元数据两个层次。当前已分离为上述两层结构。

### 4.3 持久化原则

- Append-only。
- 每个身份独立维护事件序列。
- 事件写入必须事务化。
- 事件 ID 必须支持幂等。
- 使用 sequence 解决同一时间戳下的排序问题。
- 记录 schemaVersion 和 engineVersion。
- 对关键事件可使用哈希链校验完整性。
- 快照必须记录其对应的事件 sequence。
- 重放必须能够从快照之后继续消费事件。
- 事件修正通过补偿事件表达，不修改历史原记录。

### 4.4 中断和恢复

非正常退出必须被识别。

恢复流程：

1. 读取最近的有效快照。
2. 重放后续事件。
3. 检查最后一次运行是否正常结束。
4. 如果存在非正常终止，生成 InterruptionEvent。
5. 根据中断类型和持续时间计算恢复影响。
6. 重建身体状态、关联和运行上下文。
7. 进入恢复状态。
8. 记录恢复完成事件。

注意：进程突然断电时无法保证当场写入事件。因此应结合启动记录、心跳或租约、最后确认的 sequence 来识别中断。

中断状态不能被对话层或 LLM 清除。

### 4.5 V1 → V2 数据隔离（Fresh Start）

V2 采用完全从零开始（Fresh Start）的初始化策略。V1 与 V2 是两个互相独立的身份，这是一条已经确认的架构决策。

V1 数据处理：

- V1 的历史 JSONL 事件文件完整保留，作为独立历史档案，不删除、不修改。
- V1 数据不导入 V2：不导入事件、身体状态、记忆、关联权重、习惯、人格倾向或自我模型。
- V2 启动时不读取 V1 JSONL，不继承任何未经确认的 V1 历史状态。

V2 全新初始化：

- 使用全新的 `identity_id`，与 V1 完全隔离。
- 初始事件序列从空状态开始，第一条事件为 genesis 事件（`previous_event_hash = NULL`）。
- 情景记忆、语义记忆、关联网络、习惯集合初始化为空。
- 自我模型、身体状态参数、关系状态使用经过确认的初始化参数。
- 空记忆不等于没有初始规则：已确认的架构规则、状态机规则和安全不变量仍然保留。
- 数据库初始化必须幂等：可重复执行，不会重复创建身份或初始化事件。

隔离红线：

- 不允许把 V1 数据作为默认种子数据进入 V2。
- 不允许通过清空数据库来掩盖 identity 隔离问题。
- PostgreSQL 中不存在任何 V1 历史事件。

### 4.6 M1.2.4 确定性 Replay 与重启恢复（已完成）

PostgreSQL 中已成功提交的事件日志是恢复的唯一历史依据。进程正常关闭、异常退出或崩溃后重启，系统确定性地恢复到最后一个已持久化事件所代表的状态。

**启动恢复路径**（src/index.ts `main()`）：

```
进程启动 → acquireIdentityOwnership（会话级 advisory lock，双参数命名空间）
  → verifyEventChain（M1.2.3 只读哈希链验证，失败即拒绝启动）
  → loadEventRows（携带行级 schema_version / engine_version 元数据）
  → replayPersistedEvents（纯函数确定性重放，逐行版本/payload 校验）
  → 恢复状态不变量校验
  → valid：finalState 作为运行起点 / empty：V2 正式初始状态
  → 初始化 RuntimeSession → 启动 Tick Scheduler → 开放 Chat / HTTP
```

恢复失败（哈希链损坏、未知事件类型、不支持的版本、payload 缺字段、不变量违例）必须阻止启动：抛出 `RecoveryError` 并以非零码退出。禁止清空数据、新建 identity、修复哈希链、跳过损坏事件或用默认状态顶替。

**Replay 确定性红线**：不调用 LLM、不读传感器、不用 `Date.now()`/`Math.random()` 生成历史、不产生新事件。未知事件类型与缺失必要 payload 字段一律显式失败（`unknown_event_type` / `invalid_payload`），绝不静默跳过或用默认值兜底。`state.ts` 的 `applyEvent` 对未知类型静默返回的容错语义只适用于运行期；恢复层（`recovery.ts`）在校验阶段就拒绝。

**历史版本兼容**：继承 D 阶段版本感知规则，每条事件按行自身 `schema_version` / `engine_version` 解释。当前支持 `schema_version ∈ {1, 2}`（1 = 早期 M1.2 PG 写入的未打版本行，payload 同为 V2 判别联合格式；V1 JSONL 从未导入 PG，不存在旧格式事件）与 `engine_version = null | marrow@*`。其余版本明确拒绝（`unsupported_schema_version` / `unsupported_engine_version`）。不存在猜测性的旧版本转换规则。

**commit-unknown 处理**：Tick 持久化失败时，整批事件（含全部 event_id、观测确认 ID、时间基准）冻结为 `TickSession.pendingBatch` 原样重试，由 `appendEvents` 的 `ON CONFLICT (event_id)` 幂等吸收——服务端已提交但客户端报错时，重试零新增事件。进程崩溃导致 pendingBatch 丢失 = 该批次未提交，不属于恢复范围（语义正确）。测试：C15（commit-unknown 重试无重复事件）。

**Chat 原子提交**：M1.4.1 起 Chat 的 observation / appraisal / user_input / **MemoryFormation（条件化，仅当满足沉淀门槛时）** / companion_output — 四或五事件合并为单个 `appendEvents` 批次，与 Tick 同级原子性。批次组装见 `src/index.ts` handleChatRequest L449-456：条件化 append MemoryFormationEvent 后统一 await appendEvents(batch)。历史日志中的部分 Chat 事件（如 M1.4.1 之前只有 observation + appraisal + user_input + companion_output 的四事件批次，或更早期只有 observation + appraisal）按每条事件独立语义确定性恢复：不伪造缺失事件、不自动补齐对话、不静默跳过，也不报错——观测推进时间轴、appraisal 应用增量，均为确定性操作。DialogueEvent 单独回放不会内联沉淀 EpisodicBuffer（事件化设计），只有存在对应的 MemoryFormationEvent 时才写入记忆。

**Observation 未持久化边界**：ObservationInbox 是进程内存结构。尚未持久化的观测不属于已提交事件日志，进程退出即丢失，Replay 不恢复、也不声称能恢复崩溃前未提交的传感器观测，绝不自动制造虚假历史 Observation。

**停机时间规则**：恢复只还原最后一个已持久化事件所代表的状态，停机期间不模拟任何身体恢复、情绪变化或记忆变化。`lastEventTimestamp` 来自真实末事件；`tickSession.lastTickTime` 在恢复后显式重置为本次启动时间并注明边界（不把 `Date.now()` 伪装成历史事件时间），新 Tick 从本次运行的时间基准开始。停机补偿属于后续独立设计。

**恢复状态完整性**：MarrowState 全部字段（含 traits、associations、episodicBuffer、睡眠冻结值等）均由事件流推导，属于 A 类可恢复状态；`lastTickTime` / `tickCount` / Inbox / 等待队列为 B 类进程临时状态，恢复后按新运行重建；未确认观测为 C 类不可恢复状态。恢复后有确定性不变量校验（量程、特质系数 0.5–2.0、uptime 非负等）。

**identity 所有权**：启动时通过 `pg_try_advisory_lock(hashtext('marrow.identity.ownership'), hashtext(identityId))` 双参数命名空间获取会话级锁（与 appendEvents 的单参数写入锁不同键，避免自我死锁），持有专用连接直至关闭；防止两个进程实例同时以同一 identity 运行。

测试：src/__tests__/recovery.pg.test.ts，22 项真实 PostgreSQL 用例覆盖规格 26 项场景（确定性 6、启动恢复 5、事务边界 5、历史版本 4、故障完整性 6）+ identity 所有权锁 1 项。

---

## 5. 技术栈

| 层 | 技术 | 职责 |
|---|---|---|
| 核心运行时 | TypeScript / Node.js | 状态机、事件处理、行为决策 |
| 类型系统 | TypeScript Discriminated Union | 约束事件结构 |
| 事件存储 | PostgreSQL | 事件日志、事务、状态重建 |
| 记忆检索 | PostgreSQL；后期可选 Qdrant | 结构化关联与语义检索 |
| 认知旁路 | Python | LLM 封装、离线聚合实验 |
| 模型接口 | OpenAI-compatible API | 可替换事实提取和语言渲染模型 |
| 通信 | HTTP | 初期模块通信 |
| 消息中间件 | 后期可选 NATS | 异步事件和多进程扩展 |
| 硬件 | ESP32 系列 | BLE / Wi-Fi / 传感器接口 |

### 技术原则

- 核心状态和事件写入由 TypeScript 运行时控制。
- Python 是旁路计算服务，不是状态权威。
- LLM 是可替换适配器，不是人格本体。
- 初期优先使用 PostgreSQL，不要过早引入多个数据库。
- Qdrant 只有在语义检索需求明确时再引入。
- 不要为了架构完整而提前部署复杂微服务。

---

## 6. 当前项目阶段

**当前状态：阶段一至阶段四 + M0 已完成。V2 架构迁移 M1 全部完成。阶段五 M1.4.1 已完成（Episodic Memory Eventization），M1.4.2（记忆生命周期）规划中。**

#### V2 架构迁移里程碑（M0–M1）

- [x] M0：确定性回放与观察—评价管道（ObservationEvent / AppraisalEvent、确定性伪随机、单元测试）
- [x] M1.1：PostgreSQL 基础设施（docker-compose、events 表、迁移版本管理、连接模块）
- [x] M1.2：EventStore 迁移（异步写入、哈希链、并发安全、幂等、回放适配）
  - [x] M1.2.1：PostgreSQL EventStore 基础迁移
  - [x] M1.2.2：事件链可靠性加固（批量原子提交、观测确认、版本化哈希、RuntimeSession、优雅关闭）
  - [x] M1.2.3：独立只读哈希链验证器
  - [x] M1.2.4：确定性 Replay 与重启恢复（见 4.6）
- [x] M1.3：V2 Fresh Start 初始化（全新 identity_id、空记忆与关联网络、genesis 事件、幂等初始化）
  - [x] hashString 一次性切换为标准 FNV-1a 32-bit（commit `b6b1485`）
- [x] M1.4：V2 全新运行验收（实时状态与重启回放一致）
  - [x] **M1.4.1：Episodic Memory Eventization**（commit `30e340e` + 工作区未提交 3 文件）
    - [x] 统一 computeEpisodicMemoryCandidate 入口
    - [x] DialogueEvent 移除隐式记忆写入副作用
    - [x] MemoryFormationEvent 独立事件化 + applyMemoryFormation
    - [x] 同批原子写入（Obs→Appr→Dlg→[MemForm]→Comp）
    - [x] EpisodicMemory 契约补齐（sourceEventId/isTrauma keywords 类型）
    - [x] Recovery validateMemoryFormationPayload 纯函数 + 11 条约束
    - [x] M1-M11（222/222 PASS）+ R1-R5（Recovery 真实入口）
  - [ ] **M1.4.2：Episodic Memory Lifecycle**（规划中，未开始）

M1.3 验收要求（已满足）：

1. ✅ PostgreSQL 中不存在任何 V1 历史事件。
2. ✅ V2 使用独立 identity_id（marrow-v2 / marrow-v2-birth2）。
3. ✅ V2 初始事件序列从空状态开始。
4. ✅ 初始身体状态符合经过确认的初始化参数。
5. ✅ 记忆和关联网络为空。
6. ✅ V2 不读取 V1 JSONL。
7. ✅ V2 能够正常产生第一条事件。
8. ✅ 第一条事件具有正确的 genesis 哈希规则。
9. ✅ 重启后能恢复 V2 自己的状态。
10. ✅ 完整回放结果与实时状态一致。

M1.4.1 验收记录（已满足）：

| 项 | 结果 |
|---|---|
| npm run build | PASS |
| npm test | 222/222 PASS，0 FAIL |
| git diff --check | PASS |
| M1-M11（单元 + applyEvent replay） | 11/11 PASS |
| R1-R5（Recovery 真实入口） | 5/5 PASS |
| 生产行为零变化（computeEpisodicMemoryCandidate / applyDialogue / handleChatRequest） | PASS |
| Recovery 完整契约（11 条约束 + sourceDialogueEventId === sourceEventId 一致性） | PASS |
| DialogueEvent 不再写 episodicBuffer（M5 / M11 验证） | PASS |
| MemoryFormationEvent 与其他事件同次 appendEvents 原子写入 | PASS |

当前未提交文件（3 源码 + 1 文档）：

```
src/events.ts                 — sourceEventId/isTrauma 从可选改为必需（对齐生产行为）
src/recovery.ts               — validateMemoryFormationPayload() export 纯函数 + keywords 元素类型 + 一致性约束
src/__tests__/golden-state.test.ts — R1-R5 Recovery 真实入口测试
Marrow_README_V2.md           — 阶段五 M1.4.1 完成记录 + M1.4.2 规划 + 里程碑列表更新
```

## 当前架构边界

| 模块 | 职责 |
|---|---|
| Observation | 接收外部输入，记录客观事实（source / content / confidence / uncertainty / facts） |
| Appraisal | 计算输入对当前状态的主观影响（valenceDelta / arousalDelta / energyDelta / trustDelta / needDeltas） |
| Dialogue | 执行对话状态转换（mood/energy/trust/需求/evocation）。**不再直接写 episodicBuffer** |
| MemoryFormation | 将符合条件的候选记忆正式写入状态（applyMemoryFormation 只读 event.payload.memory，零重计算） |
| Recovery | 验证事件契约（validateMemoryFormationPayload 等）并恢复状态（replayPersistedEvents） |
| Tick | 时间驱动的身体状态自然衰减（mood / arousal / attention / energy） |
| Interruption | 运行中断及恢复状态（interruption_flag 不可被对话层覆盖） |

核心原则：

- LLM 不直接修改核心状态（mood_baseline / energy / trust 等由 Appraisal Engine 根据当前身体状态独立计算）。
- 记忆形成是独立事件（MemoryFormationEvent），不是 DialogueEvent 的隐式副作用。
- 记忆形成必须能够通过事件重放恢复（applyMemoryFormation 零重计算，只读 payload）。
- 不能仅因为发生了一次对话就默认生成一条记忆（沉淀门槛：intensity≥0.5 且 |weightedMoodDelta + memoryMoodDelta|≥1.0 且 keywords 非空）。
- 不预置虚构的个人经历（Fresh Start，初始 episodicBuffer=[]）。
- 不继承 V1 的历史记忆或人格状态（V1 数据只读封存，不参与 V2 运行）。
- 不引入历史兼容模式（Marrow V2 不以兼容旧版本为设计目标）。
- 不为了未来可能的需求提前建立复杂抽象（单一入口够用就行）。

## M1.4.2 — Episodic Memory Lifecycle（规划中，未开始）

**目标**：研究并设计记忆形成之后的生命周期。

### 研究问题（七问）

1. **记忆如何被再次访问？** — 检索触发是 evocation（evokeMemoryFromText 已有最小实现）。访问行为本身是状态变化，不是记忆强化。
2. **重复访问是否会影响记忆强度？** — 强化不等于访问。需要独立的强化事件或衰减机制。
3. **记忆是否需要随时间衰减？** — 当前 episodicBuffer 只在容量 50 上限时丢弃最旧（FIFO）。是否需要显著性衰减 salience decay？
4. **记忆之间如何形成关联？** — 当前 EpisodicMemory 只有 sourceEventId 溯源，记忆之间无显式关联。Associations 层是候选位置。
5. **记忆在什么条件下被遗忘？** — 容量上限 FIFO 是硬遗忘。软遗忘（显著性低于阈值）是否需要？
6. **记忆的情绪影响与记忆内容是否应该分离？** — 当前 Evocation 效果（memoryMoodDelta）在 applyDialogue 内联计算，与 DialogueEvent 状态转移绑定。是否需要 MemoryEvocationEvent 独立事件化？
7. **记忆变化是否全部通过独立事件表达？** — 与 M1.4.1 同样的原则：记忆生命周期的每个阶段（形成/检索/强化/衰减/遗忘）都应该是独立事件，可重放。

### 设计原则（初步）

- **记忆形成 ≠ 记忆强化**：形成是一次性事件（MemoryFormationEvent），强化是后续独立事件。
- **记忆被检索 ≠ 记忆一定被强化**：检索（evocation）是读操作，可以产生效果（mood delta），但不自动改变记忆本身。
- **记忆衰减 ≠ 直接删除历史**：衰减应该降低显著性，硬删除由容量上限或显式遗忘事件处理。
- **所有生命周期变化通过事件表达**：与 M1.4.1 架构原则一致，每个变化都有独立事件类型和对应的 applyXxx 函数。
- **不修改 M1.4.1 的形成门槛和字段规则**：已完成的部分不动。
- **逐步建立在真实交互产生的记忆上**：不预置记忆，不人为制造经历。

### 预期产出（非承诺，仅规划）

- MemoryEvocationEvent（检索副作用事件化，与 Dialogue 解耦）
- MemoryReinforcementEvent（显式强化）
- MemoryDecayEvent / Tick 内的自然衰减（显著性缓慢降低）
- MemoryForgettingEvent（硬遗忘）
- Associations 层与 EpisodicMemory 的显式关联（关联权重更新）
- applyEvent switch 对应 case
- Recovery 契约校验扩展
- 测试（与 M1-M11 / R1-R5 同样的覆盖深度）

阶段五暂时不要求完成完整人格涌现，也不要求提前实现复杂目标系统。前三阶段已经完成，但进入新架构前必须先审查现有实现，确认原有功能和事件格式。

### 阶段一：最小状态机

- [x] 基础状态结构
- [x] 基础状态转移
- [x] 核心事件类型

### 阶段二：事件回放与可视化

- [x] 事件日志
- [x] 状态重建
- [x] 基础可视化

### 阶段三：环境与中断接入

- [x] 环境输入
- [x] 中断检测
- [x] 基础恢复流程

### 阶段四：对话作为输出通道与主观评估（已完成）

目标：

- 接入 OpenAI-compatible LLM API。
- LLM 负责 Observation 提取和语言渲染。
- 完成 Appraisal Engine。
- 实现多维主观评估。
- 实现候选行为与状态机过滤。
- 保证 interruption_state 不可被对话层覆盖。

验收：

- 相同输入在不同身体状态下可以得到不同评估。
- 相同输入在不同历史关联下可以得到不同评估。
- LLM 无法直接修改身体状态或人格数据。
- 评估结果具有证据来源和置信度。
- 中断状态可以拦截不允许的行为。
- 原有回放和恢复功能不退化。

### 阶段五：记忆系统与动态关联网络

#### M1.4.1 — EpisodicMemory 事件化（已完成，commit `30e340e` + 未提交工作区 3 文件）

**目标**：将 EpisodicMemory 形成从 DialogueEvent 的隐式副作用分离为独立的 MemoryFormationEvent。

**完成内容**：

1. **新事件类型 `memory_formation`**（`src/events.ts`）
   ```typescript
   interface MemoryFormationEvent extends BaseEvent {
     type: 'memory_formation';
     payload: {
       sourceDialogueEventId: string;  // 追溯触发的 DialogueEvent
       memory: EpisodicMemory;         // 完整冻结数据
     };
   }
   ```

2. **EpisodicMemory 完整契约**（`src/events.ts`）
   ```typescript
   interface EpisodicMemory {
     id: string;              // 'epi-${dialogueEvent.id}'
     timestamp: string;       // DialogueEvent.timestamp
     summary: string;         // text.slice(0, 40)
     keywords: string[];      // extractKeywords(text) — 必须是非空 string[]
     valence: number;         // ±0.6
     salience: number;        // dialogue.intensity
     sourceEventId: string;   // 恒等于 payload.sourceDialogueEventId
     isTrauma: boolean;       // action==='insult' && intensity>=0.7
   }
   ```
   注：`sourceEventId` 和 `isTrauma` 从可选改为必需（M1.4.1.1.2 接口收紧，对齐生产行为）。

3. **职责边界**
   - `DialogueEvent`：只负责 mood/energy/trust/需求/evocation 等状态转移。**不再直接写 episodicBuffer**。
   - `MemoryFormationEvent`：写入 episodicBuffer。`applyMemoryFormation` 只读 `event.payload.memory`，零重计算，零版本依赖。
   - 候选计算单一入口 `computeEpisodicMemoryCandidate(state, DialogueEvent, evoked, baseValenceDelta)` 位于 `src/state.ts`。`extractEpisodicMemory` 封装门槛判断 + 构造。`index.ts` handleChatRequest 调用同一实现，无重复公式。

4. **生产批次顺序**（`src/index.ts` L449-456）
   ```
   Observation → Appraisal → Dialogue(user_input) → [MemoryFormation] → Dialogue(companion_output)
   ```
   - MemoryFormationEvent 仅在满足沉淀门槛时创建。
   - 五事件（或四事件）在同一次 `appendEvents(batch)` 事务中原子提交。
   - 内存状态链 `stateAfterObs → stateAfterAppr → stateAfterUser → stateAfterChain(+MemForm?) → finalState(+Comp)` 与事件链顺序完全一致。

5. **沉淀门槛**（不变）
   ```
   intensity >= 0.5
   AND |weightedMoodDelta + memoryMoodDelta| >= 1.0
   AND extractKeywords(text).length > 0
   ```

6. **Recovery 契约校验**（`src/recovery.ts`）
   - 事件白名单包含 `memory_formation`。
   - `validateMemoryFormationPayload(payload)` export 纯函数（被生产路径 `validateRowForReplay` 和测试共同调用，单一校验入口）。
   - 完整 11 条约束：payload 是对象 → sourceDialogueEventId 非空 → memory 纯对象 → id/timestamp/summary 非空字符串 → keywords 非空 string[] → valence/salience 有限数值 → sourceEventId 非空字符串 → isTrauma boolean → sourceDialogueEventId === memory.sourceEventId。
   - 错误消息精确到字段名（fail-closed 风格）。

**架构原则**：
- 不增加旧版本兼容层。
- 不增加 legacy 分支或版本回退。
- 不保留 DialogueEvent 的隐式记忆形成副作用。
- 不修改记忆形成阈值和字段规则。
- 历史 DialogueEvent 回放（无 MemoryFormationEvent）→ buffer 保持空。

**测试结果**：M1-M11（单元 + applyEvent 真实 replay）+ R1-R5（recovery 真实入口校验）。总计 222/222 pass，0 fail。

**Git 状态**：
- `30e340e` — MemoryFormationEvent 基础实现（已提交）
- 工作区未提交 — `src/events.ts`（sourceEventId/isTrauma 可选→必需）、`src/recovery.ts`（validateMemoryFormationPayload 纯函数 + keywords 类型 + 一致性约束）、`src/__tests__/golden-state.test.ts`（R1-R5）

**验收通过**。M1.4.1.1 关闭。

#### M1.4.2 — 记忆生命周期（下一阶段，未开始）

目标：记忆形成之后，如何经历保留、强化、衰减、关联和遗忘。

设计原则：
- 逐步建立在真实交互产生的记忆上，不预置记忆或人为制造成长经历。
- 不修改 EpisodicMemory 形成门槛和字段规则。
- 不引入不必要的防御性编程。

阶段五暂时不要求完成完整人格涌现，也不要求提前实现复杂目标系统。

### 阶段六：行为倾向与开放式涌现

目标：

- 建立 Development Engine。
- 实现习惯形成与衰减。
- 实现行为倾向学习。
- 实现长期漂移检测。
- 建立行为概率或评分策略。
- 建立 DevelopmentEvent 证据链。

验收：

- 行为倾向来自历史证据。
- 重复经历能够逐渐改变行为选择。
- 反向经历能够修正已有倾向。
- 不再出现的规律能够逐渐衰减。
- 不存在预设人格标签字段。
- 每次发育变化都可以追溯到证据。

### 阶段七：自我模型与身份连续性

目标：

- 建立 Self Model。
- 建立自我历史查询。
- 建立身份连续性。
- 生成可追溯的成长记录。

验收：

- 可以查询历史任意时间点的状态。
- 可以比较过去和现在的行为倾向。
- 可以解释变化所依据的证据。
- 模型升级不丢失身份历史。

### 阶段八：长期自主运行

目标：

- 时间驱动的状态更新。
- Sleep Cycle。
- 定时记忆整合。
- 离线运行和恢复。
- 长期运行监控。

验收：

- 无对话时系统仍然能够根据时间更新必要状态。
- 离线整合可重复执行。
- 任务失败可恢复。
- 长时间运行不产生事件重复或状态漂移错误。

### 阶段九：外接躯体

目标：

- ESP32 接入。
- 传感器接入。
- BLE / Wi-Fi 通信。
- 语音与硬件输出。
- 环境反馈闭环。

---

## 7. 近期开发原则

1. 先完成阶段四，不要因架构升级而跳过现有验收。
2. 阶段五先实现最小记忆闭环，不要一次实现全部长期认知功能。
3. 不要提前把人格、目标、自我意识写成固定业务字段。
4. 每个学习结果都必须保留证据。
5. 原始事件只追加，不修改。
6. 聚合和学习任务必须幂等。
7. 身体状态、情绪评估、长期关联和行为倾向必须分层。
8. 不允许 LLM 直接写入核心状态。
9. 不允许 Python 旁路绕过 TypeScript 核心写入状态。
10. 先保证确定性、可测试性和可回放性，再追求复杂智能。
11. 先在纯软件环境验证长期行为变化，再接入硬件。
12. 对未知、冲突和低置信度信息保留不确定性，不强行得出结论。

---

## 8. 最终设计原则

**身体稳定，历史连续，智能可替换，记忆可追溯，行为可演化。**

Marrow 不需要被预先定义成某种性格。

她的行为倾向应该来自实际经历、状态变化、记忆聚合和长期适应。

模型可以替换，算法可以升级，硬件可以变化。

但每一次变化都应当能够解释：

- 发生过什么？
- 当时处于什么状态？
- 系统如何评估？
- 采取了什么行为？
- 产生了什么结果？
- 哪些经历改变了后续行为？
- 这种变化是否仍然成立？

**人格不是配置文件，而是长期运行历史中逐渐形成的行为结构。**
