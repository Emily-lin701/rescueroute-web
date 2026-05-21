import Phaser from 'phaser';
// 💡 完美導出：從你的別的檔案（假設叫 types.ts）匯入 NPCCar 型態
import { NPCCar } from './types'; 

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

// 💡 補上私家車專用常數，方便日後調整平衡度
const CAR_SPAWN_T   = 1.5;  // 每 1.5 秒生成一台私家車
const CAR_SPEED     = 0.12; // 私家車基礎速度 (每秒前進 12% 路程)

// ─────────────────────────────────────────────────────────────────────────────
//  Map data
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

const ENTRY_SIGNAL: Record<string, { junc: 'M2' | 'M3'; phase: 'NS' | 'EW' }> = {
  'R12→R23': { junc: 'M2', phase: 'EW' },
  'R12→R2S': { junc: 'M2', phase: 'NS' },
  'R23→R3S': { junc: 'M3', phase: 'NS' },
  'R23→R34': { junc: 'M3', phase: 'EW' },
};

// ─────────────────────────────────────────────────────────────────────────────
//  Types
// ─────────────────────────────────────────────────────────────────────────────
type Phase     = 'NS' | 'EW';
type GamePhase = 'waiting' | 'fire_spawned' | 'dispatched' | 'success' | 'burned';
type FireTarget = 'S2' | 'S3';

interface TruckState {
  segIdx:     number;
  progress:   number;   
  dispatched: boolean;
  arrived:    boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GameScene
// ─────────────────────────────────────────────────────────────────────────────
export class GameScene extends Phaser.Scene {

  // ── Game state ─────────────────────────────────────────────────────────────
  private gPhase: GamePhase = 'waiting';
  private gt        = 0;    
  private score     = 1000;
  private cmdPts    = CMD_MAX;
  private gwActive  = false;
  private gwTimer   = 0;
  private fireTarget: FireTarget = 'S2'; 
  private fireValue = 0;    

  // ── Signals ─────────────────────────────────────────────────────────────────
  private signals = {
    M2: { phase: 'EW' as Phase, transitioning: false, transTimer: 0, nextPhase: 'NS' as Phase },
    M3: { phase: 'EW' as Phase, transitioning: false, transTimer: 0, nextPhase: 'NS' as Phase },
  };

  // ── Truck ───────────────────────────────────────────────────────────────────
  private truck: TruckState = { segIdx: 0, progress: 0, dispatched: false, arrived: false };
  private truckPath: string[] = [];

  // ── Traffic (NPC Cars) ──────────────────────────────────────────────────────
  // 💡 完美型態綁定，不再有 any
  private npcCars: NPCCar[] = [];
  private trafficEvent: Phaser.Time.TimerEvent | null = null;

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
  private mapGfx!:     Phaser.GameObjects.Graphics; 
  private dynGfx!:     Phaser.GameObjects.Graphics; 
  private hudGfx!:     Phaser.GameObjects.Graphics; 
  private overlayGfx!: Phaser.GameObjects.Graphics; 

  // ── HUD text objects ────────────────────────────────────────────────────────
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

    // 啟動帶有正確型態的定時產生車流事件
    this.initTrafficSpawn();
  }

