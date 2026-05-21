// types.ts
import Phaser from 'phaser';

export interface NPCCar {
  sprite: Phaser.GameObjects.Rectangle;
  currentRoadId: string;
  progress: number;
  speed: number;
  baseSpeed: number;
}

// 補上這三個漏掉的型別，這是維持 GameScene 運作的關鍵！
export type Phase = 'NS' | 'EW';
export type GamePhase = 'waiting' | 'fire_spawned' | 'dispatched' | 'success' | 'burned';
export type FireTarget = 'S2' | 'S3';

export interface TruckState {
  segIdx: number;
  progress: number;   
  dispatched: boolean;
  arrived: boolean;
}
