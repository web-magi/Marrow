<script setup lang="ts">
/**
 * MemoryConstellation.vue — MARROW MEMORY UNIVERSE（三维记忆宇宙）
 *
 * 数据真实性约束（与改造前完全一致）：
 *   - 星体 = /api/state 的 current.episodicBuffer（一条真实 EpisodicMemory 一颗星）；
 *   - 星体大小 = salience，颜色 = valence；不增加任何虚构记忆节点；
 *   - 关联记忆 = current.associations，仅作为真实记录在折叠列表中展示（cue / source / 计数）；
 *   - 现有 Schema 不存在「情景记忆 ↔ 关联记忆」的可靠外键，因此三维场景中
 *     不生成任何记忆连线（links 恒为空），也不按关键词/文本/时间相似度推测关系；
 *   - 无记忆时保留深空背景并给出空状态提示，不使用虚构数据填充。
 *
 * 空间稳定性：星体三维坐标完全由记忆 id 的确定性哈希推导（再做确定性的最小间距松弛），
 * 相同记忆集合刷新后位置完全一致；力导向被关闭（节点坐标固定），不存在随机漂移。
 *
 * 唤起接口：evokedMemoryId 命中时只显示静态高亮环，不做模拟唤起动画。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import ForceGraph3D, { type ForceGraph3DInstance, type NodeObject } from '3d-force-graph';
import * as THREE from 'three';

interface EpisodicMemoryView {
  id: string;
  summary: string;
  keywords?: string[];
  valence: number;
  salience: number;
  timestamp: string;
  sourceEventId?: string;
  isTrauma?: boolean;
  // ---- 只读调用统计（旧数据可能缺失，统一按 0 / null 兜底） ----
  /** 累计调用次数 */
  evokedCount?: number;
  /** 最近调用时间（ISO） */
  lastEvokedAt?: string | null;
  /** 当前 24h 窗口内调用次数 */
  evokedCount24h?: number;
  /** 当前 24h 统计窗口起点（ISO） */
  evokedWindowStart?: string | null;
}

interface AssociationView {
  id: string;
  timestamp: string;
  cue: string;
  valence: number;
  salience: number;
  source: string;
  isScar?: boolean;
}

const props = withDefaults(defineProps<{
  episodic?: EpisodicMemoryView[];
  associations?: AssociationView[];
  /** 未来真实唤起机制接入后传入记忆 id；当前不传即不高亮 */
  evokedMemoryId?: string | null;
}>(), {
  episodic: () => [],
  associations: () => [],
  evokedMemoryId: null,
});

const emit = defineEmits<{
  (e: 'jump-source', payload: { eventId: string; timestamp: string; kind: 'episodic' | 'association' }): void;
}>();

// ---------------- 确定性散列（FNV-1a） ----------------
function hash32(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function unit(seed: string): number {
  return hash32(seed) / 4294967296;
}
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ---------------- 效价 → 颜色（冷白 → 青 → 蓝紫 / 冷白 → 暖橙 → 玫瑰） ----------------
const C_NEUTRAL = 0xbfe9ff;
const C_CYAN = 0x00e5ff;
const C_VIOLET = 0x8b5cff;
const C_AMBER = 0xffb070;
const C_ROSE = 0xff6e8a;

function mixHex(a: number, b: number, t: number): number {
  const f = clamp01(t);
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * f);
  const g = Math.round(ag + (bg - ag) * f);
  const bl = Math.round(ab + (bb - ab) * f);
  return (r << 16) | (g << 8) | bl;
}
function valenceColorHex(v: number): number {
  const x = Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));
  if (x >= 0) {
    return x <= 0.5 ? mixHex(C_NEUTRAL, C_CYAN, x / 0.5) : mixHex(C_CYAN, C_VIOLET, (x - 0.5) / 0.5);
  }
  const t = -x;
  return t <= 0.5 ? mixHex(C_NEUTRAL, C_AMBER, t / 0.5) : mixHex(C_AMBER, C_ROSE, (t - 0.5) / 0.5);
}
function cssHex(hex: number): string {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

// ---------------- 确定性三维布局 ----------------
const UNIVERSE_R = 95;
const Y_SQUASH = 0.72;
const MIN_GAP = 30;

interface Point3 { x: number; y: number; z: number }

/**
 * 由记忆 id 直接推导球体内部的三维坐标（cbrt 半径 → 体积均匀，非球壳）；
 * 随后做固定的最小间距松弛，避免真实数据里偶发的近距离重叠。
 * 全过程无随机数，同一组 id 必然得到同一组坐标。
 */
function layout3D(rows: EpisodicMemoryView[]): Map<string, Point3> {
  const pts = rows.map((m) => {
    const theta = unit(`${m.id}|theta`) * Math.PI * 2;
    const phi = Math.acos(2 * unit(`${m.id}|phi`) - 1);
    const r = UNIVERSE_R * (0.36 + 0.64 * Math.cbrt(unit(`${m.id}|r`)));
    return {
      id: m.id,
      x: r * Math.sin(phi) * Math.cos(theta),
      y: r * Math.cos(phi) * Y_SQUASH,
      z: r * Math.sin(phi) * Math.sin(theta),
    };
  });

  // 数量较少时做确定性的最小间距松弛（节点多时跳过，避免 O(n²) 拖慢初始化）
  const relaxIterations = pts.length > 64 ? 0 : 120;
  for (let iter = 0; iter < relaxIterations; iter++) {
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i];
        const b = pts[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dz = a.z - b.z;
        let d = Math.hypot(dx, dy, dz);
        if (d >= MIN_GAP) continue;
        if (d < 1e-4) {
          // 完全重合时的确定性退让方向（由两个 id 共同决定）
          const s = unit(`${a.id}|${b.id}`);
          dx = Math.cos(s * Math.PI * 2);
          dy = 0.35;
          dz = Math.sin(s * Math.PI * 2);
          d = Math.hypot(dx, dy, dz);
        }
        // 沿两星连线互斥推开：a 沿 +u，b 沿 -u
        const push = (MIN_GAP - d) * 0.3;
        const ux = dx / d;
        const uy = dy / d;
        const uz = dz / d;
        a.x += ux * push; a.y += uy * push; a.z += uz * push;
        b.x -= ux * push; b.y -= uy * push; b.z -= uz * push;
      }
    }
  }

  const pos = new Map<string, Point3>();
  for (const p of pts) {
    const len = Math.hypot(p.x, p.y, p.z);
    const k = len > UNIVERSE_R * 1.35 ? (UNIVERSE_R * 1.35) / len : 1;
    pos.set(p.id, { x: p.x * k, y: p.y * k, z: p.z * k });
  }
  return pos;
}

