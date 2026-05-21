import Phaser from 'phaser';
import { NPCCar } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────
const W = 1024;
const H = 768;
const HUD_W = 248;          // Left HUD panel width

const STOP_LINE     = 0.92; // fraction along segment where truck waits
const TRUCK_SPEED   = 62;   // px / second (base)
const GW_MULT       = 1.2;  // GreenWave speed multiplier on mainline
const FIRE_SPAWN_T  = 3;    // seconds until fire appears
const FIRE_DEADLINE = 30;   // seconds; fire starts growing after this
const FIRE_GROWTH   = 15;   // fire_value per second after deadline
const ALLRED_DUR    = 0.35; // all-red transition duration (seconds)
const CMD_REGEN     = 0.8;  // command points per second
const CMD_MAX       = 10;
const GW_COST       = 3;    // command points to activate GreenWave
const GW_DURATION   = 6;    // seconds
const PENALTY_SEC   = 2;    // score penalty per second
const BONUS_SAVE    = 500;
const PENALTY_BURN  = 300;

// ─────────────────────────────────────────────────────────────────────────────
//  Map data  (coordinates match Python MVP's relative layout)
// ─────────────────────────────────────────────────────────────────────────────
const NODES: Record<string, { x: number; y: number }> = {
  M1: { x: 330, y: 345 },
  M2: { x: 510, y: 345 },
  M3: { x: 700, y: 345 },
  M4: { x: 880, y: 345 },
  S2: { x: 510, y: 535 },
  S3: { x: 700, y: 535 },
};

const ROADS: Record<string, { from: string; to: string; mainline: boolean }> = {
  R12: { from: 'M1', to: 'M2', mainline: true  },
  R23: { from: 'M2', to: 'M3', mainline: true  },
  R34: { from: 'M3', to: 'M4', mainline: true  },
  R2S: { from: 'M2', to: 'S2', mainline: false },
  R3S: { from: 'M3', to: 'S3', mainline: false },
};

// Required signal phase to enter the next segment from the given transition key
const ENTRY_SIGNAL: Record<string, { junc: 'M2' | 'M3'; phase: 'NS' | 'EW' }> = {
  'R12→R23': { junc: 'M2', phase: 'EW' }, // truck continues east through M2
  'R12→R2S': { junc: 'M2', phase: 'NS' }, // truck turns south at M2
  'R23→R3S': { junc: 'M3', phase: 'NS' }, // truck turns south at M3
  'R23→R34': { junc: 'M3', phase: 'EW' }, // truck continues east through M3
};

// ─────────────────────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────────────────────
type Phase     = 'NS' | 'EW';
type GamePhase = 'waiting' | 'fire_spawned' | 'dispatched' | 'success' | 'burned';
type FireTarget = 'S2' | 'S3';

interface Signal {
  phase: Phase;
  transitioning: boolean;
  transTimer: number;
  nextPhase: Phase;
}

interface TruckState {
  segIdx:     number;
  progress:   number;   // 0 … 1 along current segment
  dispatched: boolean;
  arrived:    boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GameScene
// ─────────────────────────────────────────────────────────────────────────────
export class GameScene extends Phaser.Scene {
private npcCars: NPCCar[] = [];
  
  // ── Game state ─────────────────────────────────────────────────────────────
  private gPhase: GamePhase = 'waiting';
  private gt        = 0;    // elapsed game time (seconds)
  private score     = 1000;
  private cmdPts    = CMD_MAX;
  private gwActive  = false;
  private gwTimer   = 0;
  private fireTarget: FireTarget = 'S2'; // placeholder; overwritten at fire-spawn time
  private fireValue = 0;    // 0 … 100 (100 = burned)

  // ── Signals ─────────────────────────────────────────────────────────────────
  private signals = {
    M2: { phase: 'EW' as Phase, transitioning: false, transTimer: 0, nextPhase: 'NS' as Phase },
    M3: { phase: 'EW' as Phase, transitioning: false, transTimer: 0, nextPhase: 'NS' as Phase },
  };

  // ── Truck ───────────────────────────────────────────────────────────────────
  private truck: TruckState = { segIdx: 0, progress: 0, dispatched: false, arrived: false };
  private truckPath: string[] = [];

  // ── Input debounce ──────────────────────────────────────────────────────────
  private k1!: Phaser.Input.Keyboard.Key;
  private k2!: Phaser.Input.Keyboard.Key;
  private kG!: Phaser.Input.Keyboard.Key;
  private kEnter!: Phaser.Input.Keyboard.Key;
  private k1Prev = false;
  private k2Prev = false;
  private kGPrev = false;
  private kEPrev = false;

  // ── Graphics layers ─────────────────────────────────────────────────────────
  private mapGfx!:     Phaser.GameObjects.Graphics; // static map (drawn once)
  private dynGfx!:     Phaser.GameObjects.Graphics; // signals / fire / truck
  private hudGfx!:     Phaser.GameObjects.Graphics; // HUD background + bars
  private overlayGfx!: Phaser.GameObjects.Graphics; // result overlay

