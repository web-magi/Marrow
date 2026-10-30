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

负责身体状态的确定性转移。

```typescript
interface BodyState {
  energy: number;
  mood: number;
  moodBaseline: number;
  arousal: number;
  recoveryLevel: number;

  updatedAt: number;
  revision: number;
}
```

关系状态应独立建模，避免把关系亲密度混入单一情绪值：

```typescript
interface RelationshipState {
  subjectId: string;
  affinity: number;
  confidence: number;
  updatedAt: number;
}
```

要求：

- 所有数值都有范围和默认值。
- 状态变化必须通过核心命令执行。
- 状态转移必须可测试、可回放。
- 时间流逝本身可以产生状态变化。
- 不同变量使用不同变化速度。
- 状态不能因为 LLM 回复内容而被直接覆盖。

初期可使用简单、稳定、可解释的动力学模型，后续再根据实验调整。

### 3.4 Appraisal Engine

将 Observation 转化为主观评估。

初始公式可以保留：

```text
Mood_delta =
  Action_Value
  × Association_Weight
  × Speaker_Affinity
```

但该公式只作为第一版简化模型，不应成为唯一评估通道。

建议逐步扩展为多维评估：

```typescript
interface AppraisalResult {
  valenceDelta: number;
  arousalDelta: number;
  energyDelta: number;

  familiarity: number;
  novelty: number;
  socialImpact: number;

  confidence: number;
  evidenceAssociationIds: string[];
  sourceObservationId: string;
}
```

要求：

- Appraisal 由核心引擎计算。
- 同一句输入可以因身体状态和历史关联不同而产生不同结果。
- 评估必须保留置信度和证据来源。
- 不允许 LLM 直接返回最终 `mood_delta` 并写入状态。
- 低置信度输入应降低影响或进入待确认流程。
- 评估结果必须作为事件持久化。

### 3.5 Memory Engine

记忆系统分为三个主要层次。

#### Episodic Memory：情景记忆

记录具体发生过的经历：

- 时间和环境。
- 参与者。
- 输入与观察。
- 当时身体状态。
- Appraisal 结果。
- 系统采取的行为。
- 行为持续时间。
- 实际后果。
- 关联事件 ID。

情景记忆是对原始事件的索引和组织，不是原始事件的替代品。

#### Semantic Memory：语义记忆

从多次经历中形成可检索的规律和概念，例如：

- 某个时间段经常出现某类环境。
- 某类事件与某种状态经常同时出现。
- 某个对象在不同时间段表现出不同交互模式。

语义记忆必须保留来源证据、置信度和更新时间。

#### Associative Memory：动态关联记忆

建立环境、身体状态、语言事件、对象、行为与结果之间的关联。

```typescript
interface Association {
  id: string;

  sourceNodeId: string;
  targetNodeId: string;

  dimensions: {
    emotional: number;
    physiological: number;
    behavioral: number;
    social: number;
    temporal: number;
  };

  confidence: number;
  occurrenceCount: number;

  firstObservedAt: number;
  lastActivatedAt: number;
  createdAt: number;
  updatedAt: number;

  evidenceEventIds: string[];
  algorithmVersion: string;
}
```

要求：

- 关联权重不是人格标签。
- 允许正负关联并存。
- 允许关联衰减、修正和反转。
- 不允许单次事件直接固化长期倾向。
- 关联必须有证据来源。
- 不同维度分别学习，避免把复杂经历压缩成单一正负值。

#### Experience Outcome：经历结果

系统必须记录行为造成的后果，而不仅仅记录外部刺激。

```typescript
interface ExperienceOutcome {
  eventId: string;

  beforeState: BodyState;
  afterState: BodyState;

  stateDifference: Partial<BodyState>;

  actionDurationMs?: number;
  attributionConfidence: number;
  relatedEventIds: string[];
}
```

系统只能根据可观察到的结果更新关联，不能把时间相关性直接认定为因果关系。

### 3.6 Development Engine

Development Engine 是长期发育的协调模块。

职责：

- 聚合情景记忆。
- 更新动态关联。
- 识别重复模式。
- 形成和调整习惯。
- 更新行为倾向。
- 检测长期漂移。
- 记录发育前后的差异。
- 为每次发育变化保留证据链。

建议接口：

```typescript
interface DevelopmentEngine {
  aggregateEpisodes(): Promise<void>;
  updateAssociations(): Promise<void>;
  detectHabitPatterns(): Promise<void>;
  updateBehavioralTendencies(): Promise<void>;
  detectLongTermDrift(): Promise<void>;
  generateDevelopmentEvent(): Promise<void>;
}
```