// ---------------- 星体（真实 EpisodicMemory） ----------------
// 视觉常量集中定义：调用热度驱动的亮度/大小编码（纯展示，不改动任何业务数据）
const RECALL_WINDOW_MS = 86_400_000; // 24h 统计窗口
const RECENCY_TAU_DAYS = 2; // 新鲜度时间常数（天）
const HEAT_GLOW_THRESHOLD = 0.3; // 该热度以上才出现明显光晕
/** 大小台阶：按 min 降序匹配，首个满足 evokedCount >= min 的档位生效 */
const SIZE_TIERS: ReadonlyArray<{ min: number; mul: number }> = [
  { min: 15, mul: 1.4 },
  { min: 5, mul: 1.25 },
];

interface StarNode extends Point3 {
  m: EpisodicMemoryView;
  radius: number;
  hex: number;
  color: string;
  tier: number;
  label: string;
}

/**
 * 24h 调用次数：窗口是否过期只看 evokedWindowStart，
 * lastEvokedAt 仅用于新鲜度与 tooltip，不参与窗口判断。
 */
function recallCount24h(m: EpisodicMemoryView, now: number): number {
  const winTs = Date.parse(m.evokedWindowStart ?? '');
  if (!Number.isFinite(winTs) || now - winTs >= RECALL_WINDOW_MS) return 0;
  return Number.isFinite(m.evokedCount24h) ? Math.max(0, m.evokedCount24h!) : 0;
}

/** 调用热度：salience × 近 24h 调用强度 × 时间新鲜度；旧数据缺字段时 heat = 0 */
function recallHeat(m: EpisodicMemoryView, now: number): number {
  const salience = clamp01(Number(m.salience) || 0);
  const lastTs = Date.parse(m.lastEvokedAt ?? '');
  const baseTs = Date.parse(String(m.timestamp ?? ''));
  const refTs = Number.isFinite(lastTs) ? lastTs : baseTs;
  const ageDays = Number.isFinite(refTs) ? Math.max(0, (now - refTs) / 86_400_000) : 0;
  const recency = Math.exp(-ageDays / RECENCY_TAU_DAYS);
  const countFactor = 1 - Math.exp(-recallCount24h(m, now) / 2);
  return clamp01(salience * countFactor * recency);
}

/** 核心半径：未调用时只是 0.6 的暗点；热度越高越大，累计调用达标后台阶式放大 */
function radiusOfHeat(heat: number, evokedCount: number): number {
  let radius = 0.6 + 2.6 * Math.pow(heat, 1.5);
  const tier = SIZE_TIERS.find((t) => (Number(evokedCount) || 0) >= t.min);
  if (tier) radius *= tier.mul;
  return radius;
}

/** 亮度档位：0 = 全暗（无光晕） / 1 = 微光 / 2 = 光晕 / 3 = 强光晕 */
function heatTier(heat: number): number {
  if (heat < 1e-6) return 0;
  if (heat < HEAT_GLOW_THRESHOLD) return 1;
  if (heat < 0.6) return 2;
  return 3;
}

const stars = computed<StarNode[]>(() => {
  const rows = Array.isArray(props.episodic) ? props.episodic : [];
  const pos = layout3D(rows);
  // now 只在此处取一次：不设定时器，props 变化 / 重渲染时自然刷新
  const now = Date.now();
  return rows.map((m) => {
    const p = pos.get(m.id) ?? { x: 0, y: 0, z: 0 };
    const heat = recallHeat(m, now);
    const hex = valenceColorHex(Number(m.valence) || 0);
    const summary = String(m.summary ?? '');
    return {
      m,
      x: p.x,
      y: p.y,
      z: p.z,
      radius: radiusOfHeat(heat, Number(m.evokedCount) || 0),
      hex,
      color: cssHex(hex),
      tier: heatTier(heat),
      label: summary.length > 12 ? summary.slice(0, 12) + '…' : summary,
    };
  });
});

// ---------------- 关联记忆星点（真实 AssociationMemory，独立外层，不连线） ----------------
const ASSOC_R = 148;
const ASSOC_HEX = 0x4de3b0; // 薄荷绿：与情景记忆的冷暖色阶明确区分

/**
 * 关联记忆沿用改造前的 salience × 新鲜度 微光规则：
 * 不套用情景记忆的调用热度公式，也不因缺少 evoked 字段而强制变暗。
 */
/** 低于该激活度：只是一个黯淡的点，没有光晕 */
const IGNITE = 0.42;

function activation(salience: number, timestamp: string, now: number): number {
  const s = clamp01(Number(salience) || 0);
  const t = Date.parse(String(timestamp));
  const ageDays = Number.isFinite(t) ? Math.max(0, (now - t) / 86400000) : 0;
  const freshness = ageDays <= 1 ? 1 : Math.exp(-(ageDays - 1) / 3);
  return clamp01(s * freshness);
}

/** 核心半径：未点亮时只有暗点大小；点亮后随激活度增长，并在阈值处台阶式变大 */
function radiusFor(heat: number): number {
  if (heat < IGNITE) {
    return 0.55 + 0.45 * (heat / IGNITE);
  }
  const k = clamp01((heat - IGNITE) / (1 - IGNITE));
  let r = 0.9 + 2.6 * Math.pow(k, 1.6);
  // “关联积累到一定强度”后的台阶式变大
  if (k >= 0.55) r *= 1.3;
  if (k >= 0.85) r *= 1.45;
  return r;
}
/** 亮度分档：-1 表示未点亮（无光晕），0..4 表示自发光与光晕强度 */
function brightnessBucket(heat: number): number {
  if (heat < IGNITE) return -1;
  return Math.round(clamp01((heat - IGNITE) / (1 - IGNITE)) * 4);
}
/** 旧亮度档 → 统一 tier（0 全暗 / 1 微光 / 2 光晕 / 3 强光晕） */
function bucketToTier(bucket: number): number {
  if (bucket < 0) return 0;
  if (bucket <= 1) return 1;
  if (bucket <= 3) return 2;
  return 3;
}

