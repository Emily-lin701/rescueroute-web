// types.ts

export interface NPCCar {
  /** Phaser 的實體矩形物件，用來在畫面上渲染私家車 */
  sprite: Phaser.GameObjects.Rectangle;
  
  /** 目前這輛私家車所在的車道 ID (例如: 'R12_E', 'RN2_S' 等) */
  currentRoadId: string;
  
  /** 車道上的行進進度，範圍從 0.0 (起點) 到 1.0 (終點) */
  progress: number;
  
  /** 當前的實際移動速度。排隊或避讓時會被設為 0 */
  speed: number;
  
  /** 車輛的基礎巡航速度，當前方沒車且綠燈時會恢復成此速度 */
  baseSpeed: number;
}