行为倾向必须由历史证据形成，不允许直接写入“温柔”“敏感”等预设人格字段。

每次长期变化都应生成 DevelopmentEvent，至少包含：

- 变化对象。
- 变化前数值。
- 变化后数值。
- 使用的算法版本。
- 证据事件 ID。
- 置信度。
- 聚合时间范围。
- 变化原因说明。

### 3.7 Habit Formation：习惯形成

习惯是情景、时间、状态和行为之间反复出现的规律。

例如：

多次在深夜、低环境噪声和较低身体负荷下进行舒适交流，可能逐渐形成该时间段更容易发起交流的行为倾向。

要求：

- 不预设具体习惯。
- 习惯需要多次证据。
- 习惯强度可以增强或衰减。
- 习惯不能直接覆盖当前身体状态。
- 习惯必须保留形成证据和最近验证时间。

### 3.8 Behavioral Policy：行为倾向

人格以长期行为分布的形式表现，而不是固定标签。

行为选择应综合：

- 当前身体状态。
- 当前情景。
- 历史关联。
- 已形成的习惯。
- 当前目标（如果存在）。
- 行为成本。
- 置信度和不确定性。

候选行为示例：

- 继续交流。
- 主动发起交流。
- 安静等待。
- 请求澄清。
- 延迟响应。
- 结束当前交互。
- 进入恢复状态。

候选行为只是通用动作空间，不是人格定义。

行为策略必须允许探索、修正和不确定性，避免过早锁定单一行为模式。

### 3.9 Self Model：自我模型

Self Model 用于形成可查询的当前自我视图。

```typescript
interface SelfModel {
  identityId: string;

  currentBodyState: BodyState;

  behavioralTendencies: Array<{
    key: string;
    value: number;
    confidence: number;
    evidenceEventIds: string[];
  }>;

  habits: Array<{
    id: string;
    strength: number;
    confidence: number;
    evidenceEventIds: string[];
  }>;

  activeGoals: unknown[];
  knownUncertainties: unknown[];

  developmentRevision: number;
  generatedAt: number;
}
```

Self Model 是从事件、记忆和发育结果中生成的派生视图，不是可以任意编辑的事实数据库。

它应支持：

- 查询当前状态。
- 查询过去某个时间点的状态。
- 查询行为倾向的变化。
- 查询变化的证据来源。
- 查询尚未确认的规律。
- 生成基于历史证据的自我描述。

系统不能通过 LLM 编造自我经历。所有自我描述都必须能回溯到实际事件。

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

### 4.1 事件分类

初期统一使用以下事件类别：

| 类别 | 示例 |
|---|---|
| WorldEvent | 时间变化、环境变化、传感器输入 |
| ObservationEvent | 事实提取、输入识别 |
| BodyEvent | 能量、心境、唤醒变化 |
| AppraisalEvent | 主观评估结果 |
| ActionEvent | 主动交流、等待、休息 |
| OutcomeEvent | 行为后果和状态差异 |
| MemoryEvent | 情景记忆、关联更新 |
| DevelopmentEvent | 习惯和行为倾向变化 |
| LifecycleEvent | 启动、关闭、中断、恢复 |
| SystemEvent | 配置、版本和迁移记录 |

### 4.2 统一事件基础结构

```typescript
interface BaseEvent {
  eventId: string;
  identityId: string;

  sequence: number;
  timestamp: number;

  eventType: string;
  schemaVersion: number;

  causationId?: string;
  correlationId?: string;

  engineVersion: string;
  payload: unknown;

  previousEventHash?: string;
}
```

实际项目应使用判别联合类型定义具体事件，不应长期使用无约束的 `unknown` 作为业务事件载荷。

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

**当前状态：阶段四进行中，准备进入阶段五。**

前三阶段已经完成，但进入新架构前必须先审查现有实现，确认原有功能和事件格式。

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

### 阶段四：对话作为输出通道与主观评估（当前进行中）

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

### 阶段五：记忆系统与动态关联网络（下一阶段）

目标：

- 建立 Episodic Memory。
- 建立 Semantic Memory 的最小版本。
- 建立 Associative Memory。
- 建立 Experience Outcome。
- 建立关联权重和置信度。
- 建立证据来源追踪。
- 实现记忆检索和时间衰减。
- 实现基础记忆整合任务。

验收：

- 一次交互可以形成完整情景记录。
- 情景记忆能关联原始事件。
- 相同事件可以在不同上下文形成不同关联。
- 正负关联可以并存。
- 单次事件不会直接固化长期行为倾向。
- 关联更新可重复执行且不会重复计数。
- 原始事件不会被聚合过程修改。
- 重启后记忆和关联能够恢复。

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
