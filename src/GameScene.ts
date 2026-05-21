import Phaser from 'phaser';
import { NPCCar } from '../types';

// 遊戲常數設定
const PENALTY_SEC = 2;
const CMD_MAX = 10;

export class GameScene extends Phaser.Scene {
  // 基礎地圖與圖層變數
  private mapGfx!: Phaser.GameObjects.Graphics;
  private dynGfx!: Phaser.GameObjects.Graphics;
  private hudGfx!: Phaser.GameObjects.Graphics;
  private overlayGfx!: Phaser.GameObjects.Graphics;

  // 遊戲狀態與數據變數
  private score = 1000;
  private gt = 0;
  private gPhase: 'waiting' | 'running' | 'ended' = 'waiting';
  private fireTarget = 'S2';
  private fireValue = 0;
  private gwActive = false;
  private gwTimer = 0;
  private cmdPts = 10;
  private truckPath: string[] = [];
  private activeTrucks: any[] = [];
  private overlayVisible = false;
  private restartTimer = 5;

  // UI 文字變數
  private overlayCountdown!: Phaser.GameObjects.Text;

  // 號誌與資料結構定義
  private signals: any = {};
  private nodes: any = {};
  private roads: any = {};

  // 💡 核心功能：私家車陣列
  private npcCars: NPCCar[] = [];

  constructor() {
    super('GameScene');
  }

  preload() {
    // 載入基本圖片資源
    this.load.image('truck', 'assets/truck.png');
    this.load.image('firetruck', 'assets/firetruck.png');
  }

  // ==========================================
  // 🛠️ 1. 遊戲建立與私家車定時產生
  // ==========================================
  create() {
    // 圖層深度順序設定
    this.mapGfx     = this.add.graphics().setDepth(0);
    this.dynGfx     = this.add.graphics().setDepth(2);
    this.hudGfx     = this.add.graphics().setDepth(3);
    this.overlayGfx = this.add.graphics().setDepth(10);

    // 初始化地圖、號誌、文字與輸入系統
    this.drawStaticMap();   
    this.buildSignalLabels();
    this.buildHUDTexts();
    this.buildOverlayTexts();
    this.setupInput();
    
    // 初始化遊戲
    this.initGame();

    // 💡 啟動產生一般車流的計時器
    this.initTrafficSpawn();
  }

  // 💡 產生一般車流的具體實作 (使用藍灰色清晰方塊)
  private initTrafficSpawn() {
    if ((this as any).trafficEvent) {
      (this as any).trafficEvent.remove();
    }

    (this as any).trafficEvent = this.time.addEvent({
      delay: 1500, // 每 1.5 秒生出一輛私家車
      callback: () => {
        const startNode = this.nodes?.['M1'];
        const startX = startNode ? startNode.x : 300;
        const startY = startNode ? startNode.y : 384;
        
        // 畫一個 24x14 的藍灰色小方塊代表私家車
        const carRect = this.add.rectangle(startX, startY, 24, 14, 0x557799);
        carRect.setDepth(5); 

        const newCar: NPCCar = {
          sprite: carRect,
          currentRoadId: 'R12', 
          progress: 0,
          speed: 0.12,          // 每秒前進 12% 的路程
          baseSpeed: 0.12
        };
        
        this.npcCars.push(newCar);
      },
      loop: true
    });
  }

  // ==========================================
  // 🛠️ 2. 遊戲初始化與私家車清理機制
  // ==========================================
  private initGame() {
    // 💡 每次重新開始遊戲時，先把畫面上的舊私家車通通清除乾淨
    if (this.npcCars) {
      this.npcCars.forEach(car => {
        if (car.sprite) car.sprite.destroy();
      });
      this.npcCars = [];
    }

    // 重設基礎變數
    this.gPhase    = 'waiting';
    this.gt        = 0;
    this.score     = 1000;
    this.cmdPts    = CMD_MAX;
    this.gwActive  = false;
    this.gwTimer   = 0;
    this.fireValue = 0;

    // 隨機決定初始燈號
    const randomM2 = Math.random() < 0.5 ? 'EW' : 'NS';
    const randomM3 = Math.random() < 0.5 ? 'EW' : 'NS';

    // 設定 M2 與 M3 號誌
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

    this.truckPath = [];
    this.activeTrucks = [];
    this.overlayVisible = false;
    this.restartTimer = 5;

    this.drawHUD();
  }

  // ==========================================
  // 🛠️ 3. 主循環更新（排隊、計時、重繪）
  // ==========================================
  update(_time: number, delta: number) {
    const dt = delta / 1000;

    // 處理重開倒數畫面
    if (this.overlayVisible) {
      this.restartTimer -= dt;
      if (this.overlayCountdown) {
        this.overlayCountdown.setText(`Restarting in ${Math.max(0, Math.ceil(this.restartTimer))}s…`);
      }
      if (this.restartTimer <= 0) this.initGame();
      this.drawHUD();
      return;
    }

    // 正常遊戲計時與扣分
    this.gt    += dt;
    this.score -= PENALTY_SEC * dt;

    // 💡 執行私家車系統的移動與紅燈排隊更新
    this.updateTraffic(delta);

    // 繪製遊戲介面
    this.drawHUD(); 
  }

