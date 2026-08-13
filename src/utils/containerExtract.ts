import type { PlayerEvent } from '../types/index.js';

export interface ContainerFields {
  fromContainerX: number | null;
  fromContainerY: number | null;
  fromContainerZ: number | null;
  toContainerX: number | null;
  toContainerY: number | null;
  toContainerZ: number | null;
  fromContainerPid: string | null;
  toContainerPid: string | null;
}

/** Parse DayZ/PH vector strings like "[7508.2,11.8,5228.4]" from event metadata. */
function parseMetadataPosition(raw?: string): [number, number, number] | null {
  if (!raw?.trim()) return null;

  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed) && parsed.length >= 3) {
      const x = Number(parsed[0]);
      const y = Number(parsed[1]);
      const z = Number(parsed[2]);
      if (!Number.isNaN(x) && !Number.isNaN(y) && !Number.isNaN(z)) return [x, y, z];
    }
  } catch {
    // fall through to regex
  }

  const match = trimmed.match(/\[?\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\]?/);
  if (!match) return null;

  const x = parseFloat(match[1]);
  const y = parseFloat(match[2]);
  const z = parseFloat(match[3]);
  if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(z)) return null;
  return [x, y, z];
}

export function enrichContainerFields(event: PlayerEvent): ContainerFields {
  const meta = event.metadata;
  const fromPos = parseMetadataPosition(meta?.fromContainerPosition);
  const toPos = parseMetadataPosition(meta?.toContainerPosition);

  return {
    fromContainerX: fromPos?.[0] ?? null,
    fromContainerY: fromPos?.[1] ?? null,
    fromContainerZ: fromPos?.[2] ?? null,
    toContainerX: toPos?.[0] ?? null,
    toContainerY: toPos?.[1] ?? null,
    toContainerZ: toPos?.[2] ?? null,
    fromContainerPid: meta?.fromContainerPid?.trim() || null,
    toContainerPid: meta?.toContainerPid?.trim() || null,
  };
}
