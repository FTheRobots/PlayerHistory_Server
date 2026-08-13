import type { QueryFieldDefinition, QueryOperator } from '../types/query.js';

const TEXT_OPS: QueryOperator[] = ['eq', 'ne', 'in', 'notIn', 'contains', 'startsWith', 'isNull', 'isNotNull'];
const NUM_OPS: QueryOperator[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'isNull', 'isNotNull'];
const TIME_OPS: QueryOperator[] = ['eq', 'gt', 'gte', 'lt', 'lte', 'between'];

export const QUERY_FIELD_CATALOG: QueryFieldDefinition[] = [
  { field: 'event', label: 'Event type', type: 'text', operators: TEXT_OPS, eventHints: ['ZombieKill', 'ItemPickup', 'PlayerDeath'] },
  { field: 'category', label: 'Category', type: 'text', operators: TEXT_OPS, eventHints: ['Combat', 'Inventory', 'Zombie'] },
  { field: 'steam_id', label: 'Steam ID', type: 'text', operators: TEXT_OPS },
  { field: 'player_name', label: 'Player name', type: 'text', operators: ['contains', 'eq', 'startsWith'] },
  { field: 'timestamp', label: 'Timestamp', type: 'timestamp', operators: TIME_OPS },
  { field: 'item_classname', label: 'Item classname', type: 'text', operators: TEXT_OPS },
  { field: 'item_name', label: 'Item name', type: 'text', operators: TEXT_OPS },
  { field: 'item_pid', label: 'Item PID', type: 'text', operators: TEXT_OPS },
  { field: 'from', label: 'From location', type: 'text', operators: TEXT_OPS, description: 'Ground, Hands, PlayerInventory, slot names', eventHints: ['ItemPickup', 'ItemMove'] },
  { field: 'to', label: 'To location', type: 'text', operators: TEXT_OPS, eventHints: ['ItemDrop', 'ItemMove'] },
  { field: 'from_entity', label: 'From entity', type: 'text', operators: TEXT_OPS, description: 'None/Ground, container classname, Player:Name' },
  { field: 'to_entity', label: 'To entity', type: 'text', operators: TEXT_OPS },
  { field: 'source_class', label: 'Weapon / source class', type: 'text', operators: TEXT_OPS, description: 'Weapon or damage source classname', eventHints: ['ZombieKill', 'DamageDealt', 'ShotFired'] },
  { field: 'target_type', label: 'Target type', type: 'text', operators: TEXT_OPS, description: 'Victim entity classname', eventHints: ['ZombieKill', 'PlayerKilled'] },
  { field: 'killer_class', label: 'Killer class', type: 'text', operators: TEXT_OPS, eventHints: ['PlayerDeath'] },
  { field: 'ammo', label: 'Ammo type', type: 'text', operators: TEXT_OPS, eventHints: ['DamageReceived', 'ShotFired'] },
  { field: 'damage', label: 'Damage amount', type: 'number', operators: NUM_OPS, eventHints: ['DamageReceived', 'DamageDealt'] },
  { field: 'has_position', label: 'Has map position', type: 'boolean', operators: ['eq'], description: 'true = events with coordinates' },
  { field: 'position_x', label: 'Position X', type: 'number', operators: NUM_OPS },
  { field: 'position_z', label: 'Position Z', type: 'number', operators: NUM_OPS },
];

export const QUERY_PRESETS: Array<{ id: string; name: string; description: string; query: import('../types/query.js').EventQueryRequest }> = [
  {
    id: 'ground-pickups',
    name: 'Pickups from ground',
    description: 'Items picked up from the ground',
    query: {
      mode: 'events',
      filters: [
        { field: 'event', op: 'eq', value: 'ItemPickup' },
        { field: 'from', op: 'eq', value: 'Ground' },
      ],
      limit: 100,
    },
  },
  {
    id: 'ground-weapons',
    name: 'Weapons picked from ground',
    description: 'Ground loot weapon classnames (grouped)',
    query: {
      mode: 'groupBy',
      groupBy: 'item_classname',
      order: 'desc',
      limit: 25,
      filters: [
        { field: 'event', op: 'eq', value: 'ItemPickup' },
        { field: 'from', op: 'eq', value: 'Ground' },
      ],
    },
  },
  {
    id: 'zombie-kills-by-weapon',
    name: 'Zombie kills by weapon',
    description: 'Which weapons killed the most infected',
    query: {
      mode: 'groupBy',
      groupBy: ['source_class'],
      order: 'desc',
      limit: 25,
      filters: [{ field: 'event', op: 'eq', value: 'ZombieKill' }],
    },
  },
  {
    id: 'pvp-kills-by-weapon',
    name: 'PvP kills by weapon',
    description: 'Player kills grouped by weapon class',
    query: {
      mode: 'groupBy',
      groupBy: ['source_class'],
      order: 'desc',
      limit: 25,
      filters: [{ field: 'event', op: 'eq', value: 'PlayerKilled' }],
    },
  },
  {
    id: 'kills-by-victim-type',
    name: 'Kills by victim type',
    description: 'All kill events grouped by type',
    query: {
      mode: 'groupBy',
      groupBy: ['event'],
      order: 'desc',
      limit: 20,
      filters: [
        {
          field: 'event',
          op: 'in',
          value: ['ZombieKill', 'BanditKill', 'AnimalKill', 'BearKill', 'WolfKill', 'PlayerKilled', 'BoarKill', 'DeerKill'],
        },
      ],
    },
  },
  {
    id: 'top-killers',
    name: 'Top PvP killers',
    description: 'Players with most PlayerKilled events',
    query: {
      mode: 'groupBy',
      groupBy: ['steam_id', 'player_name'],
      order: 'desc',
      limit: 20,
      filters: [{ field: 'event', op: 'eq', value: 'PlayerKilled' }],
    },
  },
  {
    id: 'popular-pickups',
    name: 'Popular item pickups',
    description: 'Most picked-up item classnames',
    query: {
      mode: 'groupBy',
      groupBy: ['item_classname'],
      order: 'desc',
      limit: 30,
      filters: [{ field: 'event', op: 'eq', value: 'ItemPickup' }],
    },
  },
  {
    id: 'player-deaths',
    name: 'All player deaths',
    description: 'Death events with killer info',
    query: {
      mode: 'events',
      filters: [{ field: 'event', op: 'eq', value: 'PlayerDeath' }],
      limit: 100,
      order: 'desc',
    },
  },
  {
    id: 'damage-dealt',
    name: 'Damage dealt (attacker log)',
    description: 'Damage dealt by players to others',
    query: {
      mode: 'events',
      filters: [{ field: 'event', op: 'eq', value: 'DamageDealt' }],
      limit: 100,
    },
  },
  {
    id: 'activity-hourly',
    name: 'Activity by hour',
    description: 'Event volume per hour (server-wide)',
    query: {
      mode: 'timeseries',
      timeseriesInterval: 'hour',
      filters: [],
    },
  },
];

export function getQueryFieldCatalog(): QueryFieldDefinition[] {
  return QUERY_FIELD_CATALOG;
}

export function getQueryPresets() {
  return QUERY_PRESETS;
}
