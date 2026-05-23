import Phaser from 'phaser'
import { NPCCar, TruckState, Phase, GamePhase, FireTarget } from './types'

const W = 1024
const H = 768
const HUD_W = 248

const STOP_LINE     = 0.88
const TRUCK_SPEED   = 65
const GW_MULT       = 1.25
const FIRE_SPAWN_T  = 3
const FIRE_DEADLINE = 35
const FIRE_GROWTH   = 12
const ALLRED_DUR    = 0.4
const CMD_REGEN     = 0.8
const CMD_MAX       = 10
const GW_COST       = 3
const GW_DURATION   = 6
const PENALTY_SEC   = 2
const BONUS_SAVE    = 600
const PENALTY_BURN  = 300
const CAR_SPAWN_T   = 1.2
const CAR_SPEED     = 0.14

const NODES: Record<string, { x: number; y: number }> = {
  M1: { x: 330, y: 345 },
  M2: { x: 510, y: 345 },
  M3: { x: 700, y: 345 },
  M4: { x: 880, y: 345 },
  S2: { x: 510, y: 565 },
  S3: { x: 700, y: 565 },
  N2: { x: 510, y: 125 },
  N3: { x: 700, y: 125 },
}

const ROADS: Record<string, { from: string; to: string; mainline: boolean }> = {
  'R12_E': { from: 'M1', to: 'M2', mainline: true },
  'R23_E': { from: 'M2', to: 'M3', mainline: true },
  'R34_E': { from: 'M3', to: 'M4', mainline: true },
  'R43_W': { from: 'M4', to: 'M3', mainline: true },
  'R32_W': { from: 'M3', to: 'M2', mainline: true },
  'R21_W': { from: 'M2', to: 'M1', mainline: true },
  'RN2_S': { from: 'N2', to: 'M2', mainline: false },
  'R2S_S': { from: 'M2', to: 'S2', mainline: false },
  'RS2_N': { from: 'S2', to: 'M2', mainline: false },
  'R2N_N': { from: 'M2', to: 'N2', mainline: false },
  'RN3_S': { from: 'N3', to: 'M3', mainline: false },
  'R3S_S': { from: 'M3', to: 'S3', mainline: false },
  'RS3_N': { from: 'S3', to: 'M3', mainline: false },
  'R3N_N': { from: 'M3', to: 'N3', mainline: false },
}

const ENTRY_SIGNAL: Record<string, { junc: 'M2' | 'M3'; phase: Phase }> = {
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
}

export class GameScene extends Phaser.Scene {
  private gPhase: GamePhase = 'waiting'
  private gt = 0
  private score = 1000
  private cmdPts = CMD_MAX
  private gwActive = false
  private gwTimer = 0
  private fireTarget: FireTarget = 'S2'
  private fireValue = 0

  private signals: Record<'M2' | 'M3', {
    phase: Phase
    transitioning: boolean
    transTimer: number
    nextPhase: Phase
    lockedByTruck: boolean
    originalPhase: Phase
  }> = {
    M2: { phase: 'EW', transitioning: false, transTimer: 0, nextPhase: 'NS', lockedByTruck: false, originalPhase: 'EW' },
    M3: { phase: 'EW', transitioning: false, transTimer: 0, nextPhase: 'NS', lockedByTruck: false, originalPhase: 'EW' }
  }

  private truck: TruckState = { segIdx: 0, progress: 0, dispatched: false, arrived: false }
  private truckPath: string[] = []
  private npcCars: NPCCar[] = []
  private trafficEvent: Phaser.Time.TimerEvent | null = null

  private k1!: Phaser.Input.Keyboard.Key
  private k2!: Phaser.Input.Keyboard.Key
  private kG!: Phaser.Input.Keyboard.Key
  private kEnter!: Phaser.Input.Keyboard.Key
  private k1Prev = false
  private k2Prev = false
  private kGPrev = false
  private kEPrev = false