  private initTrafficSpawn() {
    if (this.trafficEvent) {
      this.trafficEvent.remove();
    }

    this.trafficEvent = this.time.addEvent({
      delay: CAR_SPAWN_T * 1000, 
      callback: () => {
        const startNode = NODES['M1'];
        const startX = startNode ? startNode.x : 330;
        const startY = startNode ? startNode.y : 345;
        
        // 畫一個 24x14 藍灰色的小方塊代表普通小客車
        const carRect = this.add.rectangle(startX, startY, 24, 14, 0x557799);
        carRect.setDepth(5); 

        const newCar: NPCCar = {
          sprite: carRect,
          currentRoadId: 'R12', 
          progress: 0,
          speed: CAR_SPEED,          
          baseSpeed: CAR_SPEED
        };
        
        this.npcCars.push(newCar);
      },
      loop: true
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  INIT / RESTART
  // ─────────────────────────────────────────────────────────────────────────────
  private initGame() {
    // 清理舊的私家車實體防記憶體殘留
    if (this.npcCars) {
      this.npcCars.forEach(car => {
        if (car.sprite) car.sprite.destroy();
      });
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

    this.signals.M2 = { 
        phase: randomM2, 
        transitioning: false, 
        transTimer: 0, 
        nextPhase: randomM2 === 'EW' ? 'NS' : 'EW' 
    };

    this.signals.M3 = { 
        phase: randomM3, 
        transitioning: false, 
        transTimer: 0, 
        nextPhase: randomM3 === 'EW' ? 'NS' : 'EW' 
    };

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

  // ─────────────────────────────────────────────────────────────────────────────
  //  UPDATE
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

    this.handleInput();

    if (this.gPhase === 'dispatched') this.updateTruck(dt);

    // 更新私家車排隊算法
    this.updateTraffic(delta);

    this.dynGfx.clear();
    this.drawSignals();
    if (this.gPhase !== 'waiting') this.drawFire();
    if (this.truck.dispatched)     this.drawTruck();
    this.drawHUD();
  }

  private updateTraffic(delta: number) {
    if (!this.npcCars) return;

    const r12Cars = this.npcCars.filter(car => car.currentRoadId === 'R12')
                                .sort((a, b) => b.progress - a.progress);

    const isM2Red = this.signals.M2.phase === 'NS'; 

    for (let i = 0; i < r12Cars.length; i++) {
        const car = r12Cars[i];

        if (i === 0) {
            if (isM2Red && car.progress >= STOP_LINE) {
                car.speed = 0; 
            } else {
                car.speed = car.baseSpeed; 
            }
        } else {
            const frontCar = r12Cars[i - 1];
            if (frontCar.progress - car.progress < 0.05 && frontCar.speed === 0) {
                car.speed = 0; 
            } else {
                car.speed = car.baseSpeed;
            }
        }

        car.progress += car.speed * (delta / 1000);
        if (car.progress > STOP_LINE && car.speed === 0) car.progress = STOP_LINE;
        if (car.progress > 1.0) car.progress = 1.0;

        const road = ROADS['R12'];
        if (road) {
            const start = NODES[road.from];
            const end = NODES[road.to];
            if (start && end) {
                car.sprite.x = start.x + (end.x - start.x) * car.progress;
                car.sprite.y = start.y + (end.y - start.y) * car.progress;
            }
        }
    }
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
    this.gPhase          = 'dispatched';
    this.truck.dispatched = true;
    this.truckPath      = this.fireTarget === 'S2' ? ['R12', 'R2S'] : ['R12', 'R23', 'R3S'];
    this.truck.segIdx   = 0;
    this.truck.progress = 0;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  TRUCK LOGIC
  // ─────────────────────────────────────────────────────────────────────────────
  private updateTruck(dt: number) {
    if (this.truck.arrived) return;

    const seg     = this.truckPath[this.truck.segIdx];
    const nextSeg = this.truck.segIdx + 1 < this.truckPath.length
      ? this.truckPath[this.truck.segIdx + 1]
      : null;

    const atStop   = this.truck.progress >= STOP_LINE && nextSeg !== null;
    const blocked  = atStop && !this.canEnter(seg, nextSeg!);

    if (!blocked) {
      const speed = this.getTruckSpeed(seg);
      const len   = this.segLen(seg);
      this.truck.progress += (speed * dt) / len;

      if (this.truck.progress >= 1.0) {
        if (nextSeg !== null) {
          this.truck.segIdx++;
          this.truck.progress = 0;
        } else {
          this.truck.progress = 1.0;
          this.truck.arrived  = true;
          this.score += BONUS_SAVE;
          this.gPhase = 'success';
          this.showOverlay('✓  SAVED!', `Score: ${Math.round(this.score)}`, 0x22cc44);
          return;
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

  private getTruckSpeed(segId: string): number {
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
  //  VISUALS & DRAWING
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

  private drawStaticMap() {
    const g = this.mapGfx;
    g.clear();

    g.fillStyle(0x0a1220, 1);
    g.fillRect(0, 0, W, H);

    g.fillStyle(0x162035, 1);
    for (let x = 16; x < W; x += 40)
      for (let y = 16; y < H; y += 40)
        g.fillCircle(x, y, 1.2);

    for (const road of Object.values(ROADS)) {
      const a = NODES[road.from], b = NODES[road.to];
      const rw = road.mainline ? 15 : 12;

      g.lineStyle(rw + 5, 0x060c18, 0.9);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.strokePath();

      g.lineStyle(rw, 0x373748, 1);
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.strokePath();

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

    for (const [id, node] of Object.entries(NODES)) {
      const isCtrl    = ['M2', 'M3'].includes(id);
      const isStation = ['S2', 'S3'].includes(id);

      const haloColor = isCtrl ? 0x3d6090 : isStation ? 0x702222 : 0x1e3a5f;
      g.fillStyle(haloColor, 0.35);
      g.fillCircle(node.x, node.y, 28);

      const fill   = isCtrl ? 0x1e3e62 : isStation ? 0x3a1515 : 0x102040;
      const stroke = isCtrl ? 0x5a8ac0 : isStation ? 0x904040 : 0x3a5080;
      g.fillStyle(fill, 1);
      g.fillCircle(node.x, node.y, 19);
      g.lineStyle(2.5, stroke, 1);
      g.strokeCircle(node.x, node.y, 19);
    }

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

    for (const [id, node] of Object.entries(NODES)) {
      this.add.text(node.x, node.y, id, {
        fontSize: '13px', fontFamily: 'monospace', fontStyle: 'bold', color: '#b8cce0',
      }).setOrigin(0.5).setDepth(1);
    }

    for (const id of ['S2', 'S3']) {
      const n = NODES[id];
      this.add.text(n.x, n.y + 28, '🚒', { fontSize: '18px' }).setOrigin(0.5).setDepth(1);
    }

    for (const junc of ['M2', 'M3'] as const) {
      const node = NODES[junc];
      this.add.text(node.x, node.y - 105, `SIG ${junc}`, {
        fontSize: '11px', fontFamily: 'monospace', fontStyle: 'bold', color: '#7a9aba',
      }).setOrigin(0.5).setDepth(1);
    }
  }

  private buildSignalLabels() {
    const style = { fontSize: '11px', fontFamily: 'monospace', color: '#8a9ab8' };
    const m2x = NODES.M2.x, m2y = NODES.M2.y - 78;
    this.sigTxtM2ns = this.add.text(m2x - 22, m2y + 28, 'NS', style).setOrigin(0.5).setDepth(4);
    this.sigTxtM2ew = this.add.text(m2x + 22, m2y + 28, 'EW', style).setOrigin(0.5).setDepth(4);

    const m3x = NODES.M3.x, m3y = NODES.M3.y - 78;
    this.sigTxtM3ns = this.add.text(m3x - 22, m3y + 28, 'NS', style).setOrigin(0.5).setDepth(4);
    this.sigTxtM3ew = this.add.text(m3x + 22, m3y + 28, 'EW', style).setOrigin(0.5).setDepth(4);
  }

  private drawSignals() {
    const g = this.dynGfx;

    for (const junc of ['M2', 'M3'] as const) {
      const node = NODES[junc];
      const s    = this.signals[junc];

      const allRed  = s.transitioning;
      const nsGreen = !allRed && s.phase === 'NS';
      const ewGreen = !allRed && s.phase === 'EW';

      const px = node.x, py = node.y - 78, pw = 62, ph = 42;

      g.fillStyle(0x0a1828, 0.95);
      g.fillRoundedRect(px - pw / 2 - 6, py - 6, pw + 12, ph + 12, 7);
      g.lineStyle(2, allRed ? 0xff5500 : 0x2a4a70, 1);
      g.strokeRoundedRect(px - pw / 2 - 6, py - 6, pw + 12, ph + 12, 7);

      this.drawLight(g, px - 22, py + 12, nsGreen, allRed);
      this.drawLight(g, px + 22, py + 12, ewGreen, allRed);

      g.lineStyle(1, 0x2a4060, 0.6);
      g.beginPath(); g.moveTo(node.x, py + ph + 6); g.lineTo(node.x, node.y - 19); g.strokePath();

      const activeColor = '#88ffaa', inactiveColor = '#4a5a7a';
      if (junc === 'M2') {
        this.sigTxtM2ns.setColor(nsGreen ? activeColor : inactiveColor);
        this.sigTxtM2ew.setColor(ewGreen ? activeColor : inactiveColor);
      } else {
        this.sigTxtM3ns.setColor(nsGreen ? activeColor : inactiveColor);
        this.sigTxtM3ew.setColor(ewGreen ? activeColor : inactiveColor);
      }
    }
  }

  private drawLight(g: Phaser.GameObjects.Graphics, cx: number, cy: number, green: boolean, allRed: boolean) {
    const color  = allRed ? 0xff2200 : (green ? 0x00ff66 : 0x440000);
    const border = allRed ? 0xff6633 : (green ? 0x00cc44 : 0x882222);

    if (green || allRed) {
      g.fillStyle(allRed ? 0xff3300 : 0x00ff66, 0.18);
      g.fillCircle(cx, cy, 19);
    }
    g.fillStyle(color, 1); g.fillCircle(cx, cy, 12);
    g.lineStyle(2, border, 1); g.strokeCircle(cx, cy, 12);
  }

  private drawFire() {
    const g    = this.dynGfx;
    const node = NODES[this.fireTarget];
    const pulse = (Math.sin(this.gt * 4) + 1) / 2;

    const outerR = 26 + pulse * 8;
    g.fillStyle(0xff3300, 0.15 + pulse * 0.12); g.fillCircle(node.x, node.y, outerR + 10);
    g.lineStyle(3, 0xff6600, 0.6 + pulse * 0.4); g.strokeCircle(node.x, node.y, outerR);

    g.fillStyle(0xff4400, 0.9); g.fillCircle(node.x, node.y, 14);
    g.fillStyle(0xff9900, 1);   g.fillCircle(node.x, node.y, 8);
    g.fillStyle(0xffee66, 1);   g.fillCircle(node.x, node.y, 4);

    if (this.fireValue > 0) {
      const barW = 64, barH = 8, bx = node.x - barW / 2, by = node.y + 26;
      g.fillStyle(0x220000, 0.85); g.fillRoundedRect(bx - 1, by - 1, barW + 2, barH + 2, 3);
      g.fillStyle(this.fireValue > 0.6 ? 0xff2200 : 0xff8800, 1);
      g.fillRoundedRect(bx, by, barW * (this.fireValue / 100), barH, 3);
    }
  }

  private drawTruck() {
    const g = this.dynGfx;
    const { x, y, angle } = this.truckPos();
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const rot = (px: number, py: number) => ({ x: x + px * cos - py * sin, y: y + px * sin + py * cos });

    g.fillStyle(0xff9f1c, 0.18); g.fillCircle(x, y, 20);

    const bodyCorners = [rot(-15, -7), rot(13, -7), rot(13, 7), rot(-15, 7)];
    g.fillStyle(0xff9f1c, 1); g.beginPath(); g.moveTo(bodyCorners[0].x, bodyCorners[0].y);
    for (let i = 1; i < 4; i++) g.lineTo(bodyCorners[i].x, bodyCorners[i].y);
    g.closePath(); g.fillPath();

    const cabCorners = [rot(5, -7), rot(13, -7), rot(13, 7), rot(5, 7)];
    g.fillStyle(0xffcc44, 1); g.beginPath(); g.moveTo(cabCorners[0].x, cabCorners[0].y);
    for (let i = 1; i < 4; i++) g.lineTo(cabCorners[i].x, cabCorners[i].y);
    g.closePath(); g.fillPath();

    const arrow = [rot(13, -4), rot(21, 0), rot(13, 4)];
    g.fillStyle(0xffee44, 1); g.beginPath(); g.moveTo(arrow[0].x, arrow[0].y);
    g.lineTo(arrow[1].x, arrow[1].y); g.lineTo(arrow[2].x, arrow[2].y);
    g.closePath(); g.fillPath();

    g.lineStyle(1.5, 0xcc7a00, 1); g.beginPath(); g.moveTo(bodyCorners[0].x, bodyCorners[0].y);
    for (let i = 1; i < 4; i++) g.lineTo(bodyCorners[i].x, bodyCorners[i].y);
    g.closePath(); g.strokePath();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  //  HUD PANEL
  // ─────────────────────────────────────────────────────────────────────────────
  private buildHUDTexts() {
    const x0 = 12, mono = 'monospace';
    const headerStyle = (col = '#4fc3f7') => ({ fontSize: '11px', fontFamily: mono, color: col, fontStyle: 'bold' });
    const valueStyle = (size = '28px', col = '#ffffff') => ({ fontSize: size, fontFamily: mono, color: col, fontStyle: 'bold' });
    const bodyStyle = (col = '#c8d8e8') => ({ fontSize: '13px', fontFamily: mono, color: col });

    let y = 54;
    this.add.text(x0, y, 'TIME LEFT', headerStyle()).setDepth(4);
    y += 16; this.txtTime = this.add.text(x0, y, '0:30', valueStyle('36px', '#4fc3f7')).setDepth(4);
    y += 46;

    this.add.text(x0, y, 'SCORE', headerStyle()).setDepth(4);
    y += 16; this.txtScore = this.add.text(x0, y, '1000', valueStyle('28px', '#a8e8b8')).setDepth(4);
    y += 38;

    this.add.text(x0, y, 'CMD POINTS', headerStyle()).setDepth(4);
    y += 16; this.txtCmd = this.add.text(x0, y, '10.0 / 10', bodyStyle()).setDepth(4);
    y += 36;

    this.add.text(x0, y, '[G] GREENWAVE', headerStyle('#c5e8a0')).setDepth(4);
    y += 16; this.txtGW = this.add.text(x0, y, 'READY', bodyStyle('#88e888')).setDepth(4);
    y += 30;

    this.add.text(x0, y, 'MISSION', headerStyle('#ff9966')).setDepth(4);
    y += 16; this.txtFire = this.add.text(x0, y, 'Waiting…', bodyStyle('#ff9966')).setDepth(4);
    y += 54;

    this.add.text(x0, y, 'SIGNALS', headerStyle('#e0b860')).setDepth(4);
    y += 16; this.txtM2 = this.add.text(x0, y, '[1] M2 — EW', bodyStyle('#e0d080')).setDepth(4);
    y += 18; this.txtM3 = this.add.text(x0, y, '[2] M3 — EW', bodyStyle('#e0d080')).setDepth(4);
    y += 30;

    this.txtHint = this.add.text(x0, y, '', { fontSize: '13px', fontFamily: mono, color: '#ffee44', wordWrap: { width: HUD_W - 14 } }).setDepth(4);

    this.add.text(x0, 680, ['— CONTROLS —', '1 / 2 : Toggle M2 / M3', 'G      : GreenWave', 'ENTER  : Dispatch truck'].join('\n'), {
      fontSize: '11px', fontFamily: mono, color: '#4a607a', lineSpacing: 4,
    }).setDepth(4);
  }

  private buildOverlayTexts() {
    const style = (size: string, col: string, bold = false) => ({ fontSize: size, fontFamily: 'monospace', fontStyle: bold ? 'bold' : 'normal', color: col });
    this.overlayTitle = this.add.text(W / 2, H / 2 - 40, '', style('42px', '#ffffff', true)).setOrigin(0.5).setDepth(11);
    this.overlaySub = this.add.text(W / 2, H / 2 + 15, '', style('20px', '#cccccc')).setOrigin(0.5).setDepth(11);
    this.overlayCountdown = this.add.text(W / 2, H / 2 + 50, '', style('14px', '#8a9ab8')).setOrigin(0.5).setDepth(11);
  }

  private drawHUD() {
    const g = this.hudGfx; g.clear();
    g.fillStyle(0x060e1c, 0.88); g.fillRect(0, 0, HUD_W, H);
    g.lineStyle(1, 0x1e3858, 1); g.lineBetween(HUD_W, 0, HUD_W, H);
    g.fillStyle(0x0a1a32, 1); g.fillRect(0, 0, HUD_W, 48);
    g.lineStyle(1, 0x1e4878, 1); g.lineBetween(0, 48, HUD_W, 48);

    const divY = [170, 234, 296, 400, 470];
    g.lineStyle(1, 0x122030, 1);
    for (const y of divY) g.lineBetween(8, y, HUD_W - 8, y);

    const timeLeft = Math.max(0, FIRE_DEADLINE - this.gt);
    this.txtTime.setText(`${Math.floor(timeLeft / 60)}:${Math.floor(timeLeft % 60).toString().padStart(2, '0')}`);
    this.txtTime.setColor(timeLeft <= 5 ? '#ff4444' : timeLeft <= 10 ? '#ffaa22' : '#4fc3f7');

    this.txtScore.setText(Math.round(this.score).toString());

    const cmdFrac = this.cmdPts / CMD_MAX;
    g.fillStyle(0x0a1830, 1); g.fillRoundedRect(12, 198, HUD_W - 28, 10, 4);
    g.fillStyle(cmdFrac < 0.3 ? 0xff6644 : 0x44aaff, 1); g.fillRoundedRect(12, 198, (HUD_W - 28) * cmdFrac, 10, 4);
    this.txtCmd.setText(`${this.cmdPts.toFixed(1)} / ${CMD_MAX}`);

    if (this.gwActive) this.txtGW.setText(`ACTIVE  ${this.gwTimer.toFixed(1)}s`).setColor('#44ff88');
    else this.txtGW.setText(this.cmdPts < GW_COST ? `NO POINTS (need ${GW_COST})` : 'READY').setColor(this.cmdPts < GW_COST ? '#ff6644' : '#88ee88');

    if (this.gPhase === 'waiting') { this.txtFire.setText('Standing by…').setColor('#6a8aaa'); this.txtHint.setText(''); }
    else if (this.gPhase === 'fire_spawned') { this.txtFire.setText(`🔥 Fire @ ${this.fireTarget}`).setColor('#ff9944'); this.txtHint.setText('▶ Press ENTER to dispatch truck!').setColor('#ffee44'); }
    else if (this.gPhase === 'dispatched') { this.txtFire.setText(`🔥 Fire @ ${this.fireTarget}`).setColor('#ff6622'); this.txtHint.setText(''); }
    else if (this.gPhase === 'success') { this.txtFire.setText('SAVED ✓').setColor('#44ff88'); this.txtHint.setText(''); }
    else if (this.gPhase === 'burned') { this.txtFire.setText('BURNED ✗').setColor('#ff2222'); this.txtHint.setText(''); }

    if (this.fireValue > 0 && this.gPhase !== 'success') {
      g.fillStyle(0x220000, 0.85); g.fillRoundedRect(12, 382, HUD_W - 28, 10, 4);
      g.fillStyle(this.fireValue / 100 > 0.6 ? 0xff2200 : 0xff8800, 1); g.fillRoundedRect(12, 382, (HUD_W - 28) * (this.fireValue / 100), 10, 4);
    }

    this.txtM2.setText(`[1] M2 — ${this.signals.M2.phase}${this.signals.M2.transitioning ? ' (ALL-RED)' : ''}`);
    this.txtM3.setText(`[2] M3 — ${this.signals.M3.phase}${this.signals.M3.transitioning ? ' (ALL-RED)' : ''}`);
  }
}
