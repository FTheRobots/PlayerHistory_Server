import type { PlayerEvent } from '../types/index.js';
import { enrichEventItemFields } from './itemExtract.js';

const EVENT_LABELS: Record<string, string> = {
  ItemPickup: 'Picked Up Item',
  ItemDrop: 'Dropped Item',
  ItemMove: 'Moved Item',
  ItemUse: 'Used Item',
  ItemAttach: 'Attached Item',
  ItemDetach: 'Detached Item',
  ActionComplete: 'Completed Action',
  PlayerDeath: 'Died',
  PlayerKilled: 'Killed Player',
  ZombieKill: 'Killed Zombie',
  AnimalKill: 'Killed Animal',
  BearKill: 'Killed Bear',
  WolfKill: 'Killed Wolf',
  BoarKill: 'Killed Boar',
  DeerKill: 'Killed Deer',
  BanditKill: 'Killed Bandit',
  Join: 'Logged In',
  Disconnect: 'Logged Out',
};

function humanizeType(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

function parseItemName(metadata?: Record<string, string>): string {
  const fields = enrichEventItemFields({ metadata } as PlayerEvent);
  return fields.itemName ?? 'Item';
}

function formatInventoryEvent(event: PlayerEvent): string | null {
  const meta = event.metadata ?? {};
  const itemName = parseItemName(meta);

  switch (event.event) {
    case 'ItemPickup':
      return `Picked up ${itemName}`;
    case 'ItemDrop':
      return `Dropped ${itemName}`;
    case 'ItemAttach':
      return meta.to ? `Attached ${itemName}` : `Attached ${itemName}`;
    case 'ItemDetach':
      return meta.from ? `Detached ${itemName}` : `Detached ${itemName}`;
    case 'ItemUse':
      return `Used ${itemName}`;
    case 'ItemMove':
      return `${itemName} moved`;
    default:
      return null;
  }
}

export function formatEventLabel(event: PlayerEvent): string {
  const inventoryLabel = formatInventoryEvent(event);
  if (inventoryLabel) return inventoryLabel;

  const meta = event.metadata ?? {};
  const base = EVENT_LABELS[event.event] ?? humanizeType(event.event);

  if (event.event === 'ActionComplete' && meta.actionClass) {
    return humanizeType(meta.actionClass.replace(/^Action/i, '')) || base;
  }

  return base;
}

export function isRawEventType(label?: string): boolean {
  if (!label) return false;
  return /^[A-Z][a-zA-Z0-9]+$/.test(label) && !label.includes(' ');
}