  private mapGfx!: Phaser.GameObjects.Graphics
  private dynGfx!: Phaser.GameObjects.Graphics
  private hudGfx!: Phaser.GameObjects.Graphics
  private overlayGfx!: Phaser.GameObjects.Graphics

  private txtTime!: Phaser.GameObjects.Text
  private txtScore!: Phaser.GameObjects.Text
  private txtCmd!: Phaser.GameObjects.Text
  private txtGW!: Phaser.GameObjects.Text
  private txtFire!: Phaser.GameObjects.Text
  private txtM2!: Phaser.GameObjects.Text
  private txtM3!: Phaser.GameObjects.Text
  private txtHint!: Phaser.GameObjects.Text

  private overlayTitle!: Phaser.GameObjects.Text
  private overlaySub!: Phaser.GameObjects.Text
  private overlayCountdown!: Phaser.GameObjects.Text
  private overlayVisible = false
  private restartTimer = 0

  private sigTxtM2ns!: Phaser.GameObjects.Text
  private sigTxtM2ew!: Phaser.GameObjects.Text
  private sigTxtM3ns!: Phaser.GameObjects.Text
  private sigTxtM3ew!: Phaser.GameObjects.Text

  constructor() {
    super({ key: 'GameScene' })
  }

  preload() {}

  create() {
    this.mapGfx     = this.add.graphics().setDepth(0)
    this.dynGfx     = this.add.graphics().setDepth(2)
    this.hudGfx     = this.add.graphics().setDepth(3)
    this.overlayGfx = this.add.graphics().setDepth(10)

    this.drawStaticMap()
    this.buildSignalLabels()
    this.buildHUDTexts()
    this.buildOverlayTexts()
    this.setupInput()
    this.initGame()
    this.initTrafficSpawn()
  }

  private initTrafficSpawn() {
    if (this.trafficEvent) this.trafficEvent.remove()
    this.trafficEvent = this.time.addEvent({
      delay: CAR_SPAWN_T * 1000,
      callback: () => {
        const spawnRoutes = ['R12_E', 'R43_W', 'RN2_S', 'RS2_N', 'RN3_S', 'RS3_N']
        const chosenRoadId = Phaser.Utils.Array.GetRandom(spawnRoutes)
        const road = ROADS[chosenRoadId]
        const startNode = NODES[road?.from]
        if (startNode) {
          const isMainline = road.mainline
          const carColor = isMainline ? 0x4477aa : 0xaa7744
          const carRect = this.add.rectangle(startNode.x, startNode.y, 22, 13, carColor)
          carRect.setDepth(5)
          this.npcCars.push({
            sprite: carRect,
            currentRoadId: chosenRoadId,
            progress: 0,
            speed: CAR_SPEED,
            baseSpeed: CAR_SPEED
          })
        }
      },
      loop: true
    })
  }

  private initGame() {
    if (this.npcCars) {
      this.npcCars.forEach(car => { if (car.sprite) car.sprite.destroy() })
      this.npcCars = []
    }

    this.gPhase    = 'waiting'
    this.gt        = 0
    this.score     = 1000
    this.cmdPts    = CMD_MAX
    this.gwActive  = false
    this.gwTimer   = 0
    this.fireValue = 0

    const randomM2 = Math.random() < 0.5 ? 'EW' : 'NS'
    const randomM3 = Math.random() < 0.5 ? 'EW' : 'NS'
    this.signals.M2 = { phase: randomM2 as Phase, transitioning: false, transTimer: 0,
      nextPhase: randomM2 === 'EW' ? 'NS' : 'EW', lockedByTruck: false, originalPhase: randomM2 as Phase }
    this.signals.M3 = { phase: randomM3 as Phase, transitioning: false, transTimer: 0,
      nextPhase: randomM3 === 'EW' ? 'NS' : 'EW', lockedByTruck: false, originalPhase: randomM3 as Phase }
    this.truck      = { segIdx: 0, progress: 0, dispatched: false, arrived: false }
    this.truckPath  = []
    this.overlayVisible = false
    this.restartTimer   = 0
    this.overlayGfx.clear()
    this.overlayTitle.setVisible(false)
    this.overlaySub.setVisible(false)
    this.overlayCountdown.setVisible(false)
    this.dynGfx.clear()
  }