/** 关联记忆落在情景记忆云外的一层薄壳上，保证两类节点在空间上也能区分 */
function layoutAssoc(rows: AssociationView[]): Map<string, Point3> {
  const map = new Map<string, Point3>();
  for (const a of rows) {
    const theta = unit(`${a.id}|a-theta`) * Math.PI * 2;
    const phi = Math.acos(2 * unit(`${a.id}|a-phi`) - 1);
    const r = ASSOC_R * (0.92 + 0.16 * unit(`${a.id}|a-r`));
    map.set(a.id, {
      x: r * Math.sin(phi) * Math.cos(theta),
      y: r * Math.cos(phi) * 0.5,
      z: r * Math.sin(phi) * Math.sin(theta),
    });
  }
  return map;
}

interface AssocNode extends Point3 {
  a: AssociationView;
  radius: number;
  hex: number;
  tier: number;
}

const assocNodes = computed<AssocNode[]>(() => {
  const rows = Array.isArray(props.associations) ? props.associations : [];
  const pos = layoutAssoc(rows);
  const now = Date.now();
  return rows.map((a) => {
    const p = pos.get(a.id) ?? { x: 0, y: 0, z: 0 };
    const heat = activation(Number(a.salience) || 0, a.timestamp, now);
    // 关联记忆整体比情景记忆更小，且同样遵守“未点亮 = 暗点”
    return {
      a,
      x: p.x,
      y: p.y,
      z: p.z,
      radius: radiusFor(heat) * 0.72,
      hex: ASSOC_HEX,
      tier: bucketToTier(brightnessBucket(heat)),
    };
  });
});

type UniverseNode = NodeObject & {
  id: string;
  kind: 'episodic' | 'association';
  radius: number;
  hex: number;
  tier: number;
  x: number;
  y: number;
  z: number;
  fx: number;
  fy: number;
  fz: number;
  m?: EpisodicMemoryView;
  a?: AssociationView;
};

function buildGraphNodes(): UniverseNode[] {
  const episodicNodes: UniverseNode[] = stars.value.map((s) => ({
    id: s.m.id,
    kind: 'episodic',
    m: s.m,
    radius: s.radius,
    hex: s.hex,
    tier: s.tier,
    x: s.x,
    y: s.y,
    z: s.z,
    // 固定坐标：关闭力导向漂移，刷新后位置完全一致
    fx: s.x,
    fy: s.y,
    fz: s.z,
  }));
  const associationNodes: UniverseNode[] = assocNodes.value.map((n) => ({
    id: n.a.id,
    kind: 'association',
    a: n.a,
    radius: n.radius,
    hex: n.hex,
    tier: n.tier,
    x: n.x,
    y: n.y,
    z: n.z,
    fx: n.x,
    fy: n.y,
    fz: n.z,
  }));
  return [...episodicNodes, ...associationNodes];
}

/** 当前图的全部真实节点（情景 + 关联）；links 恒为空，不制造任何推测性连线 */
const graphNodes = computed<UniverseNode[]>(() => buildGraphNodes());
const nodeById = computed(() => new Map(graphNodes.value.map((n) => [n.id, n])));

/**
 * 视觉签名：节点位置/颜色/半径/亮度档位任一变化即重建图。
 * 情景记忆额外纳入 4 个只读调用字段，字段变化（累计/24h/窗口）必须触发重建，
 * 否则亮度与大小不会更新；关联记忆没有这些字段，保持旧签名。
 */
const visualSignature = computed(() =>
  graphNodes.value
    .map((n) => {
      const base = `${n.id}:${n.hex}:${n.radius.toFixed(2)}:${n.tier}`;
      if (n.kind !== 'episodic' || !n.m) return base;
      const m = n.m;
      return `${base}:${m.evokedCount ?? 0}:${m.lastEvokedAt ?? ''}:${m.evokedCount24h ?? 0}:${m.evokedWindowStart ?? ''}`;
    })
    .join('|'),
);

// ---------------- 关联记忆（真实 AssociationMemory，按 cue + source 聚合） ----------------
interface AssocGroup {
  key: string;
  cue: string;
  source: string;
  count: number;
  maxSalience: number;
  avgValence: number;
  records: AssociationView[];
  color: string;
}

const SOURCE_LABEL: Record<string, string> = {
  interruption: '中断',
  dialogue: '对话',
  environment: '环境',
};
function anchorLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

const assocGroups = computed<AssocGroup[]>(() => {
  const rows = Array.isArray(props.associations) ? props.associations : [];
  const map = new Map<string, AssocGroup>();
  for (const a of rows) {
    const cue = String(a.cue ?? '—');
    const source = String(a.source ?? 'unknown');
    const key = `${cue}|${source}`;
    const salience = clamp01(Number(a.salience) || 0);
    const valence = Number(a.valence) || 0;
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        cue,
        source,
        count: 0,
        maxSalience: 0,
        avgValence: 0,
        records: [],
        color: cssHex(valenceColorHex(valence)),
      };
      map.set(key, g);
    }
    g.count += 1;
    g.records.push(a);
    g.maxSalience = Math.max(g.maxSalience, salience);
    g.avgValence += valence;
  }
  for (const g of map.values()) {
    g.avgValence = g.count > 0 ? g.avgValence / g.count : 0;
    g.color = cssHex(valenceColorHex(g.avgValence));
  }
  return [...map.values()];
});

// ---------------- 选中与详情 ----------------
const selectedStarId = ref<string | null>(null);
const selectedGroupKey = ref<string | null>(null);
const expandedGroup = ref(false);

const selectedStar = computed<StarNode | null>(
  () => stars.value.find((s) => s.m.id === selectedStarId.value) ?? null,
);
const selectedGroup = computed<AssocGroup | null>(
  () => assocGroups.value.find((g) => g.key === selectedGroupKey.value) ?? null,
);

