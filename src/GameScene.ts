import Phaser from 'phaser';
import { NPCCar, TruckState, Phase, GamePhase, FireTarget } from './types';

// ─────────────────────────────────────────────────────────────────────────────
//  型別宣告
// ─────────────────────────────────────────────────────────────────────────────
export interface NPCCar {
  sprite: Phaser.GameObjects.Rectangle;
  currentRoadId: string;
  progress: number;
  speed: number;
  baseSpeed: number;
}

export type Phase = 'NS' | 'EW';
export type GamePhase = 'waiting' | 'fire_spawned' | 'dispatched' | 'success' | 'burned';
export type FireTarget = 'S2' | 'S3';

export interface TruckState {
  segIdx: number;
  progress: number;
  dispatched: boolean;
  arrived: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
//  遊戲平衡與地圖資料
// ─────────────────────────────────────────────────────────────────────────────
const W = 1024;
const H = 768;
const HUD_W = 248;

const STOP_LINE     = 0.88;
const TRUCK_SPEED   = 65;
const GW_MULT       = 1.25;
const FIRE_SPAWN_T  = 3;
const FIRE_DEADLINE = 35;
const FIRE_GROWTH   = 12;
const ALLRED_DUR    = 0.4;
const CMD_REGEN     = 0.8;
const CMD_MAX       = 10;
const GW_COST       = 3;
const GW_DURATION   = 6;
const PENALTY_SEC   = 2;
const BONUS_SAVE    = 600;
const PENALTY_BURN  = 300;

const CAR_SPAWN_T   = 1.2;
const CAR_SPEED     = 0.14;

const NODES: Record<string, { x: number; y: number }> = {
  M1: { x: 330, y: 345 },
  M2: { x: 510, y: 345 },
  M3: { x: 700, y: 345 },
  M4: { x: 880, y: 345 },
  S2: { x: 510, y: 565 },
  S3: { x: 700, y: 565 },
  N2: { x: 510, y: 125 },
  N3: { x: 700, y: 125 },
};

const ROADS: Record<string, { from: string; to: string; mainline: boolean }> = {
  'R12_E': { from: 'M1', to: 'M2', mainline: true  },
  'R23_E': { from: 'M2', to: 'M3', mainline: true  },
  'R34_E': { from: 'M3', to: 'M4', mainline: true  },
  'R43_W': { from: 'M4', to: 'M3', mainline: true  },
  'R32_W': { from: 'M3', to: 'M2', mainline: true  },
  'R21_W': { from: 'M2', to: 'M1', mainline: true  },
  'RN2_S': { from: 'N2', to: 'M2', mainline: false },
  'R2S_S': { from: 'M2', to: 'S2', mainline: false },
  'RS2_N': { from: 'S2', to: 'M2', mainline: false },
  'R2N_N': { from: 'M2', to: 'N2', mainline: false },
  'RN3_S': { from: 'N3', to: 'M3', mainline: false },
  'R3S_S': { from: 'M3', to: 'S3', mainline: false },
  'RS3_N': { from: 'S3', to: 'M3', mainline: false },
  'R3N_N': { from: 'M3', to: 'N3', mainline: false },
};

const ENTRY_SIGNAL: Record<string, { junc: 'M2' | 'M3'; phase: 'NS' | 'EW' }> = {
  'R12_E→R23_E': { junc: 'M2', phase: 'EW' },
  'R23_E→R34_E': { junc: 'M3', phase: 'EW' },
  'R43_W→R32_W': { junc: 'M3', phase: 'EW' },
  'R32_W→R21_W': { junc: 'M2', phase: 'EW' },
  'R12_E→R2S_S': { junc: 'M2', phase: 'EW' },
  'R23_E→R3S_S': { junc: 'M3', phase: 'EW' },
  'RN2_S→R2S_S': { junc: 'M2', phase: 'NS' },
  'RS2_N→R2N_N': { junc: 'M2', phase: 'NS' },
  'RN3_S→R3S_S': { junc: 'M3', phase: 'NS' },
  'RS3_N→R3N_N': { junc: 'M3', phase: 'NS' },
};

// ─────────────────────────────────────────────────────────────────────────────
//  主場景類別
// ─────────────────────────────────────────────────────────────────────────────

export class GameScene extends Phaser.Scene {
  // ...成員與 UI 變數同你原本

