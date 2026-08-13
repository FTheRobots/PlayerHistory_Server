/** DayZ map definitions — tile URLs follow dayz.xam.nu / static.xam.nu CDN layout */

export interface MapConfig {
  id: string;
  displayName: string;
  mapSize: number;
  /** xam.nu CDN path segment (may differ from DayZ world name, e.g. enoch → livonia) */
  tileSlug: string;
  /** CDN folder version (`tilev` in xam JSON — not always the display version, e.g. Namalsk May.27) */
  tileVersion: string;
  tileUrl: string;
  tileUrlSatellite: string;
  izurviveSlug: string;
  maxNativeZoom: number;
  imageUrl?: string;
}

type XamTileLayer = 'topographic' | 'satellite';

function xamTileUrl(
  slug: string,
  version: string,
  layer: XamTileLayer = 'topographic',
  format: 'webp' | 'jpg' = 'webp'
): string {
  if (!slug || !version) return '';
  return `https://static.xam.nu/dayz/maps/${slug}/${version}/${layer}/{z}/{x}/{y}.${format}`;
}

const GAME_VERSION = '1.27';

type MapDef = Omit<MapConfig, 'tileUrl' | 'tileUrlSatellite'> & {
  aliases?: string[];
  tileFormat?: 'webp' | 'jpg';
};

const MAP_DEFINITIONS: MapDef[] = [
  {
    id: 'chernarusplus',
    displayName: 'Chernarus Plus',
    mapSize: 15360,
    tileSlug: 'chernarusplus',
    tileVersion: GAME_VERSION,
    izurviveSlug: 'chernarusplus',
    maxNativeZoom: 7,
    aliases: ['chernarus', 'chernarusplus'],
  },
  {
    id: 'enoch',
    displayName: 'Livonia',
    mapSize: 12800,
    tileSlug: 'livonia',
    tileVersion: GAME_VERSION,
    izurviveSlug: 'enoch',
    maxNativeZoom: 7,
    aliases: ['enoch', 'livonia'],
  },
  {
    id: 'sakhal',
    displayName: 'Sakhal',
    mapSize: 15360,
    tileSlug: 'sakhal',
    tileVersion: GAME_VERSION,
    izurviveSlug: 'sakhal',
    maxNativeZoom: 7,
    aliases: ['sakhal'],
  },
  {
    id: 'deerisle',
    displayName: 'Deer Isle',
    mapSize: 16384,
    tileSlug: 'deerisle',
    tileVersion: '5.923',
    izurviveSlug: 'deerisle',
    maxNativeZoom: 7,
    aliases: ['deerisle', 'deer isle'],
  },
  // Workshop maps — tileVersion/format from static.xam.nu/dayz/json/{slug}/{version}.json
  {
    id: 'namalsk',
    displayName: 'Namalsk',
    mapSize: 12800,
    tileSlug: 'namalsk',
    tileVersion: 'May.27',
    izurviveSlug: 'namalsk',
    maxNativeZoom: 7,
    aliases: ['namalsk', 'namalsksurvival'],
  },
  {
    id: 'banov',
    displayName: 'Banov',
    mapSize: 15360,
    tileSlug: 'banov',
    tileVersion: '26.06.10',
    izurviveSlug: 'banov',
    maxNativeZoom: 7,
    aliases: ['banov'],
  },
  {
    id: 'rostow',
    displayName: 'Rostow',
    mapSize: 14336,
    tileSlug: 'rostow',
    tileVersion: '02.15',
    tileFormat: 'jpg',
    izurviveSlug: 'rostow',
    maxNativeZoom: 7,
    aliases: ['rostow'],
  },
  {
    id: 'esseker',
    displayName: 'Esseker',
    mapSize: 12800,
    tileSlug: 'esseker',
    tileVersion: '0.58',
    tileFormat: 'jpg',
    izurviveSlug: 'esseker',
    maxNativeZoom: 7,
    aliases: ['esseker'],
  },
  {
    id: 'melkart',
    displayName: 'Melkart',
    mapSize: 20480,
    tileSlug: 'melkart',
    tileVersion: '26.04.10',
    izurviveSlug: 'melkart',
    maxNativeZoom: 7,
    aliases: ['melkart'],
  },
  {
    id: 'chiemsee',
    displayName: 'Chiemsee',
    mapSize: 10240,
    tileSlug: 'chiemsee',
    tileVersion: '2.7',
    tileFormat: 'jpg',
    izurviveSlug: 'chiemsee',
    maxNativeZoom: 7,
    aliases: ['chiemsee'],
  },
  {
    id: 'nyheim',
    displayName: 'Nyheim',
    mapSize: 15360,
    tileSlug: 'nyheim2',
    tileVersion: '26.05.08',
    izurviveSlug: 'nyheim',
    maxNativeZoom: 7,
    aliases: ['nyheim'],
  },
];

function finalizeMap(def: MapDef): MapConfig {
  const { aliases: _aliases, tileFormat = 'webp', ...rest } = def;
  return {
    ...rest,
    tileUrl: xamTileUrl(rest.tileSlug, rest.tileVersion, 'topographic', tileFormat),
    tileUrlSatellite: xamTileUrl(rest.tileSlug, rest.tileVersion, 'satellite', tileFormat),
  };
}

const ALIAS_INDEX = new Map<string, MapConfig>();

for (const def of MAP_DEFINITIONS) {
  const map = finalizeMap(def);
  ALIAS_INDEX.set(map.id, map);
  for (const alias of def.aliases ?? []) {
    ALIAS_INDEX.set(normalizeWorldName(alias), map);
  }
}

export function normalizeWorldName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '');
}

const DEFAULT_MAP = finalizeMap(MAP_DEFINITIONS[0]);

export function resolveMapConfig(worldName?: string, worldSize?: number): MapConfig {
  const normalized = worldName ? normalizeWorldName(worldName) : '';

  if (normalized) {
    const known = ALIAS_INDEX.get(normalized);
    if (known) {
      return {
        ...known,
        mapSize: worldSize && worldSize > 0 ? worldSize : known.mapSize,
      };
    }

    // Unknown map — try world name as xam slug with game version; may 404 → web shows grid
    const slug = normalized.replace(/[^a-z0-9]/g, '');
    if (slug) {
      return {
        id: slug,
        displayName: worldName!.trim(),
        mapSize: worldSize && worldSize > 0 ? worldSize : DEFAULT_MAP.mapSize,
        tileSlug: slug,
        tileVersion: GAME_VERSION,
        tileUrl: xamTileUrl(slug, GAME_VERSION, 'topographic'),
        tileUrlSatellite: xamTileUrl(slug, GAME_VERSION, 'satellite'),
        izurviveSlug: slug,
        maxNativeZoom: 7,
      };
    }
  }

  if (worldSize && worldSize > 0) {
    return {
      ...DEFAULT_MAP,
      mapSize: worldSize,
    };
  }

  return DEFAULT_MAP;
}

export function listKnownMaps(): MapConfig[] {
  return MAP_DEFINITIONS.map(finalizeMap);
}
