/**
 * sensors.ts — 阶段三：传感器接口与模拟实现
 *
 * 抽象传感器层，让状态机可以从"真实世界"获取数据。
 * 阶段三用模拟实现，阶段六接入真实 MCU（ESP32）。
 *
 * 设计原则：
 * - 传感器接口与状态机解耦，可替换实现
 * - 模拟传感器要能复现真实约束（续航耗尽、碰撞、环境变化）
 * - 传感器读数是"世界对身体的真实作用"，不是参数
 */

/**
 * 电池传感器
 *
 * 续航是真实约束：电量会耗尽，耗尽后系统休眠。
 * 阶段三用模拟数据，阶段六接入真实电池。
 */
export interface BatteryReading {
  /** 电量百分比 0-100 */
  level: number;
  /** 是否正在充电 */
  charging: boolean;
  /** 电压（伏特），可选 */
  voltage?: number;
}

export interface BatterySensor {
  read(): BatteryReading;
}

/**
 * 运动传感器（加速度计）
 *
 * 碰撞是真实中断：加速度突变 → arousal 拉升 → interruption_flag 置位。
 */
export interface MotionReading {
  /** 加速度向量（m/s²） */
  x: number;
  y: number;
  z: number;
  /** 加速度模长 */
  magnitude: number;
  /** 是否检测到碰撞（模长超阈值） */
  collision: boolean;
}

export interface MotionSensor {
  /** 碰撞检测阈值（m/s²），超过则视为碰撞 */
  readonly collisionThreshold: number;
  read(): MotionReading;
}

/**
 * 环境传感器
 *
 * 温度/湿度/光照以小时级时间常数缓慢调制 mood_baseline。
 * 不是瞬时刺激，而是长期背景。
 */
export interface EnvironmentReading {
  /** 温度（摄氏度） */
  temperature: number;
  /** 湿度（百分比） */
  humidity: number;
  /** 光照强度（lux） */
  light: number;
}

export interface EnvironmentSensor {
  read(): EnvironmentReading;
}

/**
 * 传感器聚合接口
 *
 * 所有传感器的统一入口。
 */
export interface SensorProvider {
  battery: BatterySensor;
  motion: MotionSensor;
  environment: EnvironmentSensor;
}

// ============================================================
// 模拟实现
// ============================================================

/**
 * 模拟电池传感器
 *
 * - 电量随时间缓慢衰减（模拟使用）
 * - 可通过 setCharging 模拟充电
 * - 电量低于 20% 时 energy 衰减加快
 * - 电量为 0 时系统休眠
 */
export class SimulatedBatterySensor implements BatterySensor {
  private level: number;
  private isCharging: boolean;
  private lastReadTime: number;

  constructor(initialLevel = 100) {
    this.level = initialLevel;
    this.isCharging = false;
    this.lastReadTime = Date.now();
  }

  /** 模拟充电状态切换 */
  setCharging(charging: boolean): void {
    this.isCharging = charging;
  }

  /** 直接设置电量（用于测试场景） */
  setLevel(level: number): void {
    this.level = Math.max(0, Math.min(100, level));
  }

  read(): BatteryReading {
    const now = Date.now();
    const elapsedHours = (now - this.lastReadTime) / (1000 * 60 * 60);
    this.lastReadTime = now;

    if (this.isCharging) {
      // 充电：每小时恢复 50%
      this.level = Math.min(100, this.level + 50 * elapsedHours);
    } else {
      // 放电：每小时消耗 5%（约 20 小时续航）
      this.level = Math.max(0, this.level - 5 * elapsedHours);
    }

    return {
      level: this.level,
      charging: this.isCharging,
      voltage: 3.3 + (this.level / 100) * 0.9, // 3.3V - 4.2V
    };
  }
}

/**
 * 模拟运动传感器
 *
 * - 大部分时间静止（加速度 ≈ 1g = 9.8）
 * - 可通过 triggerCollision() 模拟一次碰撞
 * - 碰撞时加速度模长远超阈值
 */
export class SimulatedMotionSensor implements MotionSensor {
  readonly collisionThreshold = 20; // m/s²，约 2g
  private collisionPending = false;
  private baselineMagnitude = 9.8; // 静止时约 1g

  /** 触发一次碰撞（用于测试） */
  triggerCollision(): void {
    this.collisionPending = true;
  }

  read(): MotionReading {
    if (this.collisionPending) {
      this.collisionPending = false;
      // 碰撞：加速度模长 30-50 m/s²
      const magnitude = 30 + Math.random() * 20;
      return {
        x: (Math.random() - 0.5) * magnitude,
        y: (Math.random() - 0.5) * magnitude,
        z: (Math.random() - 0.5) * magnitude,
        magnitude,
        collision: true,
      };
    }

    // 静止：加速度约 1g，带微小噪声
    const noise = (Math.random() - 0.5) * 0.5;
    const magnitude = this.baselineMagnitude + noise;
    return {
      x: noise,
      y: noise,
      z: magnitude,
      magnitude,
      collision: false,
    };
  }
}

/**
 * 模拟环境传感器
 *
 * 温度/湿度/光照随时间缓慢变化（小时级时间常数）。
 * 模拟昼夜节律：白天光照强、温度高，夜晚相反。
 */
export class SimulatedEnvironmentSensor implements EnvironmentSensor {
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  read(): EnvironmentReading {
    const elapsedHours = (Date.now() - this.startTime) / (1000 * 60 * 60);

    // 模拟昼夜节律：24 小时周期
    const dayPhase = (elapsedHours % 24) / 24; // 0-1
    const sinPhase = Math.sin(dayPhase * Math.PI * 2);

    // 温度：15-30°C，白天高夜晚低
    const temperature = 22.5 + 7.5 * sinPhase;

    // 湿度：40-80%，与温度反相关
    const humidity = 60 - 20 * sinPhase;

    // 光照：0-1000 lux，白天有夜晚无
    const light = Math.max(0, 500 + 500 * sinPhase);

    return { temperature, humidity, light };
  }
}

/**
 * 模拟传感器聚合
 */
export function createSimulatedSensors(): SensorProvider {
  return {
    battery: new SimulatedBatterySensor(),
    motion: new SimulatedMotionSensor(),
    environment: new SimulatedEnvironmentSensor(),
  };
}
