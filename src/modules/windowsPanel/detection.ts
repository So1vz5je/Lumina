export interface WindowsPanelInstall {
  key: string;
  panelType: string;
  name: string;
  path: string;
  siteRoot: string;
  serviceState: string;
  evidence: string;
  detected: boolean;
  siteCount: number;
  notes: string;
}

export interface WindowsPanelSite {
  key: string;
  source: string;
  panelType: string;
  name: string;
  path: string;
  state: string;
  bindings: string;
  ownerPanel: string;
  sizeText: string;
  lastModified: string;
}

export interface WindowsPanelService {
  key: string;
  source: string;
  name: string;
  displayName: string;
  state: string;
  startMode: string;
  path: string;
  pid: string;
}

export interface WindowsPanelLog {
  key: string;
  source: string;
  path: string;
  sizeText: string;
  lastModified: string;
  note: string;
}

export interface WindowsPanelStatistics {
  detectedPanelCount: number;
  siteCount: number;
  iisSiteCount: number;
  serviceCount: number;
  logCount: number;
  diagnosticCount: number;
}

export interface WindowsPanelDetectionData {
  installs: WindowsPanelInstall[];
  detectedInstalls: WindowsPanelInstall[];
  sites: WindowsPanelSite[];
  iisSites: WindowsPanelSite[];
  services: WindowsPanelService[];
  logs: WindowsPanelLog[];
  diagnostics: string[];
  statistics: WindowsPanelStatistics;
}

type DetailRecord = Record<string, unknown>;

const emptyStatistics: WindowsPanelStatistics = {
  detectedPanelCount: 0,
  siteCount: 0,
  iisSiteCount: 0,
  serviceCount: 0,
  logCount: 0,
  diagnosticCount: 0,
};

const legacyPanelMeta: Record<string, { panelType: string; name: string; path: string; siteRoot: string; marker: string }> = {
  PHPSTUDY: {
    panelType: 'phpstudy',
    name: 'PhpStudy Pro',
    path: 'C:\\phpstudy_pro',
    siteRoot: 'C:\\phpstudy_pro\\WWW',
    marker: 'PhpStudy Pro',
  },
  XAMPP: {
    panelType: 'xampp',
    name: 'XAMPP',
    path: 'C:\\xampp',
    siteRoot: 'C:\\xampp\\htdocs',
    marker: 'XAMPP',
  },
  WAMPSERVER: {
    panelType: 'wampserver',
    name: 'WampServer',
    path: 'C:\\wamp64',
    siteRoot: 'C:\\wamp64\\www',
    marker: 'WampServer',
  },
  BAOTA_WIN: {
    panelType: 'baota_windows',
    name: 'BaoTa Windows',
    path: 'C:\\BtSoft',
    siteRoot: 'C:\\BtSoft\\WebSites',
    marker: 'Windows',
  },
};

function isRecord(value: unknown): value is DetailRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(row: DetailRecord, keys: string[], fallback = '-'): string {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }

  return fallback;
}

function readBool(row: DetailRecord, keys: string[]): boolean {
  return keys.some((key) => row[key] === true);
}

function readNumber(row: DetailRecord, keys: string[], fallback = 0): number {
  for (const key of keys) {
    const value = row[key];
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }

  return fallback;
}

function ensureArray(value: unknown): DetailRecord[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) ? [value] : [];
}

function getArray(details: DetailRecord, keys: string[]): DetailRecord[] {
  for (const key of keys) {
    const rows = ensureArray(details[key]);
    if (rows.length > 0) return rows;
  }

  return [];
}

function getTextArray(details: DetailRecord, key: string): string[] {
  const value = details[key];
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (typeof item === 'number' || typeof item === 'boolean') return String(item);
      return '';
    })
    .filter(Boolean);
}

function normalizeDate(value: string): string {
  if (!value || value === '-') return '-';
  return value.replace('T', ' ').replace(/\.\d+.*$/, '');
}