  // ── HUD text objects (updated each frame) ───────────────────────────────────
  private txtTime!:  Phaser.GameObjects.Text;
  private txtScore!: Phaser.GameObjects.Text;
  private txtCmd!:   Phaser.GameObjects.Text;
  private txtGW!:    Phaser.GameObjects.Text;
  private txtFire!:  Phaser.GameObjects.Text;
  private txtM2!:    Phaser.GameObjects.Text;
  private txtM3!:    Phaser.GameObjects.Text;
  private txtHint!:  Phaser.GameObjects.Text;

  // ── Overlay text ────────────────────────────────────────────────────────────
  private overlayTitle!:  Phaser.GameObjects.Text;
  private overlaySub!:    Phaser.GameObjects.Text;
  private overlayCountdown!: Phaser.GameObjects.Text;

  private overlayVisible = false;
  private restartTimer   = 0;

  // ── Signal light text objects on map ────────────────────────────────────────
  private sigTxtM2ns!: Phaser.GameObjects.Text;
  private sigTxtM2ew!: Phaser.GameObjects.Text;
  private sigTxtM3ns!: Phaser.GameObjects.Text;
  private sigTxtM3ew!: Phaser.GameObjects.Text;

  // ─────────────────────────────────────────────────────────────────────────────
  constructor() { super({ key: 'GameScene' }); }
  preload() {}

  // ─────────────────────────────────────────────────────────────────────────────
  //  CREATE
  // ─────────────────────────────────────────────────────────────────────────────
 create() {
    // Layer order (depth): mapGfx=0, static labels=1, dynGfx=2, hudGfx=3,
    //                       HUD texts=4, overlayGfx=10, overlay texts=11
    this.mapGfx     = this.add.graphics().setDepth(0);
    this.dynGfx     = this.add.graphics().setDepth(2);
    this.hudGfx     = this.add.graphics().setDepth(3);
    this.overlayGfx = this.add.graphics().setDepth(10);

    this.drawStaticMap();   // roads, nodes, road-ID labels, node labels
    this.buildSignalLabels();
    this.buildHUDTexts();
    this.buildOverlayTexts();
    this.setupInput();
    this.initGame();

    // 💡 只有多加這行！
    this.initTrafficSpawn();
  }
  // ─────────────────────────────────────────────────────────────────────────────
  //  INIT / RESTART
  // ─────────────────────────────────────────────────────────────────────────────
  private initGame() {
    // 💡 1. 每次遊戲重開，先清除畫面上所有的舊私家車
    if (this.npcCars) {
      this.npcCars.forEach(car => {
        if (car.sprite) car.sprite.destroy();
      });
      this.npcCars = [];
    }

    // 💡 2. 以下是你原本專案裡完整的重設邏輯
    this.gPhase    = 'waiting';
    this.gt        = 0;
    this.score     = 1000;
    this.cmdPts    = CMD_MAX;
    this.gwActive  = false;
    this.gwTimer   = 0;
    this.fireValue = 0;

    // 修改這裡：隨機決定初始燈號
    const randomM2 = Math.random() < 0.5 ? 'EW' : 'NS';
    const randomM3 = Math.random() < 0.5 ? 'EW' : 'NS';

    // 設定 M2，並根據初始燈號自動設定下一個燈號是什麼
    this.signals.M2 = {
      phase: randomM2,
      transitioning: false,
      transTimer: 0,
      nextPhase: randomM2 === 'EW' ? 'NS' : 'EW'
    };

    // 設定 M3
    this.signals.M3 = {
      phase: randomM3,
      transitioning: false,
      transTimer: 0,
      nextPhase: randomM3 === 'EW' ? 'NS' : 'EW'
    };

    this.truckPath = [];
    this.activeTrucks = [];
    this.overlayVisible = false;
    this.restartTimer = 5;

    // 重新更新 HUD 畫面
    this.drawHUD();
  }
  
  // ─────────────────────────────────────────────────────────────────────────────
  //  UPDATE  (called every frame by Phaser)
  // ─────────────────────────────────────────────────────────────────────────────
  update(_time: number, delta: number) {
    const dt = delta / 1000;

    if (this.overlayVisible) {
      this.restartTimer -= dt;
      this.overlayCountdown.setText(`Restarting in ${Math.max(0, Math.ceil(this.restartTimer))}s…`);
      if (this.restartTimer <= 0) this.initGame();
      this.drawHUD();
      return;
    }

    // ── 遊戲原本的計時與扣分 ──
    this.gt    += dt;
    this.score -= 2 * dt; 

    // 💡 執行私家車系統的移動與排隊更新
    this.updateTraffic(delta);

    this.drawHUD(); 
  }