  update(_time: number, delta: number) {
    const dt = delta / 1000

    if (this.overlayVisible) {
      this.restartTimer -= dt
      this.overlayCountdown.setText(`Restarting in ${Math.max(0, Math.ceil(this.restartTimer))}s…`)
      if (this.restartTimer <= 0) this.initGame()
      this.drawHUD()
      return
    }

    this.gt    += dt
    this.score -= PENALTY_SEC * dt
    this.cmdPts = Math.min(CMD_MAX, this.cmdPts + CMD_REGEN * dt)

    if (this.gwActive) {
      this.gwTimer -= dt
      if (this.gwTimer <= 0) { this.gwActive = false; this.gwTimer = 0 }
    }

    for (const key of ['M2', 'M3'] as const) {
      const s = this.signals[key]
      if (s.transitioning) {
        s.transTimer += dt
        if (s.transTimer >= ALLRED_DUR) {
          s.phase         = s.nextPhase
          s.transitioning = false
          s.transTimer    = 0
        }
      }
    }

    if (this.gPhase === 'waiting' && this.gt >= FIRE_SPAWN_T) {
      this.fireTarget = Math.random() < 0.5 ? 'S2' : 'S3'
      this.gPhase = 'fire_spawned'
    }

    if ((this.gPhase === 'fire_spawned' || this.gPhase === 'dispatched') && this.gt >= FIRE_DEADLINE) {
      this.fireValue += FIRE_GROWTH * dt
      if (this.fireValue >= 100) {
        this.fireValue = 100
        this.score -= PENALTY_BURN
        this.gPhase = 'burned'
        this.showOverlay('🔥 BURNED!', `Score: ${Math.round(this.score)}`, 0xff3311)
        return
      }
    }

    this.handleInput()
    if (this.gPhase === 'dispatched') this.updateTruck(dt)
    this.updateTraffic(delta)
    this.dynGfx.clear()
    this.drawSignals()
    if (this.gPhase !== 'waiting') this.drawFire()
    if (this.truck.dispatched)     this.drawTruck()
    this.drawHUD()
  }

  private updateTraffic(delta: number) {
    if (!this.npcCars || this.npcCars.length === 0) return
    const dt = delta / 1000
    const activeRoadIds = Array.from(new Set(this.npcCars.map(car => car.currentRoadId)))
    const carsToDestroy: NPCCar[] = []

    activeRoadIds.forEach(roadId => {
      const carsOnRoad = this.npcCars.filter(car => car.currentRoadId === roadId)
                                     .sort((a, b) => b.progress - a.progress)
      const road = ROADS[roadId]
      if (!road) return

      const isTruckOnThisRoad = this.truck.dispatched && !this.truck.arrived && this.truckPath[this.truck.segIdx] === roadId
      const truckProgress = this.truck.progress

      let isRed = false
      const nextPossibleSegs = Object.keys(ENTRY_SIGNAL).filter(key => key.startsWith(`${roadId}→`))
      if (nextPossibleSegs.length > 0) {
        const nextSegKey = nextPossibleSegs[0]
        const req = ENTRY_SIGNAL[nextSegKey]
        if (req) {
          const s = this.signals[req.junc]
          isRed = s ? (s.transitioning || s.phase !== req.phase) : false
        }
      }

      for (let i = 0; i < carsOnRoad.length; i++) {
        const car = carsOnRoad[i]
        let isYielding = false

        if (isTruckOnThisRoad && truckProgress < car.progress && (car.progress - truckProgress) < 0.18) {
          isYielding = true
          car.speed = 0
        } else {
          if (i === 0) {
            if (isRed && car.progress >= STOP_LINE) {
              car.speed = 0
            } else {
              car.speed = car.baseSpeed
            }
          } else {
            const frontCar = carsOnRoad[i - 1]
            if (frontCar && (frontCar.progress - car.progress < 0.08 || frontCar.speed === 0)) {
              car.speed = 0
            } else {
              car.speed = car.baseSpeed
            }
          }
        }

        car.progress += car.speed * dt

        if (car.progress > STOP_LINE && car.speed === 0 && !isYielding) {
          car.progress = STOP_LINE
        }

        if (car.progress >= 1.0) {
          carsToDestroy.push(car)
          continue
        }

        const start = NODES[road.from]
        const end = NODES[road.to]
        if (start && end) {
          const bx = start.x + (end.x - start.x) * car.progress
          const by = start.y + (end.y - start.y) * car.progress
          const angle = Math.atan2(end.y - start.y, end.x - start.x)
          const sideOffset = isYielding ? 18 : 7
          car.sprite.x = bx + Math.sin(angle) * sideOffset
          car.sprite.y = by - Math.cos(angle) * sideOffset
          car.sprite.rotation = angle
        }
      }
    })

    if (carsToDestroy.length > 0) {
      carsToDestroy.forEach(car => { if (car.sprite) car.sprite.destroy() })
      this.npcCars = this.npcCars.filter(car => !carsToDestroy.includes(car))
    }
  }