export function formatByteCount(value: unknown): string {
  const bytes = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '-';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const precision = Number.isInteger(size) || size >= 10 || unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(precision)} ${units[unitIndex]}`;
}

function normalizeInstall(row: DetailRecord, index: number): WindowsPanelInstall {
  return {
    key: readString(row, ['key'], `panel-${index}`),
    panelType: readString(row, ['panel_type', 'panelType', 'PanelType', 'type']),
    name: readString(row, ['name', 'Name', 'display_name', 'displayName']),
    path: readString(row, ['path', 'Path']),
    siteRoot: readString(row, ['site_root', 'siteRoot', 'SiteRoot', 'root']),
    serviceState: readString(row, ['service_state', 'serviceState', 'ServiceState']),
    evidence: readString(row, ['evidence', 'Evidence', 'source']),
    detected: readBool(row, ['detected', 'Detected']),
    siteCount: readNumber(row, ['site_count', 'siteCount', 'SiteCount']),
    notes: readString(row, ['notes', 'Notes', 'note']),
  };
}

function normalizeSite(row: DetailRecord, index: number): WindowsPanelSite {
  const path = readString(row, ['path', 'Path', 'PhysicalPath']);
  const existingSizeText = readString(row, ['sizeText'], '');
  return {
    key: readString(row, ['key'], `site-${index}`),
    source: readString(row, ['source', 'Source'], 'IIS'),
    panelType: readString(row, ['panel_type', 'panelType', 'PanelType']),
    name: readString(row, ['name', 'Name']),
    path,
    state: readString(row, ['state', 'State', 'status']),
    bindings: readString(row, ['bindings', 'Bindings']),
    ownerPanel: readString(row, ['owner_panel', 'ownerPanel', 'OwnerPanel', 'source', 'Source']),
    sizeText: existingSizeText || formatByteCount(row.size ?? row.Size ?? row.Length ?? row.length),
    lastModified: normalizeDate(readString(row, ['last_modified', 'lastModified', 'LastWriteTime'])),
  };
}

function normalizeService(row: DetailRecord, index: number): WindowsPanelService {
  return {
    key: readString(row, ['key'], `service-${index}`),
    source: readString(row, ['source', 'Source']),
    name: readString(row, ['name', 'Name']),
    displayName: readString(row, ['display_name', 'displayName', 'DisplayName', 'Name']),
    state: readString(row, ['state', 'State', 'Status']),
    startMode: readString(row, ['start_mode', 'startMode', 'StartMode', 'StartType']),
    path: readString(row, ['path', 'Path', 'PathName']),
    pid: readString(row, ['pid', 'Pid', 'ProcessId']),
  };
}

function normalizeLog(row: DetailRecord, index: number): WindowsPanelLog {
  const existingSizeText = readString(row, ['sizeText'], '');
  return {
    key: readString(row, ['key'], `log-${index}`),
    source: readString(row, ['source', 'Source']),
    path: readString(row, ['path', 'Path']),
    sizeText: existingSizeText || formatByteCount(row.size ?? row.Size ?? row.Length ?? row.length),
    lastModified: normalizeDate(readString(row, ['last_modified', 'lastModified', 'LastWriteTime'])),
    note: readString(row, ['note', 'Note']),
  };
}

function buildData(details: DetailRecord): WindowsPanelDetectionData {
  const detectedInstalls = getArray(details, ['detected_installs', 'detectedInstalls'])
    .map(normalizeInstall);
  const installs = getArray(details, ['installs']).map(normalizeInstall);
  const resolvedInstalls = installs.length > 0 ? installs : detectedInstalls;
  const resolvedDetectedInstalls = detectedInstalls.length > 0
    ? detectedInstalls
    : resolvedInstalls.filter((install) => install.detected);
  const sites = getArray(details, ['sites']).map(normalizeSite);
  const iisSites = getArray(details, ['iis_sites', 'iisSites']).map((site, index) => ({
    ...normalizeSite(site, index),
    source: readString(site, ['source', 'Source'], 'IIS'),
    ownerPanel: readString(site, ['owner_panel', 'ownerPanel'], 'IIS'),
  }));
  const services = getArray(details, ['services']).map(normalizeService);
  const logs = getArray(details, ['logs']).map(normalizeLog);
  const diagnostics = getTextArray(details, 'diagnostics');

  const statisticsRow = isRecord(details.statistics) ? details.statistics : {};
  const statistics: WindowsPanelStatistics = {
    detectedPanelCount: readNumber(statisticsRow, ['detected_panel_count', 'detectedPanelCount'], resolvedDetectedInstalls.length),
    siteCount: readNumber(statisticsRow, ['site_count', 'siteCount'], sites.length),
    iisSiteCount: readNumber(statisticsRow, ['iis_site_count', 'iisSiteCount'], iisSites.length),
    serviceCount: readNumber(statisticsRow, ['service_count', 'serviceCount'], services.length),
    logCount: readNumber(statisticsRow, ['log_count', 'logCount'], logs.length),
    diagnosticCount: readNumber(statisticsRow, ['diagnostic_count', 'diagnosticCount'], diagnostics.length),
  };

  return {
    installs: resolvedInstalls,
    detectedInstalls: resolvedDetectedInstalls,
    sites,
    iisSites,
    services,
    logs,
    diagnostics,
    statistics,
  };
}

export function normalizeWindowsPanelDetection(input: unknown): WindowsPanelDetectionData {
  if (!isRecord(input)) {
    return {
      installs: [],
      detectedInstalls: [],
      sites: [],
      iisSites: [],
      services: [],
      logs: [],
      diagnostics: [],
      statistics: emptyStatistics,
    };
  }

  return buildData(input);
}

function parseJsonRecords(content: string): DetailRecord[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  const jsonMatch = trimmed.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (!jsonMatch) return [];

  try {
    return ensureArray(JSON.parse(jsonMatch[0]));
  } catch {
    return [];
  }
}

function parseJsonTextArray(content: string): string[] {
  const trimmed = content.trim();
  if (!trimmed) return [];

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean);
    }
  } catch {
    return trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  return [];
}

function parseSections(output: string): Record<string, string> {
  const parts = output.split(/===(\w+)===/);
  const sections: Record<string, string> = {};

  for (let i = 1; i < parts.length; i += 2) {
    sections[parts[i]] = parts[i + 1]?.trim() || '';
  }

  return sections;
}

function legacySiteRows(content: string, meta: { panelType: string; name: string; siteRoot: string }): DetailRecord[] {
  return parseJsonRecords(content)
    .map((row, index) => {
      const name = readString(row, ['Name', 'name'], '');
      if (!name) return null;

      return {
        key: `${meta.panelType}-${index}`,
        source: meta.panelType,
        panel_type: meta.panelType,
        name,
        path: `${meta.siteRoot}\\${name}`,
        state: 'Present',
        bindings: '-',
        owner_panel: meta.name,
        size: row.Length ?? row.length,
        last_modified: String(row.LastWriteTime ?? row.lastWriteTime ?? '-').split('T')[0],
      };
    })
    .filter(isRecord);
}

function parseLegacySections(sections: Record<string, string>): WindowsPanelDetectionData {
  const installs: DetailRecord[] = [];
  const sites: DetailRecord[] = [];
  const diagnostics: string[] = [];

  Object.entries(legacyPanelMeta).forEach(([sectionName, meta]) => {
    const content = sections[sectionName];
    if (content === undefined) return;

    const detected = content.includes(meta.marker) && !/未检测到|not found/i.test(content);
    installs.push({
      panel_type: meta.panelType,
      name: meta.name,
      path: meta.path,
      site_root: meta.siteRoot,
      detected,
      site_count: detected ? legacySiteRows(content, meta).length : 0,
      notes: detected ? 'legacy section detected' : 'not found',
    });

    if (detected) {
      sites.push(...legacySiteRows(content, meta));
    }
  });

  if (sections.IIS) {
    const iisSites = parseJsonRecords(sections.IIS);
    sites.push(...iisSites.map((site, index) => ({
      key: `iis-${index}`,
      source: 'IIS',
      panel_type: 'iis',
      name: readString(site, ['Name', 'name']),
      path: readString(site, ['PhysicalPath', 'path']),
      state: readString(site, ['State', 'state']),
      bindings: readString(site, ['Bindings', 'bindings']),
      owner_panel: 'IIS',
    })));
  }

  if (installs.length === 0) {
    diagnostics.push('No Windows panel sections were found');
  }

  return normalizeWindowsPanelDetection({
    installs,
    detected_installs: installs.filter((install) => install.detected === true),
    sites,
    iis_sites: sites.filter((site) => site.source === 'IIS'),
    diagnostics,
    statistics: {
      detected_panel_count: installs.filter((install) => install.detected === true).length,
      site_count: sites.length,
      iis_site_count: sites.filter((site) => site.source === 'IIS').length,
      service_count: 0,
      log_count: 0,
      diagnostic_count: diagnostics.length,
    },
  });
}

export function parseWindowsPanelSections(output: string): WindowsPanelDetectionData {
  const sections = parseSections(output);
  const hasStructuredSections = ['PANELS', 'IIS_SITES', 'SERVICES', 'LOGS', 'DIAGNOSTICS']
    .some((sectionName) => sections[sectionName] !== undefined);

  if (!hasStructuredSections) {
    return parseLegacySections(sections);
  }

  return normalizeWindowsPanelDetection({
    installs: parseJsonRecords(sections.PANELS || ''),
    detected_installs: parseJsonRecords(sections.PANELS || '').filter((panel) => readBool(panel, ['Detected', 'detected'])),
    sites: parseJsonRecords(sections.SITES || ''),
    iis_sites: parseJsonRecords(sections.IIS_SITES || ''),
    services: parseJsonRecords(sections.SERVICES || ''),
    logs: parseJsonRecords(sections.LOGS || ''),
    diagnostics: parseJsonTextArray(sections.DIAGNOSTICS || ''),
  });
}