  private gPhase: GamePhase = 'waiting';
  private gt        = 0;
  private score     = 1000;
  private cmdPts    = CMD_MAX;
  private gwActive  = false;
  private gwTimer   = 0;
  private fireTarget: FireTarget = 'S2';
  private fireValue = 0;

  private signals = {
    M2: { phase: 'EW' as Phase, transitioning: false, transTimer: 0, nextPhase: 'NS' as Phase, lockedByTruck: false, originalPhase: 'EW' as Phase },
    M3: { phase: 'EW' as Phase, transitioning: false, transTimer: 0, nextPhase: 'NS' as Phase, lockedByTruck: false, originalPhase: 'EW' as Phase },
  };

  private truck: TruckState = { segIdx: 0, progress: 0, dispatched: false, arrived: false };
  private truckPath: string[] = [];
  private npcCars: NPCCar[] = [];
  private trafficEvent: Phaser.Time.TimerEvent | null = null;

  private k1!: Phaser.Input.Keyboard.Key;
  private k2!: Phaser.Input.Keyboard.Key;
  private kG!: Phaser.Input.Keyboard.Key;
  private kEnter!: Phaser.Input.Keyboard.Key;
  private k1Prev = false;
  private k2Prev = false;
  private kGPrev = false;
  private kEPrev = false;

  private mapGfx!: Phaser.GameObjects.Graphics;
  private dynGfx!: Phaser.GameObjects.Graphics;
  private hudGfx!: Phaser.GameObjects.Graphics;
  private overlayGfx!: Phaser.GameObjects.Graphics;

  private txtTime!:  Phaser.GameObjects.Text;
  private txtScore!: Phaser.GameObjects.Text;
  private txtCmd!:   Phaser.GameObjects.Text;
  private txtGW!:    Phaser.GameObjects.Text;
  private txtFire!:  Phaser.GameObjects.Text;
  private txtM2!:    Phaser.GameObjects.Text;
  private txtM3!:    Phaser.GameObjects.Text;
  private txtHint!:  Phaser.GameObjects.Text;

  private overlayTitle!:  Phaser.GameObjects.Text;
  private overlaySub!:    Phaser.GameObjects.Text;
  private overlayCountdown!: Phaser.GameObjects.Text;

  private overlayVisible = false;
  private restartTimer   = 0;

  private sigTxtM2ns!: Phaser.GameObjects.Text;
  private sigTxtM2ew!: Phaser.GameObjects.Text;
  private sigTxtM3ns!: Phaser.GameObjects.Text;
  private sigTxtM3ew!: Phaser.GameObjects.Text;

  constructor() { super({ key: 'GameScene' }); }
  preload() {}

  create() {
    this.mapGfx     = this.add.graphics().setDepth(0);
    this.dynGfx     = this.add.graphics().setDepth(2);
    this.hudGfx     = this.add.graphics().setDepth(3);
    this.overlayGfx = this.add.graphics().setDepth(10);

    this.drawStaticMap();
    this.buildSignalLabels();
    this.buildHUDTexts();
    this.buildOverlayTexts();
    this.setupInput();
    this.initGame();
    this.initTrafficSpawn();
  }