  private updateTruck(dt: number) {
    if (!this.truck.dispatched || this.truck.arrived || this.truckPath.length === 0 || this.truck.segIdx >= this.truckPath.length) return
    const seg     = this.truckPath[this.truck.segIdx]
    const nextSeg = this.truck.segIdx + 1 < this.truckPath.length ? this.truckPath[this.truck.segIdx + 1] : null

    if (nextSeg) {
      const key = `${seg}→${nextSeg}`
      const req = ENTRY_SIGNAL[key]
      if (req) {
        const s = this.signals[req.junc]
        if (s) {
          if (!s.lockedByTruck) {
            s.lockedByTruck = true
            s.originalPhase = s.phase
          }
          if (s.phase !== req.phase && !s.transitioning) {
            s.transitioning = true
            s.transTimer    = 0
            s.nextPhase     = req.phase
          }
        }
      }
    }

    const atStop  = this.truck.progress >= STOP_LINE && nextSeg !== null
    const blocked = atStop && nextSeg !== null && !this.canEnter(seg, nextSeg)

    if (!blocked) {
      let currentSpeed = this.getTruckSpeed(seg)
      if ((this.truck.progress >= 0.82 && nextSeg !== null) || (this.truck.progress <= 0.15 && this.truck.segIdx > 0)) {
        currentSpeed *= 0.35
      }
      const len = Math.max(1, this.segLen(seg))
      this.truck.progress += (currentSpeed * dt) / len
      if (isNaN(this.truck.progress)) this.truck.progress = 0

      if (this.truck.progress >= 1.0) {
        if (nextSeg !== null) {
          this.truck.segIdx++
          this.truck.progress = 0
          const oldKey = `${seg}→${nextSeg}`
          const oldReq = ENTRY_SIGNAL[oldKey]
          if (oldReq) {
            const s = this.signals[oldReq.junc]
            if (s) {
              s.lockedByTruck = false
              s.transitioning = true
              s.transTimer    = 0
              s.nextPhase     = oldReq.phase === 'EW' ? 'NS' : 'EW'
            }
          }
        } else {
          this.truck.progress = 1.0
          this.truck.arrived  = true
          this.score += BONUS_SAVE
          this.gPhase = 'success'
          this.showOverlay('✓  SAVED!', `Score: ${Math.round(this.score)}`, 0x22cc44)
          return
        }
      }
    }
  }

  private canEnter(prevSeg: string, nextSeg: string): boolean {
    const key = `${prevSeg}→${nextSeg}`
    const req = ENTRY_SIGNAL[key]
    if (!req) return true
    const s = this.signals[req.junc]
    return s ? (!s.transitioning && s.phase === req.phase) : true
  }

  private getTruckSpeed(segId: string): number {
    const r = ROADS[segId]
    if (!r) return TRUCK_SPEED
    return TRUCK_SPEED * (this.gwActive && r.mainline ? GW_MULT : 1)
  }