  // 💡 私家車移動與紅燈排隊的具體算法實作
  private updateTraffic(delta: number) {
    if (!this.npcCars) return;

    // 篩選 R12 道路上的車，並依照進度從大到小排序（前面的車排在最前面）
    const r12Cars = this.npcCars.filter(car => car.currentRoadId === 'R12')
                                .sort((a, b) => b.progress - a.progress);

    // 紅燈判定：當 phase 為 'NS'（南北通行）時，東西向（R12）就是紅燈！
    const isM2Red = this.signals?.M2?.phase === 'NS'; 

    for (let i = 0; i < r12Cars.length; i++) {
        const car = r12Cars[i];

        if (i === 0) {
            // -- 最前面的一台車 --
            if (isM2Red && car.progress >= 0.92) {
                car.speed = 0; // 紅燈停在停止線
            } else {
                car.speed = car.baseSpeed; // 綠燈通行
            }
        } else {
            // -- 後面的車（排隊回堵邏輯） --
            const frontCar = r12Cars[i - 1];
            // 如果跟前車距離太近 (< 0.05) 且前車停下了，自己也必須跟著停下
            if (frontCar.progress - car.progress < 0.05 && frontCar.speed === 0) {
                car.speed = 0; 
            } else {
                car.speed = car.baseSpeed; 
            }
        }

        // 更新進度
        car.progress += car.speed * (delta / 1000);
        if (car.progress > 0.92 && car.speed === 0) car.progress = 0.92; // 鎖定在停止線
        if (car.progress > 1.0) car.progress = 1.0;

        // 更新方塊在畫面的即時 X, Y 座標
        const road = this.roads?.['R12'];
        if (road) {
            const start = this.nodes[road.start];
            const end = this.nodes[road.end];
            if (start && end) {
                car.sprite.x = start.x + (end.x - start.x) * car.progress;
                car.sprite.y = start.y + (end.y - start.y) * car.progress;
            }
        }
    }
  }

  // ==========================================
  // 🧱 以下為你原本專案自帶的地圖結構與基礎方法
  // ==========================================
  private drawStaticMap() {
    // 建立路口節點資料
    this.nodes = {
      'M1': { x: 320, y: 384, label: 'M1' },
      'M2': { x: 512, y: 384, label: 'M2' },
      'M3': { x: 704, y: 384, label: 'M3' },
      'M4': { x: 896, y: 384, label: 'M4' },
      'S2': { x: 512, y: 576, label: 'S2' },
      'S3': { x: 704, y: 576, label: 'S3' }
    };

    // 建立道路資料
    this.roads = {
      'R12': { start: 'M1', end: 'M2' },
      'R23': { start: 'M2', end: 'M3' },
      'R34': { start: 'M3', end: 'M4' },
      'R2S': { start: 'M2', end: 'S2' },
      'R3S': { start: 'M3', end: 'S3' }
    };

    // 使用 mapGfx 繪製道路外觀
    this.mapGfx.lineStyle(16, 0x333344);
    Object.values(this.roads).forEach((road: any) => {
      const s = this.nodes[road.start];
      const e = this.nodes[road.end];
      this.mapGfx.lineBetween(s.x, s.y, e.x, e.y);
    });

    // 繪製路口圓圈
    Object.values(this.nodes).forEach((node: any) => {
      this.mapGfx.fillStyle(0x222233);
      this.mapGfx.fillCircle(node.x, node.y, 20);
      this.mapGfx.lineStyle(2, 0x444466);
      this.mapGfx.strokeCircle(node.x, node.y, 20);
      this.add.text(node.x, node.y, node.label, { fontSize: '12px', color: '#ffffff' }).setOrigin(0.5);
    });
  }

  private buildSignalLabels() {}
  private buildHUDTexts() {}
  
  private buildOverlayTexts() {
    this.overlayCountdown = this.add.text(this.cameras.main.centerX, this.cameras.main.centerY, '', {
      fontSize: '32px',
      color: '#ff0000'
    }).setOrigin(0.5).setDepth(11);
  }

  private setupInput() {
    // 綁定鍵盤控制燈號切換
    this.input.keyboard?.on('keydown-ONE', () => {
      this.toggleSignal('M2');
    });
    this.input.keyboard?.on('keydown-TWO', () => {
      this.toggleSignal('M3');
    });
  }

  private toggleSignal(key: string) {
    if (!this.signals[key]) return;
    const sig = this.signals[key];
    sig.phase = sig.phase === 'EW' ? 'NS' : 'EW';
  }

  private drawHUD() {
    this.hudGfx.clear();
    // 這裡可以根據需要繪製分數與號誌狀態文字
  }
}