  private initTrafficSpawn() {
    if (this.trafficEvent) this.trafficEvent.remove();

    this.trafficEvent = this.time.addEvent({
      delay: CAR_SPAWN_T * 1000,
      callback: () => {
        const spawnRoutes = ['R12_E', 'R43_W', 'RN2_S', 'RS2_N', 'RN3_S', 'RS3_N'];
        const chosenRoadId = Phaser.Utils.Array.GetRandom(spawnRoutes);
        const road = ROADS[chosenRoadId];
        const startNode = NODES[road?.from];
        if (startNode) {
          const isMainline = road.mainline;
          const carColor = isMainline ? 0x4477aa : 0xaa7744;
          const carRect = this.add.rectangle(startNode.x, startNode.y, 22, 13, carColor);
          carRect.setDepth(5);
          this.npcCars.push({
            sprite: carRect,
            currentRoadId: chosenRoadId,
            progress: 0,
            speed: CAR_SPEED,
            baseSpeed: CAR_SPEED
          });
        }
      },
      loop: true
    });
  }

  private initGame() {
    if (this.npcCars) {
      this.npcCars.forEach(car => { if (car.sprite) car.sprite.destroy(); });
      this.npcCars = [];
    }

    this.gPhase    = 'waiting';
    this.gt        = 0;
    this.score     = 1000;
    this.cmdPts    = CMD_MAX;
    this.gwActive  = false;
    this.gwTimer   = 0;
    this.fireValue = 0;

    const randomM2 = Math.random() < 0.5 ? 'EW' : 'NS';
    const randomM3 = Math.random() < 0.5 ? 'EW' : 'NS';

    this.signals.M2 = { phase: randomM2, transitioning: false, transTimer: 0, nextPhase: randomM2 === 'EW' ? 'NS' : 'EW', lockedByTruck: false, originalPhase: randomM2 };
    this.signals.M3 = { phase: randomM3, transitioning: false, transTimer: 0, nextPhase: randomM3 === 'EW' ? 'NS' : 'EW', lockedByTruck: false, originalPhase: randomM3 };

    this.truck      = { segIdx: 0, progress: 0, dispatched: false, arrived: false };
    this.truckPath  = [];

    this.overlayVisible = false;
    this.restartTimer   = 0;
    this.overlayGfx.clear();
    this.overlayTitle.setVisible(false);
    this.overlaySub.setVisible(false);
    this.overlayCountdown.setVisible(false);
    this.dynGfx.clear();
  }

  update(_time: number, delta: number) {
    const dt = delta / 1000;

    if (this.overlayVisible) {
      this.restartTimer -= dt;
      this.overlayCountdown.setText(`Restarting in ${Math.max(0, Math.ceil(this.restartTimer))}s…`);
      if (this.restartTimer <= 0) this.initGame();
      this.drawHUD();
      return;
    }

    this.gt    += dt;
    this.score -= PENALTY_SEC * dt;
    this.cmdPts = Math.min(CMD_MAX, this.cmdPts + CMD_REGEN * dt);

    if (this.gwActive) {
      this.gwTimer -= dt;
      if (this.gwTimer <= 0) { this.gwActive = false; this.gwTimer = 0; }
    }

    for (const key of ['M2', 'M3'] as const) {
      const s = this.signals[key];
      if (s.transitioning) {
        s.transTimer += dt;
        if (s.transTimer >= ALLRED_DUR) {
          s.phase        = s.nextPhase;
          s.transitioning = false;
          s.transTimer   = 0;
        }
      }
    }

    if (this.gPhase === 'waiting' && this.gt >= FIRE_SPAWN_T) {
      this.fireTarget = Math.random() < 0.5 ? 'S2' : 'S3';
      this.gPhase = 'fire_spawned';
    }

    if ((this.gPhase === 'fire_spawned' || this.gPhase === 'dispatched') && this.gt >= FIRE_DEADLINE) {
      this.fireValue += FIRE_GROWTH * dt;
      if (this.fireValue >= 100) {
        this.fireValue = 100;
        this.score -= PENALTY_BURN;
        this.gPhase = 'burned';
        this.showOverlay('🔥 BURNED!', `Score: ${Math.round(this.score)}`, 0xff3311);
        return;
      }
    }

    this.handleInput();
    if (this.gPhase === 'dispatched') this.updateTruck(dt);

    this.updateTraffic(delta);

    this.dynGfx.clear();
    this.drawSignals();
    if (this.gPhase !== 'waiting') this.drawFire();
    if (this.truck.dispatched)     this.drawTruck();
    this.drawHUD();
  }