function selectStar(id: string): void {
  selectedStarId.value = id;
  selectedGroupKey.value = null;
  expandedGroup.value = false;
}
function selectGroup(key: string): void {
  selectedGroupKey.value = key;
  selectedStarId.value = null;
  expandedGroup.value = false;
}
function clearSelection(): void {
  selectedStarId.value = null;
  selectedGroupKey.value = null;
  expandedGroup.value = false;
}

function jumpSource(): void {
  const s = selectedStar.value;
  if (s?.m.sourceEventId) {
    emit('jump-source', {
      eventId: s.m.sourceEventId,
      timestamp: s.m.timestamp,
      kind: 'episodic',
    });
  }
}

// ---------------- 唤起高亮接口（静态，无动画） ----------------
const evokedStarId = computed<string | null>(() => {
  if (!props.evokedMemoryId) return null;
  const hit = stars.value.find((s) => s.m.id === props.evokedMemoryId);
  return hit ? hit.m.id : null;
});

// ---------------- 折叠记忆列表 ----------------
const listOpen = ref(false);
const listTab = ref<'episodic' | 'association'>('episodic');
function toggleList(): void {
  listOpen.value = !listOpen.value;
}
function pickFromList(id: string): void {
  selectStar(id);
}
function pickGroupFromList(key: string): void {
  selectGroup(key);
}

// ---------------- 三维场景 ----------------
const containerRef = ref<HTMLDivElement | null>(null);
const webglOk = ref(true);
const hoveredId = ref<string | null>(null);
const tipPos = ref({ x: 0, y: 0 });

const hoveredNode = computed<UniverseNode | null>(
  () => (hoveredId.value ? nodeById.value.get(hoveredId.value) ?? null : null),
);

const DEFAULT_CAM = { x: 0, y: 34, z: 218 };

let graph: ForceGraph3DInstance<UniverseNode> | null = null;
let resizeObserver: ResizeObserver | null = null;
let pointerEl: HTMLDivElement | null = null;
const nodeObjects = new Map<string, THREE.Group>();
const disposables: Array<{ dispose: () => void }> = [];

interface SceneResources {
  sphere: THREE.SphereGeometry;
  haloTexture: THREE.CanvasTexture;
  ringTexture: THREE.CanvasTexture;
  nodeMats: Map<string, THREE.MeshStandardMaterial>;
  haloMats: Map<string, THREE.SpriteMaterial>;
  ringSelected: THREE.SpriteMaterial;
  ringEvoked: THREE.SpriteMaterial;
}
let res: SceneResources | null = null;

function makeHaloTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.40)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.10)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeRingTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = 'rgba(255,255,255,0.95)';
  ctx.lineWidth = 4;
  ctx.shadowColor = 'rgba(255,255,255,0.9)';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 12, 0, Math.PI * 2);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 亮度档位 → 材质参数（0 全暗 / 1 微光 / 2 光晕 / 3 强光晕） */
const NODE_TIER_SPEC = [
  { emissive: 0.06, base: 0.32 },
  { emissive: 0.2, base: 0.24 },
  { emissive: 0.9, base: 0.2 },
  { emissive: 1.4, base: 0.16 },
] as const;
/** 只有 tier >= 2 才有光晕；档位越高光晕越亮 */
const HALO_OPACITY = [0, 0, 0.22, 0.42] as const;

function nodeMaterial(hex: number, tier: number): THREE.MeshStandardMaterial {
  const key = `${hex}-${tier}`;
  const cache = res!.nodeMats;
  const hit = cache.get(key);
  if (hit) return hit;
  const spec = NODE_TIER_SPEC[tier] ?? NODE_TIER_SPEC[0];
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(hex).multiplyScalar(spec.base),
    emissive: new THREE.Color(hex),
    emissiveIntensity: spec.emissive,
    roughness: 0.35,
    metalness: 0.2,
  });
  cache.set(key, mat);
  return mat;
}

