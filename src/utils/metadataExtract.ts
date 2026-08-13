import type { PlayerEvent } from '../types/index.js';

export interface QueryableMetadataFields {
  fromLoc: string | null;
  toLoc: string | null;
  fromEntity: string | null;
  toEntity: string | null;
  sourceClass: string | null;
  targetType: string | null;
  killerClass: string | null;
  ammo: string | null;
  damageAmount: number | null;
}

function metaStr(meta: Record<string, string> | undefined, key: string): string | null {
  const v = meta?.[key]?.trim();
  return v || null;
}

function metaNum(meta: Record<string, string> | undefined, key: string): number | null {
  const raw = meta?.[key];
  if (raw == null || raw === '') return null;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

export function enrichQueryableMetadata(event: PlayerEvent): QueryableMetadataFields {
  const meta = event.metadata;

  const sourceClass =
    metaStr(meta, 'sourceClass') ??
    metaStr(meta, 'weaponClass') ??
    metaStr(meta, 'killerClass');

  const targetType =
    metaStr(meta, 'targetType') ??
    metaStr(meta, 'zombieType') ??
    metaStr(meta, 'animalType') ??
    metaStr(meta, 'banditType');

  return {
    fromLoc: metaStr(meta, 'from'),
    toLoc: metaStr(meta, 'to'),
    fromEntity: metaStr(meta, 'fromEntity'),
    toEntity: metaStr(meta, 'toEntity'),
    sourceClass,
    targetType,
    killerClass: metaStr(meta, 'killerClass'),
    ammo: metaStr(meta, 'ammo'),
    damageAmount: metaNum(meta, 'damage'),
  };
}