  // 💡 [新功能 1] 私家車移動與紅燈排隊的具體實作
  private updateTraffic(delta: number) {
    if (!this.npcCars) return;

    // 找出所有在 R12 道路上的私家車，並依照進度從大到小排序
    const r12Cars = this.npcCars.filter(car => car.currentRoadId === 'R12')
                                .sort((a, b) => b.progress - a.progress);

    // 💡 當 phase 為 'NS'（南北通行）時，代表東西向（R12）遇到紅燈！
    const isM2Red = (this as any).signals?.M2?.phase === 'NS'; 

    for (let i = 0; i < r12Cars.length; i++) {
        const car = r12Cars[i];

        if (i === 0) {
            // -- 最前面的一台車 --
            if (isM2Red && car.progress >= 0.92) {
                car.speed = 0; // 紅燈停下
            } else {
                car.speed = car.baseSpeed; // 綠燈正常走
            }
        } else {
            // -- 後面的車（排隊回堵） --
            const frontCar = r12Cars[i - 1];
            if (frontCar.progress - car.progress < 0.05 && frontCar.speed === 0) {
                car.speed = 0; // 前車停，我也停
            } else {
                car.speed = car.baseSpeed;
            }
        }

        // 更新進度
        car.progress += car.speed * (delta / 1000);
        if (car.progress > 0.92 && car.speed === 0) car.progress = 0.92;
        if (car.progress > 1.0) car.progress = 1.0;

        // 讓灰色方塊在畫面上沿著 R12 移動
        const road = (this as any).roads?.['R12'];
        if (road) {
            const start = (this as any).nodes[road.start];
            const end = (this as any).nodes[road.end];
            if (start && end) {
                car.sprite.x = start.x + (end.x - start.x) * car.progress;
                car.sprite.y = start.y + (end.y - start.y) * car.progress;
            }
        }
    }
  }

  // 💡 [新功能 2] 定時產生私家車的計時器設定
  private initTrafficSpawn() {
    if ((this as any).trafficEvent) {
      (this as any).trafficEvent.remove();
    }

    (this as any).trafficEvent = this.time.addEvent({
      delay: 1500, // 每 1.5 秒生一輛車
      callback: () => {
        const startNode = (this as any).nodes?.['M1'];
        const startX = startNode ? startNode.x : 300;
        const startY = startNode ? startNode.y : 384;
        
        // 畫一個 24x14 的藍灰色小方塊代表私家車
        const carRect = this.add.rectangle(startX, startY, 24, 14, 0x557799);
        carRect.setDepth(5);

        const newCar: NPCCar = {
          sprite: carRect,
          currentRoadId: 'R12', 
          progress: 0,
          speed: 0.12, 
          baseSpeed: 0.12
        };
        
        this.npcCars.push(newCar);
      },
      loop: true
    });
  }
  
    // ── Fire spawn ──────────────────────────────────────────────────────────
    if (this.gPhase === 'waiting' && this.gt >= FIRE_SPAWN_T) {
      this.fireTarget = Math.random() < 0.5 ? 'S2' : 'S3';
      this.gPhase = 'fire_spawned';
    }

    // ── Fire growth after deadline ──────────────────────────────────────────
    if ((this.gPhase === 'fire_spawned' || this.gPhase === 'dispatched')
        && this.gt >= FIRE_DEADLINE) {
      this.fireValue += FIRE_GROWTH * dt;
      if (this.fireValue >= 100) {
        this.fireValue = 100;
        this.score -= PENALTY_BURN;
        this.gPhase = 'burned';
        this.showOverlay('🔥 BURNED!', `Score: ${Math.round(this.score)}`, 0xff3311);
        return;
      }
    }

    // ── Input handling ──────────────────────────────────────────────────────
    this.handleInput();

    // ── Truck movement ──────────────────────────────────────────────────────
    if (this.gPhase === 'dispatched') this.updateTruck(dt);