  private segLen(segId: string): number {
    const r = ROADS[segId]
    if (!r) return 1
    const a = NODES[r.from], b = NODES[r.to]
    if (!a || !b) return 1
    return Math.hypot(b.x - a.x, b.y - a.y)
  }

  private truckPos(): { x: number; y: number; angle: number } {
    if (!this.truck.dispatched || this.truckPath.length === 0 || this.truck.segIdx >= this.truckPath.length)
      return { x: NODES.M1.x, y: NODES.M1.y, angle: 0 }
    const seg  = this.truckPath[this.truck.segIdx]
    const road = ROADS[seg]
    if (!road) return { x: NODES.M1.x, y: NODES.M1.y, angle: 0 }
    const a    = NODES[road.from], b = NODES[road.to]
    if (!a || !b) return { x: NODES.M1.x, y: NODES.M1.y, angle: 0 }
    const t    = Math.min(Math.max(0, this.truck.progress), 1)
    return {
      x:     a.x + (b.x - a.x) * t,
      y:     a.y + (b.y - a.y) * t,
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    }
  }

  private handleInput() {
    const down1 = this.k1.isDown
    const down2 = this.k2.isDown
    const downG = this.kG.isDown
    const downE = this.kEnter.isDown
    if (down1 && !this.k1Prev) this.toggleSignal('M2')
    if (down2 && !this.k2Prev) this.toggleSignal('M3')
    if (downG && !this.kGPrev) this.activateGreenWave()
    if (downE && !this.kEPrev && this.gPhase === 'fire_spawned') this.dispatchTruck()
    this.k1Prev = down1
    this.k2Prev = down2
    this.kGPrev = downG
    this.kEPrev = downE
  }

  private toggleSignal(junc: 'M2' | 'M3') {
    const s = this.signals[junc]
    if (!s || s.transitioning || s.lockedByTruck) return
    s.transitioning = true
    s.transTimer    = 0
    s.nextPhase     = s.phase === 'NS' ? 'EW' : 'NS'
  }

  private activateGreenWave() {
    if (this.cmdPts >= GW_COST && !this.gwActive) {
      this.cmdPts -= GW_COST
      this.gwActive = true
      this.gwTimer  = GW_DURATION
    }
  }

  private dispatchTruck() {
    this.gPhase           = 'dispatched'
    this.truck.dispatched = true
    this.truckPath        = this.fireTarget === 'S2' ? ['R12_E', 'R2S_S'] : ['R12_E', 'R23_E', 'R3S_S']
    this.truck.segIdx     = 0
    this.truck.progress   = 0
    this.truck.arrived    = false
  }

  private drawStaticMap() {
    const g = this.mapGfx
    g.clear()
    g.fillStyle(0x0a1220, 1)
    g.fillRect(0, 0, W, H)
    g.fillStyle(0x162035, 1)
    for (let x = 16; x < W; x += 40) {
      for (let y = 16; y < H; y += 40) {
        g.fillCircle(x, y, 1.2)
      }
    }

    for (const road of Object.values(ROADS)) {
      const a = NODES[road.from], b = NODES[road.to]
      if (!a || !b) continue
      g.lineStyle(16, 0x2e2e3d, 1)
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.strokePath()
      g.lineStyle(1, 0xffbb00, 0.7)
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.strokePath()
    }

    for (const [id, node] of Object.entries(NODES)) {
      const isCtrl = ['M2', 'M3'].includes(id)
      g.fillStyle(isCtrl ? 0x1a3554 : 0x102040, 1)
      g.fillCircle(node.x, node.y, 20)
      g.lineStyle(2, 0x324670, 1)
      g.strokeCircle(node.x, node.y, 20)
      this.add.text(node.x, node.y, id, {
        fontSize: '12px', fontFamily: 'monospace', fontStyle: 'bold', color: '#b8cce0'
      }).setOrigin(0.5)
    }

    for (const id of ['S2', 'S3']) {
      const n = NODES[id]
      if (n) this.add.text(n.x, n.y + 32, '🚒', { fontSize: '18px' }).setOrigin(0.5)
    }
  }

