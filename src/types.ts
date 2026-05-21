// src/types.ts
import Phaser from 'phaser';

export interface NPCCar {
    sprite: Phaser.GameObjects.Sprite;
    currentRoadId: string;
    progress: number;
    speed: number;
    baseSpeed: number;
}