/** 光晕材质按 `${hex}-${tier}` 分别缓存，避免所有星体共用同一个材质 */
function haloMaterial(hex: number, tier: number): THREE.SpriteMaterial {
  const key = `${hex}-${tier}`;
  const cache = res!.haloMats;
  const hit = cache.get(key);
  if (hit) return hit;
  const mat = new THREE.SpriteMaterial({
    map: res!.haloTexture,
    color: hex,
    transparent: true,
    opacity: HALO_OPACITY[tier] ?? 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  cache.set(key, mat);
  return mat;
}

/**
 * 每个星体：共享 SphereGeometry + 按颜色/档位复用的 Material。
 * 每个节点只新建 Mesh / Sprite 外壳，几何体与材质全部复用。
 */
function makeNodeObject(n: UniverseNode): THREE.Object3D {
  const group = new THREE.Group();

  const sphere = new THREE.Mesh(res!.sphere, nodeMaterial(n.hex, n.tier));
  sphere.scale.setScalar(n.radius);
  group.add(sphere);

  // 只有达到光晕档位才有光晕；全暗/微光时只有一个点
  if (n.tier >= 2) {
    const halo = new THREE.Sprite(haloMaterial(n.hex, n.tier));
    halo.scale.setScalar(n.radius * (2.9 + (n.tier - 2) * 0.9));
    group.add(halo);
  }

  const ringSelected = new THREE.Sprite(res!.ringSelected);
  ringSelected.scale.setScalar(Math.max(n.radius * 3.4, 7));
  ringSelected.visible = false;
  ringSelected.userData.role = 'selected';
  group.add(ringSelected);

  if (n.kind === 'episodic') {
    const ringEvoked = new THREE.Sprite(res!.ringEvoked);
    ringEvoked.scale.setScalar(Math.max(n.radius * 4.4, 9));
    ringEvoked.visible = false;
    ringEvoked.userData.role = 'evoked';
    group.add(ringEvoked);
  }

  nodeObjects.set(n.id, group);
  return group;
}

const selectedAssocIds = computed(
  () => new Set(selectedGroup.value?.records.map((r) => r.id) ?? []),
);

function refreshHighlights(): void {
  const assocIds = selectedAssocIds.value;
  for (const [id, group] of nodeObjects) {
    const selected = id === selectedStarId.value || assocIds.has(id);
    const evoked = id === evokedStarId.value;
    group.scale.setScalar(selected ? 1.14 : 1);
    for (const child of group.children) {
      if (child.userData.role === 'selected') child.visible = selected;
      if (child.userData.role === 'evoked') child.visible = evoked && !selected;
    }
  }
}

function addDeepSpace(scene: THREE.Scene): void {
  // 远景星点：纯装饰，确定性分布，不参与任何真实数据
  const count = 900;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const theta = unit(`sf-theta-${i}`) * Math.PI * 2;
    const phi = Math.acos(2 * unit(`sf-phi-${i}`) - 1);
    const r = 360 + 540 * Math.cbrt(unit(`sf-r-${i}`));
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi);
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: 0x9fd8ff,
    size: 1.6,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  scene.add(new THREE.Points(geo, mat));
  disposables.push(geo, mat);

  // 极弱的空间雾感（两张低透明度光晕，制造纵深）
  const nebulas: Array<{ color: number; pos: [number, number, number]; scale: number; opacity: number }> = [
    { color: 0x1b4b7a, pos: [-330, 190, -700], scale: 820, opacity: 0.16 },
    { color: 0x3a2a6a, pos: [380, -160, -780], scale: 760, opacity: 0.13 },
  ];
  for (const nb of nebulas) {
    const matN = new THREE.SpriteMaterial({
      map: res!.haloTexture,
      color: nb.color,
      transparent: true,
      opacity: nb.opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(matN);
    sprite.position.set(...nb.pos);
    sprite.scale.setScalar(nb.scale);
    scene.add(sprite);
    disposables.push(matN);
  }
}

function buildResources(): void {
  const sphere = new THREE.SphereGeometry(1, 32, 24);
  const haloTexture = makeHaloTexture();
  const ringTexture = makeRingTexture();
  const ringSelected = new THREE.SpriteMaterial({
    map: ringTexture,
    color: 0xe2f2ff,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  const ringEvoked = new THREE.SpriteMaterial({
    map: ringTexture,
    color: 0x8b5cff,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
  });
  res = {
    sphere,
    haloTexture,
    ringTexture,
    nodeMats: new Map(),
    haloMats: new Map(),
    ringSelected,
    ringEvoked,
  };
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

function onPointerMove(e: PointerEvent): void {
  const el = pointerEl;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const x = Math.min(Math.max(e.clientX - rect.left + 16, 8), Math.max(8, rect.width - 280));
  const y = Math.min(Math.max(e.clientY - rect.top + 12, 8), Math.max(8, rect.height - 84));
  tipPos.value = { x, y };
}

function rebuildGraph(): void {
  if (!graph) return;
  if (selectedStarId.value && !stars.value.some((s) => s.m.id === selectedStarId.value)) {
    selectedStarId.value = null;
  }
  if (hoveredId.value && !nodeById.value.has(hoveredId.value)) {
    hoveredId.value = null;
  }
  nodeObjects.clear();
  graph.graphData({ nodes: graphNodes.value, links: [] });
  window.requestAnimationFrame(refreshHighlights);
}

function resetView(): void {
  graph?.cameraPosition(DEFAULT_CAM, { x: 0, y: 0, z: 0 }, 700);
}

function initScene(): void {
  const el = containerRef.value;
  if (!el) return;
  if (!webglAvailable()) {
    webglOk.value = false;
    return;
  }

  buildResources();

  const g = new ForceGraph3D(el, { controlType: 'orbit' }) as unknown as ForceGraph3DInstance<UniverseNode>;
  graph = g;

  g.backgroundColor('#040a14');
  g.showNavInfo(false);
  g.nodeLabel(() => '');
  g.nodeThreeObject((n: UniverseNode) => makeNodeObject(n));
  g.enableNodeDrag(false);
  g.enableNavigationControls(true);
  g.warmupTicks(0);
  g.cooldownTicks(0);
  g.linkDirectionalParticles(2);
  g.d3Force('charge', null);
  g.d3Force('link', null);
  g.d3Force('center', null);

  const width = el.clientWidth || 800;
  const height = el.clientHeight || 430;
  g.width(width).height(height);

  const camera = g.camera() as THREE.PerspectiveCamera;
  camera.fov = 48;
  camera.near = 1;
  camera.far = 6000;
  camera.updateProjectionMatrix();

  const renderer = g.renderer();
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const ambient = new THREE.AmbientLight(0x7fb6e0, 0.9);
  const key = new THREE.DirectionalLight(0xdcf0ff, 1.1);
  key.position.set(220, 260, 200);
  const cyan = new THREE.PointLight(0x00e5ff, 24000, 0, 2);
  cyan.position.set(150, -90, 160);
  const violet = new THREE.PointLight(0x8b5cff, 19000, 0, 2);
  violet.position.set(-220, 140, -170);
  g.lights([ambient, key, cyan, violet]);

  addDeepSpace(g.scene());

  g.onNodeClick((n: UniverseNode) => {
    if (n.kind === 'association' && n.a) {
      selectGroup(`${n.a.cue}|${n.a.source}`);
    } else {
      selectStar(n.id);
    }
  });
  g.onNodeHover((n: UniverseNode | null) => {
    hoveredId.value = n ? n.id : null;
  });
  g.onBackgroundClick(() => {
    clearSelection();
  });

  const controls = g.controls() as unknown as {
    minDistance: number;
    maxDistance: number;
    enablePan: boolean;
    enableDamping: boolean;
    dampingFactor: number;
    update: () => void;
  };
  controls.minDistance = 70;
  controls.maxDistance = 900;
  controls.enablePan = true;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  g.cameraPosition(DEFAULT_CAM, { x: 0, y: 0, z: 0 }, 0);

  rebuildGraph();

  pointerEl = el;
  el.addEventListener('pointermove', onPointerMove);

  resizeObserver = new ResizeObserver(() => {
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w > 0 && h > 0) {
      g.width(w).height(h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    }
  });
  resizeObserver.observe(el);
}

function disposeScene(): void {
  resizeObserver?.disconnect();
  resizeObserver = null;

  if (pointerEl) {
    pointerEl.removeEventListener('pointermove', onPointerMove);
    pointerEl.querySelectorAll('canvas').forEach((c) => c.remove());
    pointerEl = null;
  }

  const g = graph;
  graph = null;
  if (g) {
    try { g.pauseAnimation(); } catch { /* noop */ }
    try { (g as unknown as { _destructor?: () => void })._destructor?.(); } catch { /* noop */ }
  }

  if (res) {
    res.nodeMats.forEach((m) => m.dispose());
    res.haloMats.forEach((m) => m.dispose());
    res.ringSelected.dispose();
    res.ringEvoked.dispose();
    res.sphere.dispose();
    res.haloTexture.dispose();
    res.ringTexture.dispose();
    res = null;
  }
  for (const d of disposables) d.dispose();
  disposables.length = 0;
  nodeObjects.clear();
  hoveredId.value = null;
}

watch(visualSignature, () => rebuildGraph());
watch([selectedStarId, selectedGroupKey, evokedStarId], () => refreshHighlights());

onMounted(initScene);
onBeforeUnmount(disposeScene);

// ---------------- 格式化 ----------------
function fmtSal(v: number): string {
  return (clamp01(Number(v) || 0) * 100).toFixed(1) + '%';
}
function fmtVal(v: number): string {
  const n = Number(v) || 0;
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}
function fmtTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtShortTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const isEmpty = computed(() => stars.value.length === 0);

// ---------------- 调用统计（只读展示） ----------------
function recallTotal(m?: EpisodicMemoryView): number {
  const n = Number(m?.evokedCount);
  return Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
}
function recallRecent(m?: EpisodicMemoryView): number {
  return m ? recallCount24h(m, Date.now()) : 0;
}
function lastEvokedText(m?: EpisodicMemoryView): string {
  const ts = Date.parse(m?.lastEvokedAt ?? '');
  return Number.isFinite(ts) ? fmtShortTime(String(m!.lastEvokedAt)) : '尚未调用';
}
/** 旧数据全部没有调用字段时，星图角落提示统计从本次升级后开始 */
const showRecallHint = computed(() => {
  const rows = Array.isArray(props.episodic) ? props.episodic : [];
  return rows.length > 0 && rows.every((m) => recallTotal(m) === 0);
});
</script>

<template>
  <div class="panel constellation-panel">
    <div class="panel-header">
      <span class="zh">记忆星图</span>
      <span class="en">MARROW MEMORY UNIVERSE</span>
      <span class="corner-id">007</span>
      <span class="corner-tr"></span>
      <span class="corner-bl"></span>
      <span class="corner-br"></span>
    </div>

    <div class="mc-meta">
      <span class="mc-stat">情景记忆 <b>{{ stars.length }}</b></span>
      <span class="mc-stat">关联记忆 <b>{{ associations.length }}</b></span>
      <span class="mc-stat">记忆连线 <b>0</b></span>
      <span class="mc-legend">
        <i class="mc-legend-dot episodic"></i>情景 · 亮度/大小 = 调用热度（显著度 × 24h 调用 × 新鲜度）
        <i class="mc-legend-dot association"></i>关联 · 薄荷绿
        · 未被调用记忆仅为暗点
      </span>
      <button class="mc-reset" @click="resetView">RESET VIEW</button>
      <button class="mc-toggle" @click="toggleList">
        {{ listOpen ? '收起记忆列表' : '展开记忆列表' }}
      </button>
    </div>

    <div class="mc-body">
      <div class="mc-stage">
        <div ref="containerRef" class="mc-3d" role="img" aria-label="三维记忆宇宙"></div>
        <div class="mc-vignette"></div>

        <div v-if="!webglOk" class="mc-fallback">
          <div class="empty-text">当前环境不支持 WebGL</div>
          <div class="mc-empty-sub">三维记忆宇宙无法渲染，其余 Dashboard 面板不受影响</div>
        </div>

        <div v-else-if="isEmpty" class="mc-empty">
          <div class="empty-text">尚无记忆星体</div>
          <div class="mc-empty-sub">当前 EpisodicMemory 为空，深空中不生成任何虚构数据</div>
        </div>

        <div v-if="webglOk && showRecallHint" class="mc-hint">
          调用次数自本次升级后开始统计
        </div>

        <div
          v-if="webglOk && hoveredNode"
          class="mc-tooltip"
          :style="{ left: tipPos.x + 'px', top: tipPos.y + 'px' }"
        >
          <template v-if="hoveredNode.kind === 'episodic'">
            <div class="mc-tip-title">{{ hoveredNode.m?.summary }}</div>
            <div class="mc-tip-row">
              {{ fmtShortTime(hoveredNode.m?.timestamp ?? '') }} · salience {{ fmtSal(hoveredNode.m?.salience ?? 0) }}
            </div>
            <div class="mc-tip-row">
              累计调用 {{ recallTotal(hoveredNode.m) }} 次 · 24h 内 {{ recallRecent(hoveredNode.m) }} 次 · 最近调用 {{ lastEvokedText(hoveredNode.m) }}
            </div>
          </template>
          <template v-else>
            <div class="mc-tip-title">{{ hoveredNode.a?.cue }}</div>
            <div class="mc-tip-row">
              关联记忆 · {{ anchorLabel(hoveredNode.a?.source ?? '') }} · {{ fmtShortTime(hoveredNode.a?.timestamp ?? '') }}
            </div>
          </template>
        </div>
      </div>

      <aside v-if="selectedStar || selectedGroup" class="mc-detail">
        <template v-if="selectedStar">
          <div class="mc-detail-head">
            <span class="mc-detail-title">情景记忆</span>
            <button class="mc-close" @click="clearSelection">×</button>
          </div>
          <div class="mc-detail-summary">{{ selectedStar.m.summary }}</div>
          <div class="mc-detail-grid">
            <span>VALENCE</span><b :style="{ color: selectedStar.color }">{{ fmtVal(selectedStar.m.valence) }}</b>
            <span>SALIENCE</span><b>{{ fmtSal(selectedStar.m.salience) }}</b>
            <span>TYPE</span><b>{{ selectedStar.m.isTrauma ? '创伤记忆' : '普通记忆' }}</b>
            <span>TIME</span><b>{{ fmtTime(selectedStar.m.timestamp) }}</b>
            <span>调用</span><b>{{ recallTotal(selectedStar.m) }} 次 · 24h 内 {{ recallRecent(selectedStar.m) }} 次</b>
            <span>最近调用</span><b>{{ lastEvokedText(selectedStar.m) }}</b>
          </div>
          <div v-if="selectedStar.m.keywords?.length" class="mc-detail-kw">
            关键词：{{ selectedStar.m.keywords.slice(0, 8).join(' · ') }}
          </div>
          <div class="mc-detail-src">
            来源事件 ID：<code>{{ selectedStar.m.sourceEventId ?? '—' }}</code>
          </div>
          <button class="mc-jump" :disabled="!selectedStar.m.sourceEventId" @click="jumpSource">
            在生命历程中查看来源事件
          </button>
        </template>

        <template v-else-if="selectedGroup">
          <div class="mc-detail-head">
            <span class="mc-detail-title">关联记忆 · {{ selectedGroup.cue }}</span>
            <button class="mc-close" @click="clearSelection">×</button>
          </div>
          <div class="mc-detail-grid">
            <span>SOURCE</span><b>{{ anchorLabel(selectedGroup.source) }}</b>
            <span>记录数</span><b>{{ selectedGroup.count }}</b>
            <span>MAX SAL.</span><b>{{ fmtSal(selectedGroup.maxSalience) }}</b>
            <span>AVG VAL.</span><b :style="{ color: selectedGroup.color }">{{ fmtVal(selectedGroup.avgValence) }}</b>
          </div>
          <div class="mc-records">
            <div
              v-for="r in selectedGroup.records.slice(0, expandedGroup ? selectedGroup.records.length : 6)"
              :key="r.id"
              class="mc-record"
            >
              <span class="mc-record-time">{{ fmtTime(r.timestamp) }}</span>
              <span class="mc-record-sal">{{ fmtSal(r.salience) }}</span>
              <span class="mc-record-tag">{{ r.isScar ? '伤痕' : '关联' }}</span>
            </div>
          </div>
          <button v-if="selectedGroup.records.length > 6" class="mc-more" @click="expandedGroup = !expandedGroup">
            {{ expandedGroup ? '收起' : `展开全部 ${selectedGroup.records.length} 条` }}
          </button>
          <div class="mc-detail-src mc-detail-note">
            关联记忆是抽象概念关联（cue → source），Schema 未提供与具体情景记忆的外键，因此不绘制推测性连线。
          </div>
        </template>
      </aside>
    </div>

    <div v-if="listOpen" class="mc-drawer">
      <div class="mc-drawer-tabs">
        <button :class="['mc-tab', { active: listTab === 'episodic' }]" @click="listTab = 'episodic'">
          情景记忆 {{ stars.length }}
        </button>
        <button :class="['mc-tab', { active: listTab === 'association' }]" @click="listTab = 'association'">
          关联记忆 {{ assocGroups.length }} 组 / {{ associations.length }} 条
        </button>
      </div>

      <div v-if="listTab === 'episodic'" class="mc-list">
        <div v-if="stars.length === 0" class="mc-list-empty">暂无情景记忆</div>
        <button
          v-for="s in stars"
          :key="s.m.id"
          :class="['mc-list-row', { active: selectedStarId === s.m.id }]"
          @click="pickFromList(s.m.id)"
        >
          <span class="mc-dot" :style="{ background: s.color }"></span>
          <span class="mc-list-text">{{ s.m.summary }}</span>
          <span class="mc-list-num">{{ fmtSal(s.m.salience) }}</span>
          <span class="mc-list-num" :style="{ color: s.color }">{{ fmtVal(s.m.valence) }}</span>
        </button>
      </div>

      <div v-else class="mc-list">
        <div v-if="assocGroups.length === 0" class="mc-list-empty">暂无关联记忆</div>
        <button
          v-for="g in assocGroups"
          :key="g.key"
          :class="['mc-list-row', { active: selectedGroupKey === g.key }]"
          @click="pickGroupFromList(g.key)"
        >
          <span class="mc-dot square assoc"></span>
          <span class="mc-list-text">{{ g.cue }} ← {{ anchorLabel(g.source) }}</span>
          <span class="mc-list-num">{{ g.count }} 条</span>
          <span class="mc-list-num" :style="{ color: g.color }">{{ fmtSal(g.maxSalience) }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.constellation-panel { min-height: 420px; display: flex; flex-direction: column; }

.mc-meta {
  display: flex; align-items: center; flex-wrap: wrap; gap: 14px;
  padding: 6px 2px 8px;
  font-size: 11px; color: var(--text-secondary);
  border-bottom: 1px solid var(--border-dim);
}
.mc-stat b { color: var(--text-primary); font-family: "JetBrains Mono", monospace; font-weight: 600; }
.mc-legend { color: var(--text-label); display: inline-flex; align-items: center; flex-wrap: wrap; gap: 4px; }
.mc-legend-dot {
  width: 6px; height: 6px; border-radius: 50%; display: inline-block;
  margin-left: 6px;
}
.mc-legend-dot.episodic { background: #6fe9ff; box-shadow: 0 0 6px rgba(0, 229, 255, 0.6); }
.mc-legend-dot.association { background: #4de3b0; box-shadow: 0 0 6px rgba(77, 227, 176, 0.6); }
.mc-toggle,
.mc-reset {
  background: transparent;
  border: 1px solid rgba(0, 229, 255, 0.28);
  color: var(--text-secondary);
  font-size: 11px; padding: 2px 10px; cursor: pointer;
  font-family: inherit;
}
.mc-reset { margin-left: auto; letter-spacing: 0.1em; }
.mc-toggle { margin-left: 0; }
.mc-toggle:hover,
.mc-reset:hover { color: var(--text-primary); border-color: rgba(0, 229, 255, 0.55); }

.mc-body { display: flex; gap: 12px; min-height: 0; flex: 1 1 auto; }
.mc-stage {
  position: relative; flex: 1 1 auto; min-width: 0;
  height: 430px; overflow: hidden;
  background:
    radial-gradient(ellipse at 50% 38%, rgba(0, 229, 255, 0.06) 0%, rgba(4, 10, 20, 0) 55%),
    radial-gradient(ellipse at 50% 50%, #061020 0%, #03070f 78%);
  border: 1px solid rgba(0, 229, 255, 0.08);
}
.mc-3d { position: absolute; inset: 0; z-index: 0; }
.mc-vignette {
  position: absolute; inset: 0; z-index: 1; pointer-events: none;
  background: radial-gradient(ellipse at 50% 45%, rgba(0, 229, 255, 0.04) 0%, rgba(3, 8, 18, 0) 42%, rgba(3, 8, 18, 0.55) 100%);
}

.mc-tooltip {
  position: absolute; z-index: 3; pointer-events: none;
  max-width: 264px;
  padding: 6px 9px;
  background: rgba(4, 12, 24, 0.92);
  border: 1px solid rgba(0, 229, 255, 0.35);
  box-shadow: 0 0 12px rgba(0, 229, 255, 0.12);
}
.mc-tip-title {
  font-size: 11px; color: var(--text-primary); line-height: 1.45;
  overflow: hidden; text-overflow: ellipsis; display: -webkit-box;
  -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.mc-tip-row {
  margin-top: 3px; font-size: 10px; color: var(--text-label);
  font-family: "JetBrains Mono", monospace;
}

.mc-hint {
  position: absolute; right: 10px; bottom: 8px; z-index: 2;
  pointer-events: none;
  font-size: 10px; color: var(--text-label);
  opacity: 0.72;
}

.mc-empty,
.mc-fallback {
  position: absolute; inset: 0; z-index: 2;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4px; pointer-events: none;
  background: rgba(3, 8, 18, 0.35);
}
.mc-empty .empty-text,
.mc-fallback .empty-text { color: var(--text-secondary); font-size: 13px; }
.mc-empty-sub { color: var(--text-label); font-size: 11px; }

.mc-detail {
  flex: 0 0 268px;
  border-left: 1px solid var(--border-dim);
  padding-left: 12px;
  display: flex; flex-direction: column; gap: 8px;
  font-size: 12px;
}
.mc-detail-head { display: flex; align-items: center; justify-content: space-between; }
.mc-detail-title {
  font-size: 11px; letter-spacing: 0.12em; color: var(--text-glow);
  font-family: "JetBrains Mono", monospace;
}
.mc-close {
  background: transparent; border: none; color: var(--text-label);
  font-size: 16px; line-height: 1; cursor: pointer;
}
.mc-close:hover { color: var(--text-primary); }
.mc-detail-summary { color: var(--text-primary); line-height: 1.5; }
.mc-detail-grid {
  display: grid; grid-template-columns: auto 1fr; gap: 3px 10px;
  font-size: 11px; color: var(--text-label);
}
.mc-detail-grid b { color: var(--text-secondary); font-weight: 500; font-family: "JetBrains Mono", monospace; }
.mc-detail-kw { color: var(--text-secondary); font-size: 11px; line-height: 1.6; }
.mc-detail-src { color: var(--text-label); font-size: 10px; word-break: break-all; }
.mc-detail-src code { color: var(--text-secondary); }
.mc-detail-note { line-height: 1.6; }
.mc-jump {
  margin-top: 4px; cursor: pointer;
  background: rgba(0, 229, 255, 0.06);
  border: 1px solid rgba(0, 229, 255, 0.35);
  color: var(--text-glow);
  font-size: 11px; padding: 5px 8px; font-family: inherit;
}
.mc-jump:hover:not(:disabled) { background: rgba(0, 229, 255, 0.12); }
.mc-jump:disabled { opacity: 0.4; cursor: not-allowed; }

.mc-records { display: flex; flex-direction: column; gap: 2px; max-height: 160px; overflow-y: auto; }
.mc-record {
  display: grid; grid-template-columns: 1fr auto auto; gap: 8px;
  font-size: 10px; color: var(--text-label);
  font-family: "JetBrains Mono", monospace;
  border-bottom: 1px dashed rgba(0, 229, 255, 0.08);
  padding: 2px 0;
}
.mc-record-sal { color: var(--text-secondary); }
.mc-record-tag { color: var(--status-warn); }
.mc-more {
  background: transparent; border: 1px dashed rgba(139, 92, 255, 0.4);
  color: #C7B4FF; font-size: 10px; padding: 3px 6px; cursor: pointer; font-family: inherit;
}

.mc-drawer {
  margin-top: 10px; border-top: 1px solid var(--border-dim); padding-top: 10px;
  display: flex; flex-direction: column; gap: 8px;
}
.mc-drawer-tabs { display: flex; gap: 8px; }
.mc-tab {
  background: transparent; border: 1px solid var(--border-dim);
  color: var(--text-secondary); font-size: 11px; padding: 3px 10px;
  cursor: pointer; font-family: inherit;
}
.mc-tab.active { border-color: rgba(0, 229, 255, 0.5); color: var(--text-primary); }
.mc-list {
  display: flex; flex-direction: column; gap: 2px;
  max-height: 200px; overflow-y: auto;
}
.mc-list-row {
  display: grid; grid-template-columns: 12px 1fr auto auto; gap: 10px; align-items: center;
  width: 100%; text-align: left; cursor: pointer;
  background: transparent; border: 1px solid transparent;
  border-bottom: 1px dashed rgba(0, 229, 255, 0.08);
  color: var(--text-secondary); font-size: 11px; padding: 4px 6px; font-family: inherit;
}
.mc-list-row:hover { background: rgba(0, 229, 255, 0.04); }
.mc-list-row.active { border-color: rgba(0, 229, 255, 0.35); background: rgba(0, 229, 255, 0.06); }
.mc-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.mc-dot.square { border-radius: 0; transform: rotate(45deg); }
.mc-dot.assoc { background: #4de3b0; }
.mc-list-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-list-num { font-family: "JetBrains Mono", monospace; font-size: 10px; color: var(--text-label); }
.mc-list-empty { color: var(--text-label); font-size: 11px; padding: 6px 2px; }

@media (max-width: 1023px) {
  .mc-body { flex-direction: column; }
  .mc-stage { height: 360px; }
  .mc-detail { flex: 1 1 auto; border-left: none; border-top: 1px solid var(--border-dim); padding-left: 0; padding-top: 10px; }
}
</style>
