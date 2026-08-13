import type { PlayerEvent } from '../types/index.js';

export function extractItemPid(metadata?: Record<string, string>): string | null {
  if (!metadata) return null;
  if (metadata.itemPid?.trim()) return metadata.itemPid.trim();

  const raw = metadata.item;
  if (!raw) return null;

  try {
    const item = JSON.parse(raw) as { pid?: string };
    if (item.pid?.trim()) return item.pid.trim();
  } catch {
    const match = raw.match(/"pid"\s*:\s*"([^"]+)"/);
    if (match?.[1]) return match[1];
  }

  return null;
}

export function extractItemName(metadata?: Record<string, string>): string | null {
  if (!metadata) return null;

  const raw = metadata.item;
  if (!raw) return null;

  try {
    const item = JSON.parse(raw) as { displayName?: string; classname?: string };
    return item.displayName?.trim() || item.classname?.trim() || null;
  } catch {
    const displayMatch = raw.match(/"displayName"\s*:\s*"([^"]+)"/);
    if (displayMatch?.[1]) return displayMatch[1];
    const classMatch = raw.match(/"classname"\s*:\s*"([^"]+)"/);
    if (classMatch?.[1]) return classMatch[1];
  }

  return null;
}

export function extractItemClassname(metadata?: Record<string, string>): string | null {
  if (!metadata?.item) return null;
  try {
    const item = JSON.parse(metadata.item) as { classname?: string };
    return item.classname?.trim() || null;
  } catch {
    const classMatch = metadata.item.match(/"classname"\s*:\s*"([^"]+)"/);
    return classMatch?.[1] ?? null;
  }
}

export function enrichEventItemFields(event: PlayerEvent): {
  itemPid: string | null;
  itemName: string | null;
  itemClassname: string | null;
} {
  return {
    itemPid: extractItemPid(event.metadata),
    itemName: extractItemName(event.metadata),
    itemClassname: extractItemClassname(event.metadata),
  };
}