    // ── Redraw dynamic layers ───────────────────────────────────────────────
    this.dynGfx.clear();
    this.drawSignals();
    if (this.gPhase !== 'waiting') this.drawFire();
    if (this.truck.dispatched)     this.drawTruck();
    this.drawHUD();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  INPUT
  // ─────────────────────────────────────────────────────────────────────────────
  private setupInput() {
    const kb = this.input.keyboard!;
    this.k1     = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ONE);
    this.k2     = kb.addKey(Phaser.Input.Keyboard.KeyCodes.TWO);
    this.kG     = kb.addKey(Phaser.Input.Keyboard.KeyCodes.G);
    this.kEnter = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);
  }

  private handleInput() {
    const down1 = this.k1.isDown;
    const down2 = this.k2.isDown;
    const downG = this.kG.isDown;
    const downE = this.kEnter.isDown;

    if (down1 && !this.k1Prev) this.toggleSignal('M2');
    if (down2 && !this.k2Prev) this.toggleSignal('M3');
    if (downG && !this.kGPrev) this.activateGreenWave();
    if (downE && !this.kEPrev && this.gPhase === 'fire_spawned') this.dispatchTruck();

    this.k1Prev = down1;
    this.k2Prev = down2;
    this.kGPrev = downG;
    this.kEPrev = downE;
  }

  private toggleSignal(junc: 'M2' | 'M3') {
    const s = this.signals[junc];
    if (s.transitioning) return;
    s.transitioning = true;
    s.transTimer    = 0;
    s.nextPhase     = s.phase === 'NS' ? 'EW' : 'NS';
  }

  private activateGreenWave() {
    if (this.cmdPts >= GW_COST && !this.gwActive) {
      this.cmdPts  -= GW_COST;
      this.gwActive = true;
      this.gwTimer  = GW_DURATION;
    }
  }

  private dispatchTruck() {
    this.gPhase         = 'dispatched';
    this.truck.dispatched = true;
    this.truckPath      = this.fireTarget === 'S2' ? ['R12', 'R2S'] : ['R12', 'R23', 'R3S'];
    this.truck.segIdx   = 0;
    this.truck.progress = 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  TRUCK
  // ─────────────────────────────────────────────────────────────────────────────
  private updateTruck(dt: number) {
    if (this.truck.arrived) return;

    const seg     = this.truckPath[this.truck.segIdx];
    const nextSeg = this.truck.segIdx + 1 < this.truckPath.length
      ? this.truckPath[this.truck.segIdx + 1]
      : null;

    // Check if truck must wait at the stop line
    const atStop   = this.truck.progress >= STOP_LINE && nextSeg !== null;
    const blocked  = atStop && !this.canEnter(seg, nextSeg!);

    if (!blocked) {
      const speed = this.truckSpeed(seg);
      const len   = this.segLen(seg);
      this.truck.progress += (speed * dt) / len;

      if (this.truck.progress >= 1.0) {
        if (nextSeg !== null) {
          this.truck.segIdx++;
          this.truck.progress = 0;
        } else {
          // Arrived at fire target!
          this.truck.progress = 1.0;
          this.truck.arrived  = true;
          this.score += BONUS_SAVE;
          this.gPhase = 'success';
          this.showOverlay('✓  SAVED!', `Score: ${Math.round(this.score)}`, 0x22cc44);
        }
      }
    }
  }

  private canEnter(prevSeg: string, nextSeg: string): boolean {
    const key = `${prevSeg}→${nextSeg}`;
    const req = ENTRY_SIGNAL[key];
    if (!req) return true;
    const s = this.signals[req.junc];
    return !s.transitioning && s.phase === req.phase;
  }

  private truckSpeed(segId: string): number {
    return TRUCK_SPEED * (this.gwActive && ROADS[segId].mainline ? GW_MULT : 1);
  }

  private segLen(segId: string): number {
    const r = ROADS[segId];
    const a = NODES[r.from], b = NODES[r.to];
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  private truckPos(): { x: number; y: number; angle: number } {
    if (!this.truck.dispatched)
      return { x: NODES.M1.x, y: NODES.M1.y, angle: 0 };

    const seg  = this.truckPath[this.truck.segIdx];
    const road = ROADS[seg];
    const a    = NODES[road.from], b = NODES[road.to];
    const t    = Math.min(this.truck.progress, 1);
    return {
      x:     a.x + (b.x - a.x) * t,
      y:     a.y + (b.y - a.y) * t,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  OVERLAY
  // ─────────────────────────────────────────────────────────────────────────────
  private showOverlay(title: string, sub: string, tintColor: number) {
    this.overlayGfx.clear();
    this.overlayGfx.fillStyle(0x000000, 0.68);
    this.overlayGfx.fillRect(0, 0, W, H);
    this.overlayGfx.lineStyle(4, tintColor, 1);
    this.overlayGfx.strokeRoundedRect(W / 2 - 280, H / 2 - 90, 560, 180, 12);
    this.overlayGfx.fillStyle(tintColor, 0.12);
    this.overlayGfx.fillRoundedRect(W / 2 - 280, H / 2 - 90, 560, 180, 12);

    this.overlayTitle.setText(title).setVisible(true);
    this.overlaySub.setText(sub).setVisible(true);
    this.overlayCountdown.setVisible(true);

    this.overlayVisible = true;
    this.restartTimer   = 4;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  STATIC MAP  (drawn once into mapGfx)
  // ─────────────────────────────────────────────────────────────────────────────
  private drawStaticMap() {
    const g = this.mapGfx;
    g.clear();

    // ── Background ──────────────────────────────────────────────────────────
    g.fillStyle(0x0a1220, 1);
    g.fillRect(0, 0, W, H);

    // Subtle grid dots
    g.fillStyle(0x162035, 1);
    for (let x = 16; x < W; x += 40)
      for (let y = 16; y < H; y += 40)
        g.fillCircle(x, y, 1.2);

    // ── Roads ───────────────────────────────────────────────────────────────
    for (const road of Object.values(ROADS)) {
      const a = NODES[road.from], b = NODES[road.to];
      const rw = road.mainline ? 15 : 12;

      // Shadow
      g.lineStyle(rw + 5, 0x060c18, 0.9);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.strokePath();

      // Surface
      g.lineStyle(rw, 0x373748, 1);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.strokePath();

      // Center dashes
      const len   = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.floor(len / 22);
      g.lineStyle(1.5, 0x54556e, 0.45);
      for (let i = 0; i < steps; i += 2) {
        const t0 = i       / steps, t1 = (i + 1) / steps;
        g.beginPath();
        g.moveTo(a.x + (b.x - a.x) * t0, a.y + (b.y - a.y) * t0);
        g.lineTo(a.x + (b.x - a.x) * t1, a.y + (b.y - a.y) * t1);
        g.strokePath();
      }
    }

    // ── Nodes ───────────────────────────────────────────────────────────────
    for (const [id, node] of Object.entries(NODES)) {
      const isCtrl    = ['M2', 'M3'].includes(id);
      const isStation = ['S2', 'S3'].includes(id);

      // Glow halo
      const haloColor = isCtrl ? 0x3d6090 : isStation ? 0x702222 : 0x1e3a5f;
      g.fillStyle(haloColor, 0.35);
      g.fillCircle(node.x, node.y, 28);

      // Body
      const fill   = isCtrl ? 0x1e3e62 : isStation ? 0x3a1515 : 0x102040;
      const stroke = isCtrl ? 0x5a8ac0 : isStation ? 0x904040 : 0x3a5080;
      g.fillStyle(fill, 1);
      g.fillCircle(node.x, node.y, 19);
      g.lineStyle(2.5, stroke, 1);
      g.strokeCircle(node.x, node.y, 19);
    }

    // ── Road ID labels ───────────────────────────────────────────────────────
    const roadLabelPos: Record<string, { x: number; y: number }> = {
      R12: { x: (NODES.M1.x + NODES.M2.x) / 2, y: NODES.M1.y - 22 },
      R23: { x: (NODES.M2.x + NODES.M3.x) / 2, y: NODES.M2.y - 22 },
      R34: { x: (NODES.M3.x + NODES.M4.x) / 2, y: NODES.M3.y - 22 },
      R2S: { x: NODES.S2.x + 26, y: (NODES.M2.y + NODES.S2.y) / 2 },
      R3S: { x: NODES.S3.x + 26, y: (NODES.M3.y + NODES.S3.y) / 2 },
    };
    for (const [id, pos] of Object.entries(roadLabelPos)) {
      this.add.text(pos.x, pos.y, id, {
        fontSize: '11px', fontFamily: 'monospace', color: '#4a5a7a',
      }).setOrigin(0.5).setDepth(1);
    }

    // ── Node ID labels ───────────────────────────────────────────────────────
    for (const [id, node] of Object.entries(NODES)) {
      this.add.text(node.x, node.y, id, {
        fontSize: '13px', fontFamily: 'monospace', fontStyle: 'bold', color: '#b8cce0',
      }).setOrigin(0.5).setDepth(1);
    }

    // ── Station labels ───────────────────────────────────────────────────────
    for (const id of ['S2', 'S3']) {
      const n = NODES[id];
      this.add.text(n.x, n.y + 28, '🚒', {
        fontSize: '18px',
      }).setOrigin(0.5).setDepth(1);
    }

    // ── Signal panel labels (static text below each panel) ───────────────────
    for (const junc of ['M2', 'M3'] as const) {
      const node = NODES[junc];
      const px = node.x;
      const py = node.y - 105;
      this.add.text(px, py, `SIG ${junc}`, {
        fontSize: '11px', fontFamily: 'monospace', fontStyle: 'bold', color: '#7a9aba',
      }).setOrigin(0.5).setDepth(1);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  SIGNAL PANEL LABELS  (created once, above each intersection)
  // ─────────────────────────────────────────────────────────────────────────────
  private buildSignalLabels() {
    const style = { fontSize: '11px', fontFamily: 'monospace', color: '#8a9ab8' };

    // M2 panel
    const m2x = NODES.M2.x;
    const m2y = NODES.M2.y - 78;
    this.sigTxtM2ns = this.add.text(m2x - 22, m2y + 28, 'NS', style).setOrigin(0.5).setDepth(4);
    this.sigTxtM2ew = this.add.text(m2x + 22, m2y + 28, 'EW', style).setOrigin(0.5).setDepth(4);

    // M3 panel
    const m3x = NODES.M3.x;
    const m3y = NODES.M3.y - 78;
    this.sigTxtM3ns = this.add.text(m3x - 22, m3y + 28, 'NS', style).setOrigin(0.5).setDepth(4);
    this.sigTxtM3ew = this.add.text(m3x + 22, m3y + 28, 'EW', style).setOrigin(0.5).setDepth(4);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  DRAW SIGNALS  (every frame into dynGfx)
  // ─────────────────────────────────────────────────────────────────────────────
  private drawSignals() {
    const g = this.dynGfx;

    for (const junc of ['M2', 'M3'] as const) {
      const node = NODES[junc];
      const s    = this.signals[junc];

      const allRed  = s.transitioning;
      const nsGreen = !allRed && s.phase === 'NS';
      const ewGreen = !allRed && s.phase === 'EW';

      const px = node.x;
      const py = node.y - 78;  // panel top-center relative to node
      const pw = 62, ph = 42;

      // Panel background
      g.fillStyle(0x0a1828, 0.95);
      g.fillRoundedRect(px - pw / 2 - 6, py - 6, pw + 12, ph + 12, 7);
      const borderCol = allRed ? 0xff5500 : 0x2a4a70;
      g.lineStyle(2, borderCol, 1);
      g.strokeRoundedRect(px - pw / 2 - 6, py - 6, pw + 12, ph + 12, 7);

      // NS light  (left circle)
      const nsLx = px - 22;
      const nsLy = py + 12;
      this.drawLight(g, nsLx, nsLy, nsGreen, allRed);

      // EW light  (right circle)
      const ewLx = px + 22;
      const ewLy = py + 12;
      this.drawLight(g, ewLx, ewLy, ewGreen, allRed);

      // Connecting line from panel bottom to intersection node
      g.lineStyle(1, 0x2a4060, 0.6);
      g.beginPath();
      g.moveTo(node.x, py + ph + 6);
      g.lineTo(node.x, node.y - 19);
      g.strokePath();

      // Update NS/EW label colors based on which is green
      const activeColor   = '#88ffaa';
      const inactiveColor = '#4a5a7a';
      if (junc === 'M2') {
        this.sigTxtM2ns.setColor(nsGreen ? activeColor : inactiveColor);
        this.sigTxtM2ew.setColor(ewGreen ? activeColor : inactiveColor);
      } else {
        this.sigTxtM3ns.setColor(nsGreen ? activeColor : inactiveColor);
        this.sigTxtM3ew.setColor(ewGreen ? activeColor : inactiveColor);
      }
    }
  }

  /** Draw a single traffic light circle at (cx, cy). */
  private drawLight(
    g: Phaser.GameObjects.Graphics,
    cx: number, cy: number,
    green: boolean,
    allRed: boolean,
  ) {
    const color  = allRed ? 0xff2200 : (green ? 0x00ff66 : 0x440000);
    const border = allRed ? 0xff6633 : (green ? 0x00cc44 : 0x882222);

    // Glow for active (green or all-red)
    if (green || allRed) {
      const glowColor = allRed ? 0xff3300 : 0x00ff66;
      g.fillStyle(glowColor, 0.18);
      g.fillCircle(cx, cy, 19);
    }

    g.fillStyle(color, 1);
    g.fillCircle(cx, cy, 12);
    g.lineStyle(2, border, 1);
    g.strokeCircle(cx, cy, 12);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  DRAW FIRE
  // ─────────────────────────────────────────────────────────────────────────────
  private drawFire() {
    const g    = this.dynGfx;
    const node = NODES[this.fireTarget];
    const t    = this.gt;        // monotonic time for animation
    const pulse = (Math.sin(t * 4) + 1) / 2;  // 0 … 1, ~0.6 Hz

    // Outer pulsing ring
    const outerR = 26 + pulse * 8;
    g.fillStyle(0xff3300, 0.15 + pulse * 0.12);
    g.fillCircle(node.x, node.y, outerR + 10);

    g.lineStyle(3, 0xff6600, 0.6 + pulse * 0.4);
    g.strokeCircle(node.x, node.y, outerR);

    // Inner flame
    g.fillStyle(0xff4400, 0.9);
    g.fillCircle(node.x, node.y, 14);
    g.fillStyle(0xff9900, 1);
    g.fillCircle(node.x, node.y, 8);
    g.fillStyle(0xffee66, 1);
    g.fillCircle(node.x, node.y, 4);

    // Fire value bar (if growing)
    if (this.fireValue > 0) {
      const barW = 64, barH = 8;
      const bx   = node.x - barW / 2;
      const by   = node.y + 26;
      g.fillStyle(0x220000, 0.85);
      g.fillRoundedRect(bx - 1, by - 1, barW + 2, barH + 2, 3);
      const fillFrac = this.fireValue / 100;
      const fillColor = fillFrac > 0.6 ? 0xff2200 : 0xff8800;
      g.fillStyle(fillColor, 1);
      g.fillRoundedRect(bx, by, barW * fillFrac, barH, 3);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  DRAW TRUCK
  // ─────────────────────────────────────────────────────────────────────────────
  private drawTruck() {
    const g = this.dynGfx;
    const { x, y, angle } = this.truckPos();
    const cos = Math.cos(angle), sin = Math.sin(angle);

    const rot = (px: number, py: number) => ({
      x: x + px * cos - py * sin,
      y: y + px * sin + py * cos,
    });

    // Glow
    g.fillStyle(0xff9f1c, 0.18);
    g.fillCircle(x, y, 20);

    // Body
    const bodyCorners = [rot(-15, -7), rot(13, -7), rot(13, 7), rot(-15, 7)];
    g.fillStyle(0xff9f1c, 1);
    g.beginPath();
    g.moveTo(bodyCorners[0].x, bodyCorners[0].y);
    for (let i = 1; i < 4; i++) g.lineTo(bodyCorners[i].x, bodyCorners[i].y);
    g.closePath();
    g.fillPath();

    // Front cab highlight
    const cabCorners = [rot(5, -7), rot(13, -7), rot(13, 7), rot(5, 7)];
    g.fillStyle(0xffcc44, 1);
    g.beginPath();
    g.moveTo(cabCorners[0].x, cabCorners[0].y);
    for (let i = 1; i < 4; i++) g.lineTo(cabCorners[i].x, cabCorners[i].y);
    g.closePath();
    g.fillPath();

    // Arrow tip
    const arrow = [rot(13, -4), rot(21, 0), rot(13, 4)];
    g.fillStyle(0xffee44, 1);
    g.beginPath();
    g.moveTo(arrow[0].x, arrow[0].y);
    g.lineTo(arrow[1].x, arrow[1].y);
    g.lineTo(arrow[2].x, arrow[2].y);
    g.closePath();
    g.fillPath();

    // Outline
    g.lineStyle(1.5, 0xcc7a00, 1);
    g.beginPath();
    g.moveTo(bodyCorners[0].x, bodyCorners[0].y);
    for (let i = 1; i < 4; i++) g.lineTo(bodyCorners[i].x, bodyCorners[i].y);
    g.closePath();
    g.strokePath();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  HUD  (background drawn into hudGfx, text updated on text objects)
  // ─────────────────────────────────────────────────────────────────────────────
  private buildHUDTexts() {
    const x0   = 12;
    const mono = 'monospace';

    const headerStyle = (col = '#4fc3f7') => ({
      fontSize: '11px', fontFamily: mono, color: col, fontStyle: 'bold',
    });
    const valueStyle = (size = '28px', col = '#ffffff') => ({
      fontSize: size, fontFamily: mono, color: col, fontStyle: 'bold',
    });
    const bodyStyle = (col = '#c8d8e8') => ({
      fontSize: '13px', fontFamily: mono, color: col,
    });

    let y = 54;

    // ── Time ──────────────────────────────────────────────────────────────
    this.add.text(x0, y, 'TIME LEFT', headerStyle()).setDepth(4);
    y += 16;
    this.txtTime = this.add.text(x0, y, '0:30', valueStyle('36px', '#4fc3f7')).setDepth(4);
    y += 46;

    // ── Score ─────────────────────────────────────────────────────────────
    this.add.text(x0, y, 'SCORE', headerStyle()).setDepth(4);
    y += 16;
    this.txtScore = this.add.text(x0, y, '1000', valueStyle('28px', '#a8e8b8')).setDepth(4);
    y += 38;

    // ── Command Points ────────────────────────────────────────────────────
    this.add.text(x0, y, 'CMD POINTS', headerStyle()).setDepth(4);
    y += 16;
    this.txtCmd = this.add.text(x0, y, '10.0 / 10', bodyStyle()).setDepth(4);
    y += 20;
    // bar drawn in hudGfx
    y += 16;

    // ── GreenWave ─────────────────────────────────────────────────────────
    this.add.text(x0, y, '[G] GREENWAVE', headerStyle('#c5e8a0')).setDepth(4);
    y += 16;
    this.txtGW = this.add.text(x0, y, 'READY', bodyStyle('#88e888')).setDepth(4);
    y += 30;

    // ── Mission / Fire ────────────────────────────────────────────────────
    this.add.text(x0, y, 'MISSION', headerStyle('#ff9966')).setDepth(4);
    y += 16;
    this.txtFire = this.add.text(x0, y, 'Waiting…', bodyStyle('#ff9966')).setDepth(4);
    y += 36;
    // fire bar drawn in hudGfx

    // ── Signals ───────────────────────────────────────────────────────────
    y += 18;
    this.add.text(x0, y, 'SIGNALS', headerStyle('#e0b860')).setDepth(4);
    y += 16;
    this.txtM2 = this.add.text(x0, y, '[1] M2 — EW', bodyStyle('#e0d080')).setDepth(4);
    y += 18;
    this.txtM3 = this.add.text(x0, y, '[2] M3 — EW', bodyStyle('#e0d080')).setDepth(4);
    y += 30;

    // ── Hint ──────────────────────────────────────────────────────────────
    this.txtHint = this.add.text(x0, y, '', {
      fontSize: '13px', fontFamily: mono, color: '#ffee44',
      wordWrap: { width: HUD_W - 14 },
    }).setDepth(4);
    y += 42;

    // ── Controls reference ────────────────────────────────────────────────
    this.add.text(x0, 680, [
      '— CONTROLS —',
      '1 / 2 : Toggle M2 / M3',
      'G      : GreenWave',
      'ENTER  : Dispatch truck',
    ].join('\n'), {
      fontSize: '11px', fontFamily: mono, color: '#4a607a',
      lineSpacing: 4,
    }).setDepth(4);
  }

  private drawHUD() {
    const g = this.hudGfx;
    g.clear();

    // Panel background
    g.fillStyle(0x060e1c, 0.88);
    g.fillRect(0, 0, HUD_W, H);
    g.lineStyle(1, 0x1e3858, 1);
    g.lineBetween(HUD_W, 0, HUD_W, H);

    // Title bar
    g.fillStyle(0x0a1a32, 1);
    g.fillRect(0, 0, HUD_W, 48);
    g.lineStyle(1, 0x1e4878, 1);
    g.lineBetween(0, 48, HUD_W, 48);

    // Section dividers
    const divY = [170, 234, 296, 400, 470];
    g.lineStyle(1, 0x122030, 1);
    for (const y of divY) g.lineBetween(8, y, HUD_W - 8, y);

    // ── Time display ──────────────────────────────────────────────────────
    const timeLeft = Math.max(0, FIRE_DEADLINE - this.gt);
    const mins = Math.floor(timeLeft / 60);
    const secs = Math.floor(timeLeft % 60);
    this.txtTime.setText(`${mins}:${secs.toString().padStart(2, '0')}`);
    const timeColor = timeLeft <= 5 ? '#ff4444' : timeLeft <= 10 ? '#ffaa22' : '#4fc3f7';
    this.txtTime.setColor(timeColor);

    // ── Score ────────────────────────────────────────────────────────────
    this.txtScore.setText(Math.round(this.score).toString());

    // ── CmdPoints bar ────────────────────────────────────────────────────
    const cmdFrac = this.cmdPts / CMD_MAX;
    const barX = 12, barY = 198, barW = HUD_W - 28, barH = 10;
    g.fillStyle(0x0a1830, 1);
    g.fillRoundedRect(barX, barY, barW, barH, 4);
    g.fillStyle(cmdFrac < 0.3 ? 0xff6644 : 0x44aaff, 1);
    g.fillRoundedRect(barX, barY, barW * cmdFrac, barH, 4);
    this.txtCmd.setText(`${this.cmdPts.toFixed(1)} / ${CMD_MAX}`);

    // ── GreenWave ─────────────────────────────────────────────────────────
    if (this.gwActive) {
      this.txtGW.setText(`ACTIVE  ${this.gwTimer.toFixed(1)}s`).setColor('#44ff88');
    } else if (this.cmdPts < GW_COST) {
      this.txtGW.setText(`NO POINTS (need ${GW_COST})`).setColor('#ff6644');
    } else {
      this.txtGW.setText('READY').setColor('#88ee88');
    }

    // ── Fire mission ─────────────────────────────────────────────────────
    if (this.gPhase === 'waiting') {
      this.txtFire.setText('Standing by…').setColor('#6a8aaa');
      this.txtHint.setText('');
    } else if (this.gPhase === 'fire_spawned') {
      this.txtFire.setText(`🔥 Fire @ ${this.fireTarget}`).setColor('#ff9944');
      this.txtHint.setText('▶ Press ENTER to dispatch truck!').setColor('#ffee44');
    } else if (this.gPhase === 'dispatched') {
      this.txtFire.setText(`🔥 Fire @ ${this.fireTarget}`).setColor('#ff6622');
      this.txtHint.setText('');
    } else if (this.gPhase === 'success') {
      this.txtFire.setText('SAVED ✓').setColor('#44ff88');
      this.txtHint.setText('');
    } else if (this.gPhase === 'burned') {
      this.txtFire.setText('BURNED ✗').setColor('#ff2222');
      this.txtHint.setText('');
    }

    // Fire value bar (only when fire is active and growing)
    if (this.fireValue > 0 && this.gPhase !== 'success') {
      const fBarX = 12, fBarY = 382, fBarW = HUD_W - 28, fBarH = 10;
      g.fillStyle(0x200808, 1);
      g.fillRoundedRect(fBarX, fBarY, fBarW, fBarH, 4);
      const fFrac  = this.fireValue / 100;
      const fColor = fFrac > 0.6 ? 0xff2200 : 0xff8800;
      g.fillStyle(fColor, 1);
      g.fillRoundedRect(fBarX, fBarY, fBarW * fFrac, fBarH, 4);
    }

    // ── Signal status text ────────────────────────────────────────────────
    const sigState = (key: 'M2' | 'M3') => {
      const s = this.signals[key];
      if (s.transitioning) return '⚫ ALL-RED';
      return s.phase === 'NS' ? '↕ NS  green' : '↔ EW  green';
    };
    const sColor = (key: 'M2' | 'M3') => {
      const s = this.signals[key];
      if (s.transitioning) return '#ff5522';
      return '#c8d060';
    };
    this.txtM2.setText(`[1] M2 — ${sigState('M2')}`).setColor(sColor('M2'));
    this.txtM3.setText(`[2] M3 — ${sigState('M3')}`).setColor(sColor('M3'));

    // Title
    const titleExists = this.children.getByName('hud-title');
    if (!titleExists) {
      this.add.text(HUD_W / 2, 14, '🚒 RESCUEROUTE', {
        fontSize: '15px', fontFamily: 'monospace', fontStyle: 'bold', color: '#7ad4f4',
      }).setOrigin(0.5, 0).setDepth(4).setName('hud-title');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  OVERLAY TEXTS  (created once, shown on result)
  // ─────────────────────────────────────────────────────────────────────────────
  private buildOverlayTexts() {
    this.overlayTitle = this.add.text(W / 2, H / 2 - 36, '', {
      fontSize: '60px', fontFamily: 'monospace', fontStyle: 'bold',
      color: '#ffffff', stroke: '#000000', strokeThickness: 5, align: 'center',
    }).setOrigin(0.5).setDepth(11).setVisible(false);

    this.overlaySub = this.add.text(W / 2, H / 2 + 28, '', {
      fontSize: '26px', fontFamily: 'monospace', color: '#e0e8f0', align: 'center',
    }).setOrigin(0.5).setDepth(11).setVisible(false);

    this.overlayCountdown = this.add.text(W / 2, H / 2 + 66, '', {
      fontSize: '16px', fontFamily: 'monospace', color: '#7a9ab8', align: 'center',
    }).setOrigin(0.5).setDepth(11).setVisible(false);
  }
}
