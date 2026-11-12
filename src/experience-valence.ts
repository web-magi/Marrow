/**
 * experience-valence.ts — M1.5.4.1 用户经历体验性质（纯函数模块）
 *
 * 语义边界（必须严格遵守）：
 * - experienceValence 描述【用户所描述经历本身】的情绪极性；
 * - 它不是 Marrow 的情绪，不是对 Marrow 回应的满意度，不是 Trait 更新方向；
 * - 数值域沿用 llm.ts 既有定义：[-1, 1]（-1 强烈负面 / 0 中性或混合 / +1 强烈正面）。
 *
 * 为什么需要状态字段：
 * 单一数值无法区分"真实中性"（0）、"正负混合"（接近 0）、"无法判断"（信息不足）
 * 与"提取失败"（解析失败）。历史实现把四者都写成 0，导致证据不可解释。
 *
 * 本模块只做两件事，生产 Recovery 与测试共用同一套规则：
 * 1. normalizeExperienceValence：把模型原始输出归一化为合法组合（提取阶段）
 * 2. validateExperienceValenceFields：校验冻结进事件的字段组合（Recovery 阶段）
 */

/** 体验性质状态（五态） */
export type ExperienceValenceStatus =
  /** 成功提取且存在明确单一极性，数值必须非 0 */
  | 'observed'
  /** 成功判断为中性经历，数值必须为 0 */
  | 'neutral'
  /** 同时存在明显正负成分，数值可表达综合方向（允许 0） */
  | 'mixed'
  /** 提取成功但无法判断体验性质，不得携带数值 */
  | 'unknown'
  /** 结构化提取过程失败，不得携带数值 */
  | 'extraction_failed';

/** 合法状态集合（单一来源：Validator 与测试共用） */
const VALID_STATUSES: ReadonlySet<string> = new Set<ExperienceValenceStatus>([
  'observed',
  'neutral',
  'mixed',
  'unknown',
  'extraction_failed',
]);

/** 数值下界（沿用既有 clampSigned 定义） */
export const EXPERIENCE_VALENCE_MIN = -1;
/** 数值上界（沿用既有 clampSigned 定义） */
export const EXPERIENCE_VALENCE_MAX = 1;

/** 状态值校验（类型守卫） */
export function isValidExperienceValenceStatus(
  value: unknown,
): value is ExperienceValenceStatus {
  return typeof value === 'string' && VALID_STATUSES.has(value);
}

/** 归一化结果：status 必有；value 仅在 observed/neutral/mixed 时存在 */
export interface ExperienceValenceObservation {
  status: ExperienceValenceStatus;
  value?: number;
}

/**
 * 把模型原始输出归一化为"status + 可选数值"的合法组合。
 *
 * 规则（任何不一致都降级为 unknown，绝不猜测）：
 * - 提取失败 → extraction_failed（不携带数值）
 * - observed：数值必须是 [-1,1] 内有限数且非 0，否则 unknown
 * - neutral：数值必须为 0；模型省略数值时按 0 规范化（状态本身已明确断言中性）
 * - mixed：数值必须存在且在 [-1,1] 内（允许 0），否则 unknown
 * - unknown / extraction_failed：丢弃数值
 * - status 缺失或非法：按数值派生——非 0 合法数值 → observed；其余 → unknown
 *   （兼容 extractor-1.3 等未输出状态字段的模型；不伪造混合/中性判断）
 *
 * 注意：越界数值在这里被丢弃（不 clamp），因为把 1.5 记成 1.0 会伪造精确性。
 * 非有限数值在 parseExtraction 阶段已按 invalid_schema 拒绝，走不到这里。
 */