  private buildSignalLabels() {
    const style = { fontSize: '11px', fontFamily: 'monospace', color: '#8a9ab8' }
    this.sigTxtM2ns = this.add.text(NODES.M2.x - 25, NODES.M2.y - 35, 'NS', style).setOrigin(0.5).setDepth(4)
    this.sigTxtM2ew = this.add.text(NODES.M2.x + 25, NODES.M2.y - 35, 'EW', style).setOrigin(0.5).setDepth(4)
    this.sigTxtM3ns = this.add.text(NODES.M3.x - 25, NODES.M3.y - 35, 'NS', style).setOrigin(0.5).setDepth(4)
    this.sigTxtM3ew = this.add.text(NODES.M3.x + 25, NODES.M3.y - 35, 'EW', style).setOrigin(0.5).setDepth(4)
  }

  private drawSignals() {
    const g = this.dynGfx
    for (const junc of ['M2', 'M3'] as const) {
      const node = NODES[junc]
      const s    = this.signals[junc]
      if (!s) continue
      const allRed  = s.transitioning
      const nsGreen = !allRed && s.phase === 'NS'
      const ewGreen = !allRed && s.phase === 'EW'
      this.drawLight(g, node.x - 25, node.y - 22, nsGreen, allRed)
      this.drawLight(g, node.x + 25, node.y - 22, ewGreen, allRed)
      const activeColor = '#88ffaa', inactiveColor = '#4a5a7a'
      if (junc === 'M2') {
        if (this.sigTxtM2ns) this.sigTxtM2ns.setColor(nsGreen ? activeColor : inactiveColor)
        if (this.sigTxtM2ew) this.sigTxtM2ew.setColor(ewGreen ? activeColor : inactiveColor)
      } else {
        if (this.sigTxtM3ns) this.sigTxtM3ns.setColor(nsGreen ? activeColor : inactiveColor)
        if (this.sigTxtM3ew) this.sigTxtM3ew.setColor(ewGreen ? activeColor : inactiveColor)
      }
    }
  }

  private drawLight(g: Phaser.GameObjects.Graphics, cx: number, cy: number, green: boolean, allRed: boolean) {
    const color = allRed ? 0xff2200 : (green ? 0x00ff66 : 0x440000)
    g.fillStyle(color, 1)
    g.fillCircle(cx, cy, 7)
  }

  private drawFire() {
    const g     = this.dynGfx
    const node  = NODES[this.fireTarget]
    const pulse = (Math.sin(this.gt * 4) + 1) / 2
    if (!node) return
    g.fillStyle(0xff3300, 0.15 + pulse * 0.12)
    g.fillCircle(node.x, node.y, 35)
    g.fillStyle(0xff4400, 0.9)
    g.fillCircle(node.x, node.y, 10)
    if (this.fireValue > 0) {
      g.fillStyle(0x220000, 0.85)
      g.fillRect(node.x - 20, node.y + 18, 40, 6)
      g.fillStyle(0xff2200, 1)
      g.fillRect(node.x - 20, node.y + 18, 40 * (this.fireValue / 100), 6)
    }
  }

  private drawTruck() {
    if (!this.truck.dispatched || this.truckPath.length === 0 || this.truck.segIdx >= this.truckPath.length) return
    const g = this.dynGfx
    const { x, y, angle } = this.truckPos()
    const rx = x + Math.sin(angle) * 7
    const ry = y - Math.cos(angle) * 7

    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    const hw = 13, hh = 6.5
    const corners = [
      { x: -hw, y: -hh }, { x: hw, y: -hh },
      { x: hw, y: hh },   { x: -hw, y: hh }
    ].map(p => ({
      x: rx + p.x * cos - p.y * sin,
      y: ry + p.x * sin + p.y * cos
    }))

    g.fillStyle(0xff1100, 1)
    g.beginPath()
    g.moveTo(corners[0].x, corners[0].y)
    corners.slice(1).forEach(p => g.lineTo(p.x, p.y))
    g.closePath()
    g.fillPath()

    if (Math.floor(this.gt * 9) % 2 === 0) {
      const lx = rx + 5 * cos
      const ly = ry + 5 * sin
      g.fillStyle(0x00bfff, 1)
      g.fillCircle(lx, ly, 4)
    }
  }

