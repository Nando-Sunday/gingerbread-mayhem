export type Upgrade = 'rush' | 'storm' | 'pierce' | 'rocks' | 'gum' | 'laser';
export type Material = 'gingerbread' | 'chocolate' | 'glass' | 'candy' | 'marshmallow' | 'frosting' | 'wafer' | 'caramel';

export const GAME_SECONDS = 120;
export const UPGRADE_SECONDS = 13;
export const STAR_THRESHOLDS = { twoTime: 30, twoScore: 9000, threeTime: 60, threeScore: 19000, threeCombo: 8 };

export function progress(destroyed: number, total: number): number {
  return total === 0 ? 0 : Math.min(100, Math.round(100 * destroyed / total));
}

export function stars(secondsRemaining: number, score: number, bestCombo: number): 1 | 2 | 3 {
  if (secondsRemaining >= STAR_THRESHOLDS.threeTime && score >= STAR_THRESHOLDS.threeScore && bestCombo >= STAR_THRESHOLDS.threeCombo) return 3;
  if (secondsRemaining >= STAR_THRESHOLDS.twoTime && score >= STAR_THRESHOLDS.twoScore) return 2;
  return 1;
}

export function remainingSupports(supports: number[], unavailable: Set<number>): number {
  return supports.reduce((count, id) => count + (unavailable.has(id) ? 0 : 1), 0);
}

export function unsupported(supports: number[], unavailable: Set<number>, minimumRemaining = 1): boolean {
  return supports.length > 0 && remainingSupports(supports, unavailable) < minimumRemaining;
}

export function pointerAimDelta(movementX: number, movementY: number, sensitivity = 0.00225): { yaw: number; pitch: number } {
  return { yaw: -movementX * sensitivity, pitch: -movementY * sensitivity };
}

export function fallbackAimPosition(x: number, y: number, width: number, height: number): { yaw: number; pitch: number } {
  return { yaw: -(x / width - 0.5) * 2.24, pitch: -(y / height - 0.5) * 1.16 };
}

export function shotInterval(upgrade: Upgrade | null): number {
  return upgrade === 'rush' ? 0.067 : upgrade === 'storm' ? 0.18 : upgrade === 'pierce' ? 0.18 : upgrade === 'rocks' ? 0.24 : upgrade === 'gum' ? 0.72 : upgrade === 'laser' ? 0.072 : 0.105;
}

export function damageFor(material: Material): number {
  return ({ gingerbread: 31, chocolate: 25, glass: 80, candy: 38, marshmallow: 42, frosting: 65, wafer: 34, caramel: 28 })[material];
}