export function normalizeExperienceValence(input: {
  rawValue: unknown;
  rawStatus: unknown;
  extractionSucceeded: boolean;
}): ExperienceValenceObservation {
  if (!input.extractionSucceeded) {
    return { status: 'extraction_failed' };
  }

  const rawValue = input.rawValue;
  const hasRawValue = rawValue !== undefined && rawValue !== null;
  const value =
    typeof rawValue === 'number' &&
    Number.isFinite(rawValue) &&
    rawValue >= EXPERIENCE_VALENCE_MIN &&
    rawValue <= EXPERIENCE_VALENCE_MAX
      ? rawValue
      : undefined;

  const status = isValidExperienceValenceStatus(input.rawStatus)
    ? input.rawStatus
    : undefined;

  switch (status) {
    case 'observed':
      return value !== undefined && value !== 0
        ? { status: 'observed', value }
        : { status: 'unknown' };
    case 'neutral':
      // 模型省略数值时按 0 规范化；给了非 0 或越界值视为自相矛盾
      if (!hasRawValue) return { status: 'neutral', value: 0 };
      return value === 0 ? { status: 'neutral', value: 0 } : { status: 'unknown' };
    case 'mixed':
      return value !== undefined
        ? { status: 'mixed', value }
        : { status: 'unknown' };
    case 'unknown':
    case 'extraction_failed':
      return { status };
    default:
      // status 缺失或非法：只按"明确非 0 的合法数值"派生 observed
      if (value !== undefined && value !== 0) {
        return { status: 'observed', value };
      }
      return { status: 'unknown' };
  }
}

/**
 * 校验冻结进事件的 experienceValence 字段组合（纯函数）。
 *
 * 返回 null 表示合法；返回字符串表示错误消息（调用方负责归类为 invalid_payload）。
 *
 * 合法：
 * - 两个字段都缺失（旧事件，合法历史形态）
 * - observed + 非 0 有限数（[-1,1]）
 * - neutral + 0
 * - mixed + 有限数（[-1,1]，允许 0）
 * - unknown / extraction_failed（不得带数值）
 *
 * 非法：
 * - 只有 experienceValence 没有 status（部分新格式）
 * - status 非法
 * - observed 缺数值或数值为 0
 * - neutral 缺数值或数值非 0
 * - mixed 缺数值
 * - unknown / extraction_failed 携带数值
 * - NaN / Infinity / 越界
 */
export function validateExperienceValenceFields(input: {
  experienceValence?: unknown;
  experienceValenceStatus?: unknown;
}): string | null {
  const hasValue = input.experienceValence !== undefined;
  const hasStatus = input.experienceValenceStatus !== undefined;

  // 旧事件：两个字段都不存在，属于合法历史形态（不回填、不虚构）
  if (!hasValue && !hasStatus) return null;

  if (!hasStatus) {
    return 'observation 存在 experienceValence 但缺少 experienceValenceStatus（禁止部分新格式）';
  }
  if (!isValidExperienceValenceStatus(input.experienceValenceStatus)) {
    return `observation.experienceValenceStatus 非法：${String(input.experienceValenceStatus)}`;
  }
  const status = input.experienceValenceStatus;

  if (status === 'unknown' || status === 'extraction_failed') {
    if (hasValue) {
      return `observation.experienceValenceStatus=${status} 不得携带 experienceValence`;
    }
    return null;
  }

  if (!hasValue) {
    return `observation.experienceValenceStatus=${status} 必须携带 experienceValence`;
  }
  const value = input.experienceValence;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'observation.experienceValence 必须是有限数值';
  }
  if (value < EXPERIENCE_VALENCE_MIN || value > EXPERIENCE_VALENCE_MAX) {
    return `observation.experienceValence 越界：${value}（允许范围 [${EXPERIENCE_VALENCE_MIN}, ${EXPERIENCE_VALENCE_MAX}]）`;
  }
  if (status === 'observed' && value === 0) {
    return 'observation.experienceValenceStatus=observed 时数值不能为 0';
  }
  if (status === 'neutral' && value !== 0) {
    return 'observation.experienceValenceStatus=neutral 时数值必须为 0';
  }
  return null;
}