  private setupInput() {
    const kb = this.input.keyboard!
    this.k1     = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ONE)
    this.k2     = kb.addKey(Phaser.Input.Keyboard.KeyCodes.TWO)
    this.kG     = kb.addKey(Phaser.Input.Keyboard.KeyCodes.G)
    this.kEnter = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER)
  }

  private buildHUDTexts() {
    const x0   = 12
    const mono = 'monospace'
    const headerStyle = (col = '#4fc3f7') => ({ fontSize: '11px', fontFamily: mono, color: col, fontStyle: 'bold' })
    const valueStyle  = (size = '28px', col = '#ffffff') => ({ fontSize: size, fontFamily: mono, color: col, fontStyle: 'bold' })
    const bodyStyle   = (col = '#c8d8e8') => ({ fontSize: '13px', fontFamily: mono, color: col })

    let y = 54
    this.add.text(x0, y, 'TIME LEFT', headerStyle()).setDepth(4)
    y += 16; this.txtTime = this.add.text(x0, y, '0:35', valueStyle('36px', '#4fc3f7')).setDepth(4)
    y += 46

    this.add.text(x0, y, 'SCORE', headerStyle()).setDepth(4)
    y += 16; this.txtScore = this.add.text(x0, y, '1000', valueStyle('28px', '#a8e8b8')).setDepth(4)
    y += 38

    this.add.text(x0, y, 'CMD POINTS', headerStyle()).setDepth(4)
    y += 16; this.txtCmd = this.add.text(x0, y, '10.0 / 10', bodyStyle()).setDepth(4)
    y += 36

    this.add.text(x0, y, '[G] GREENWAVE', headerStyle('#c5e8a0')).setDepth(4)
    y += 16; this.txtGW = this.add.text(x0, y, 'READY', bodyStyle('#88e888')).setDepth(4)
    y += 30

    this.add.text(x0, y, 'MISSION', headerStyle('#ff9966')).setDepth(4)
    y += 16; this.txtFire = this.add.text(x0, y, 'Waiting…', bodyStyle('#ff9966')).setDepth(4)
    y += 54

    this.add.text(x0, y, 'SIGNALS', headerStyle('#e0b860')).setDepth(4)
    y += 16; this.txtM2 = this.add.text(x0, y, '[1] M2 — EW', bodyStyle('#e0d080')).setDepth(4)
    y += 18; this.txtM3 = this.add.text(x0, y, '[2] M3 — EW', bodyStyle('#e0d080')).setDepth(4)
    y += 30

    this.txtHint = this.add.text(x0, y, '', {
      fontSize: '13px', fontFamily: mono, color: '#ffee44', wordWrap: { width: HUD_W - 14 }
    }).setDepth(4)

    this.add.text(x0, 680, ['— CONTROLS —', '1 / 2 : Toggle M2 / M3', 'G      : GreenWave', 'ENTER  : Dispatch truck'].join('\n'), {
      fontSize: '11px', fontFamily: mono, color: '#4a607a', lineSpacing: 4,
    }).setDepth(4)
  }

  private buildOverlayTexts() {
    const style = (size: string, col: string, bold = false) => ({
      fontSize: size, fontFamily: 'monospace', fontStyle: bold ? 'bold' : 'normal', color: col
    })
    this.overlayTitle     = this.add.text(W / 2, H / 2 - 40, '', style('42px', '#ffffff', true)).setOrigin(0.5).setDepth(11)
    this.overlaySub       = this.add.text(W / 2, H / 2 + 15, '', style('20px', '#cccccc')).setOrigin(0.5).setDepth(11)
    this.overlayCountdown = this.add.text(W / 2, H / 2 + 50, '', style('14px', '#8a9ab8')).setOrigin(0.5).setDepth(11)
  }

  private drawHUD() {
    const g = this.hudGfx
    g.clear()
    g.fillStyle(0x060e1c, 0.88); g.fillRect(0, 0, HUD_W, H)
    g.lineStyle(1, 0x1e3858, 1); g.lineBetween(HUD_W, 0, HUD_W, H)
    g.fillStyle(0x0a1a32, 1);    g.fillRect(0, 0, HUD_W, 48)
    g.lineStyle(1, 0x1e4878, 1); g.lineBetween(0, 48, HUD_W, 48)
    const divY = [170, 234, 296, 400, 470]
    g.lineStyle(1, 0x122030, 1)
    for (const y of divY) g.lineBetween(8, y, HUD_W - 8, y)

    const timeLeft = Math.max(0, FIRE_DEADLINE - this.gt)
    if (this.txtTime)  this.txtTime.setText(`${Math.floor(timeLeft / 60)}:${Math.floor(timeLeft % 60).toString().padStart(2, '0')}`)
    if (this.txtScore) this.txtScore.setText(Math.round(this.score).toString())

    const cmdFrac = this.cmdPts / CMD_MAX
    g.fillStyle(0x0a1830, 1);                             g.fillRoundedRect(12, 198, HUD_W - 28, 10, 4)
    g.fillStyle(cmdFrac < 0.3 ? 0xff6644 : 0x44aaff, 1); g.fillRoundedRect(12, 198, (HUD_W - 28) * cmdFrac, 10, 4)
    if (this.txtCmd) this.txtCmd.setText(`${this.cmdPts.toFixed(1)} / ${CMD_MAX}`)

    if (this.gwActive) {
      if (this.txtGW) this.txtGW.setText(`ACTIVE  ${this.gwTimer.toFixed(1)}s`).setColor('#44ff88')
    } else {
      if (this.txtGW) this.txtGW.setText(this.cmdPts < GW_COST ? `NO POINTS (need ${GW_COST})` : 'READY')
                                  .setColor(this.cmdPts < GW_COST ? '#ff6644' : '#88ee88')
    }

    if (this.gPhase === 'waiting') {
      if (this.txtFire) this.txtFire.setText('Standing by…').setColor('#6a8aaa')
      if (this.txtHint) this.txtHint.setText('')
    } else if (this.gPhase === 'fire_spawned') {
      if (this.txtFire) this.txtFire.setText(`🔥 Fire @ ${this.fireTarget}`).setColor('#ff9944')
      if (this.txtHint) this.txtHint.setText('▶ Press ENTER to dispatch truck!').setColor('#ffee44')
    } else if (this.gPhase === 'dispatched') {
      if (this.txtFire) this.txtFire.setText(`🔥 Fire @ ${this.fireTarget}`).setColor('#ff6622')
      if (this.txtHint) this.txtHint.setText('')
    }

    const m2Status = this.signals.M2?.lockedByTruck ? ' 🚒 PRIORITY' : (this.signals.M2?.transitioning ? ' (ALL-RED)' : '')
    const m3Status = this.signals.M3?.lockedByTruck ? ' 🚒 PRIORITY' : (this.signals.M3?.transitioning ? ' (ALL-RED)' : '')
    if (this.txtM2 && this.signals.M2) this.txtM2.setText(`[1] M2 — ${this.signals.M2.phase}${m2Status}`)
    if (this.txtM3 && this.signals.M3) this.txtM3.setText(`[2] M3 — ${this.signals.M3.phase}${m3Status}`)
  }

  private showOverlay(title: string, sub: string, _tintColor: number) {
    this.overlayGfx.clear()
    this.overlayGfx.fillStyle(0x000000, 0.68)
    this.overlayGfx.fillRect(0, 0, W, H)
    this.overlayTitle.setText(title).setVisible(true)
    this.overlaySub.setText(sub).setVisible(true)
    this.overlayCountdown.setVisible(true)
    this.overlayVisible = true
    this.restartTimer   = 4
  }
}