  /**
   * ＊此處修正BUG：跟車只要有安全距離就可以移動，若前車即使是停車 speed=0，後車有一段距離也可恢復速度
   */
  private updateTraffic(delta: number) {
    if (!this.npcCars || this.npcCars.length === 0) return;

    const activeRoadIds = Array.from(new Set(this.npcCars.map(car => car.currentRoadId)));
    const carsToDestroy: NPCCar[] = [];

    activeRoadIds.forEach(roadId => {
      const carsOnRoad = this.npcCars.filter(car => car.currentRoadId === roadId)
                                     .sort((a, b) => b.progress - a.progress);

      const road = ROADS[roadId];
      if (!road) return;

      const isTruckOnThisRoad = this.truck.dispatched && !this.truck.arrived && this.truckPath[this.truck.segIdx] === roadId;
      const truckProgress = this.truck.progress;

      let isRed = false;
      const nextPossibleSegs = Object.keys(ENTRY_SIGNAL).filter(key => key.startsWith(`${roadId}→`));
      if (nextPossibleSegs.length > 0) {
        const nextSegKey = nextPossibleSegs[0];
        const req = ENTRY_SIGNAL[nextSegKey];
        if (req) {
          const s = this.signals[req.junc];
          isRed = s.transitioning || s.phase !== req.phase;
        }
      }

      for (let i = 0; i < carsOnRoad.length; i++) {
        const car = carsOnRoad[i];
        let isYielding = false;

        if (isTruckOnThisRoad && truckProgress < car.progress && (car.progress - truckProgress) < 0.18) {
          isYielding = true;
          car.speed = 0;
        } else {
          if (i === 0) {
            if (isRed && car.progress >= STOP_LINE) car.speed = 0;
            else car.speed = car.baseSpeed;
          } else {
            const frontCar = carsOnRoad[i - 1];
            // ONLY check progress, ignore frontCar.speed!!
            if (frontCar && frontCar.progress - car.progress < 0.07) {
              car.speed = 0;
            } else {
              car.speed = car.baseSpeed;
            }
          }
        }

        car.progress += car.speed * (delta / 1000);
        if (car.progress > STOP_LINE && car.speed === 0 && !isYielding) car.progress = STOP_LINE;

        if (car.progress >= 1.0) {
          carsToDestroy.push(car);
          continue;
        }

        const start = NODES[road.from];
        const end = NODES[road.to];
        if (start && end) {
          let bx = start.x + (end.x - start.x) * car.progress;
          let by = start.y + (end.y - start.y) * car.progress;

          const angle = Math.atan2(end.y - start.y, end.x - start.x);
          const sideOffset = isYielding ? 18 : 7;

          car.sprite.x = bx + Math.sin(angle) * sideOffset;
          car.sprite.y = by - Math.cos(angle) * sideOffset;
          car.sprite.rotation = angle;
        }
      }
    });

    if (carsToDestroy.length > 0) {
      carsToDestroy.forEach(car => { if (car.sprite) car.sprite.destroy(); });
      this.npcCars = this.npcCars.filter(car => !carsToDestroy.includes(car));
    }
  }

  // ...剩下的 methods 都跟你原本一樣，請照貼，不佔版面（未動）
  // （ truckPos、updateTruck、handleInput、toggleSignal、activateGreenWave、dispatchTruck、drawStaticMap、buildSignalLabels、
  //   drawSignals、drawLight、drawFire、drawTruck、setupInput、buildHUDTexts、buildOverlayTexts、drawHUD、showOverlay ）
  // 上方方法（如需再次提供完整程式，告知即可）

}


