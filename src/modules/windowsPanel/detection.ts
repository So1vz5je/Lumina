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

const indexedPanelMeta = [
  {
    panelType: 'baota_windows',
    name: 'BaoTa Windows',
    markers: ['btsoft', 'btpanel'],
    siteDirs: ['wwwroot', 'websites'],
  },
  {
    panelType: 'phpstudy',
    name: 'PhpStudy Pro',
    markers: ['phpstudy_pro', 'phpstudy', 'xp.cn'],
    siteDirs: ['www'],
  },
  {
    panelType: 'xampp',
    name: 'XAMPP',
    markers: ['xampp'],
    siteDirs: ['htdocs'],
  },
  {
    panelType: 'wampserver',
    name: 'WampServer',
    markers: ['wamp64', 'wamp', 'wampserver'],
    siteDirs: ['www'],
  },
] as const;

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

function normalizeWindowsPath(path: string): string {
  return path.trim().replace(/\//g, '\\').replace(/\\+$/, '');
}

function findIndexedPanelMeta(path: string): typeof indexedPanelMeta[number] | undefined {
  const segments = normalizeWindowsPath(path)
    .split('\\')
    .map((segment) => segment.toLowerCase());

  return indexedPanelMeta.find((meta) => (
    meta.markers.some((marker) => segments.includes(marker.toLowerCase()))
  ));
}

function deriveRootFromMarker(path: string, markers: readonly string[]): string {
  const segments = normalizeWindowsPath(path).split('\\');
  const markerIndex = segments.findIndex((segment) => (
    markers.some((marker) => segment.toLowerCase() === marker.toLowerCase())
  ));

  return markerIndex >= 0 ? segments.slice(0, markerIndex + 1).join('\\') : '-';
}

function deriveSiteRoot(path: string, installPath: string, siteDirs: readonly string[]): string {
  const segments = normalizeWindowsPath(path).split('\\');
  const siteIndex = segments.findIndex((segment) => (
    siteDirs.some((siteDir) => segment.toLowerCase() === siteDir.toLowerCase())
  ));

  if (siteIndex >= 0) return segments.slice(0, siteIndex + 1).join('\\');
  const firstSiteDir = siteDirs[0];
  return firstSiteDir ? `${installPath}\\${firstSiteDir}` : installPath;
}

function deriveSiteFromIndexedPath(path: string, siteRoot: string): DetailRecord | null {
  const normalizedPath = normalizeWindowsPath(path);
  const normalizedRoot = normalizeWindowsPath(siteRoot);
  if (!normalizedPath.toLowerCase().startsWith(normalizedRoot.toLowerCase())) return null;

  const relative = normalizedPath.slice(normalizedRoot.length).replace(/^\\+/, '');
  const siteName = relative.split('\\')[0]?.trim();
  if (!siteName) return null;

  return {
    name: siteName,
    path: `${normalizedRoot}\\${siteName}`,
  };
}

function isIndexedLogOrConfig(path: string, extension: string, name: string): boolean {
  const lowerPath = path.toLowerCase();
  const lowerName = name.toLowerCase();
  const lowerExtension = extension.replace(/^\./, '').toLowerCase();

  return ['log', 'conf', 'config', 'ini', 'json'].includes(lowerExtension)
    || lowerName.includes('log')
    || lowerName.includes('conf')
    || lowerPath.includes('\\logs\\')
    || lowerPath.includes('\\log\\');
}

function isIndexedShortcutNoise(path: string, extension: string): boolean {
  const lowerPath = normalizeWindowsPath(path).toLowerCase();
  const lowerExtension = extension.replace(/^\./, '').toLowerCase();

  return lowerExtension === 'lnk'
    || lowerExtension === 'url'
    || lowerPath.includes('\\microsoft\\windows\\start menu\\')
    || lowerPath.includes('\\programdata\\microsoft\\windows\\start menu\\');
}

function appendUniqueRecord(records: DetailRecord[], key: string, row: DetailRecord): void {
  const value = String(row[key] ?? '').toLowerCase();
  if (!value || records.some((record) => String(record[key] ?? '').toLowerCase() === value)) return;
  records.push(row);
}

function deriveEverythingDetails(rows: DetailRecord[]): {
  installs: DetailRecord[];
  sites: DetailRecord[];
  logs: DetailRecord[];
} {
  const installs: DetailRecord[] = [];
  const sites: DetailRecord[] = [];
  const logs: DetailRecord[] = [];

  rows.forEach((row) => {
    const fullPath = readString(row, ['FullPath', 'path', 'Path'], '');
    if (!fullPath) return;

    const name = readString(row, ['Name', 'name'], '');
    const extension = readString(row, ['Extension', 'extension'], '');
    if (isIndexedShortcutNoise(fullPath, extension)) return;

    const meta = findIndexedPanelMeta(fullPath);
    if (!meta) return;

    const installPath = deriveRootFromMarker(fullPath, meta.markers);
    if (installPath === '-') return;

    const siteRoot = deriveSiteRoot(fullPath, installPath, meta.siteDirs);
    appendUniqueRecord(installs, 'path', {
      panel_type: meta.panelType,
      name: meta.name,
      path: installPath,
      site_root: siteRoot,
      service_state: '-',
      evidence: 'everything_index',
      detected: true,
      site_count: 0,
      notes: 'indexed by Everything',
    });

    const site = deriveSiteFromIndexedPath(fullPath, siteRoot);
    if (site) {
      appendUniqueRecord(sites, 'path', {
        source: 'everything',
        panel_type: meta.panelType,
        name: site.name,
        path: site.path,
        state: 'Indexed',
        bindings: '-',
        owner_panel: meta.name,
        last_modified: readString(row, ['LastWriteTime', 'LastModified', 'DateModified']),
      });
    }

    if (isIndexedLogOrConfig(fullPath, extension, name)) {
      appendUniqueRecord(logs, 'path', {
        source: meta.panelType,
        path: fullPath,
        size: row.Length ?? row.length ?? row.Size ?? row.size,
        last_modified: readString(row, ['LastWriteTime', 'LastModified', 'DateModified']),
        note: 'Everything indexed log/config metadata',
      });
    }
  });

  installs.forEach((install) => {
    const panelType = readString(install, ['panel_type'], '');
    const siteRoot = readString(install, ['site_root'], '').toLowerCase();
    install.site_count = sites.filter((site) => (
      readString(site, ['panel_type'], '') === panelType
        && readString(site, ['path'], '').toLowerCase().startsWith(siteRoot)
    )).length;
  });

  return { installs, sites, logs };
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
    .map<DetailRecord | null>((row, index) => {
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
    .filter((row): row is DetailRecord => row !== null);
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
  const hasStructuredSections = ['PANELS', 'ES_MATCHES', 'IIS_SITES', 'SERVICES', 'LOGS', 'DIAGNOSTICS']
    .some((sectionName) => sections[sectionName] !== undefined);

  if (!hasStructuredSections) {
    return parseLegacySections(sections);
  }

  const panelRows = parseJsonRecords(sections.PANELS || '');
  const everythingDetails = deriveEverythingDetails(parseJsonRecords(sections.ES_MATCHES || ''));
  const installs = [...panelRows, ...everythingDetails.installs];
  const detectedInstalls = [
    ...panelRows.filter((panel) => readBool(panel, ['Detected', 'detected'])),
    ...everythingDetails.installs,
  ];
  const sites = [
    ...parseJsonRecords(sections.SITES || ''),
    ...everythingDetails.sites,
  ];
  const logs = [
    ...parseJsonRecords(sections.LOGS || ''),
    ...everythingDetails.logs,
  ];

  return normalizeWindowsPanelDetection({
    installs,
    detected_installs: detectedInstalls,
    sites,
    iis_sites: parseJsonRecords(sections.IIS_SITES || ''),
    services: parseJsonRecords(sections.SERVICES || ''),
    logs,
    diagnostics: parseJsonTextArray(sections.DIAGNOSTICS || ''),
  });
}
