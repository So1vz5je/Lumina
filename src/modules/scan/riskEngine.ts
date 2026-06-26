import type { AnalysisResult, RiskFinding, RiskSeverity } from '../../types/analysis';

export type { RiskFinding, RiskSeverity };

type DetailRecord = Record<string, unknown>;

interface WebRootCandidate {
  path: string;
  source: string;
}

const severityRank: Record<RiskSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const webshellPattern = /\b(eval|assert|base64_decode|gzinflate|shell_exec|passthru|system|cmd\.exe|powershell|runtime\.getruntime|processbuilder|wscript\.shell)\b/i;
const scriptExtensionPattern = /\.(php\d*|phtml|inc|asp|aspx|asa|ashx|jsp|jspx)$/i;
const suspiciousCommandPattern = /(encodedcommand|-enc\b|frombase64string|downloadstring|invoke-expression|\biex\b|mshta|rundll32|regsvr32|wscript|cscript|bitsadmin|certutil|startup|appdata|\\temp\\|\\users\\public\\)/i;

function isRecord(value: unknown): value is DetailRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getDetails(result: AnalysisResult | undefined): DetailRecord {
  return isRecord(result?.details) ? result.details : {};
}

function getArray(details: DetailRecord, keys: string[]): DetailRecord[] {
  for (const key of keys) {
    const value = details[key];
    if (Array.isArray(value)) {
      return value.filter(isRecord);
    }
  }
  return [];
}

function valueToText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((item) => valueToText(item)).filter(Boolean).join('; ');
  if (isRecord(value)) return JSON.stringify(value);
  return fallback;
}

function readField(row: DetailRecord, keys: string[], fallback = ''): string {
  for (const key of keys) {
    const value = valueToText(row[key]);
    if (value) return value;
  }
  return fallback;
}

function normalizePath(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\+$/g, '').toLowerCase();
}

function isPathUnder(candidatePath: string, rootPath: string): boolean {
  const normalizedPath = normalizePath(candidatePath);
  const normalizedRoot = normalizePath(rootPath);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function makeId(prefix: string, value: string): string {
  return `${prefix}-${value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80)}`;
}

function pushFinding(findings: RiskFinding[], finding: RiskFinding) {
  const existing = findings.find((item) => item.id === finding.id);
  if (!existing) {
    findings.push(finding);
    return;
  }

  if (severityRank[finding.severity] > severityRank[existing.severity]) {
    existing.severity = finding.severity;
  }
  existing.confidence = Math.max(existing.confidence, finding.confidence);
  existing.affected = uniqueStrings([...existing.affected, ...finding.affected]);
  existing.evidence = [...existing.evidence, ...finding.evidence];
  existing.recommendedActions = uniqueStrings([...existing.recommendedActions, ...finding.recommendedActions]);
}

export function mergeRiskFindings(groups: RiskFinding[][]): RiskFinding[] {
  const findings: RiskFinding[] = [];

  groups.flat().forEach((finding) => pushFinding(findings, finding));

  return findings.sort((a, b) => {
    const severityDelta = severityRank[b.severity] - severityRank[a.severity];
    if (severityDelta !== 0) return severityDelta;
    return b.confidence - a.confidence;
  });
}

function deriveWebRootsFromInstallPath(installPath: string): string[] {
  const normalized = installPath.replace(/\//g, '\\');
  const roots: string[] = [];
  const phpstudyMatch = normalized.match(/^(.*?phpstudy(?:_pro)?)(?:\\.*)?$/i);
  if (phpstudyMatch?.[1]) {
    roots.push(`${phpstudyMatch[1]}\\WWW`);
    roots.push(`${phpstudyMatch[1]}\\www`);
  }

  const btMatch = normalized.match(/^(.*?BtSoft)(?:\\.*)?$/i);
  if (btMatch?.[1]) {
    roots.push(`${btMatch[1]}\\wwwroot`);
    roots.push(`${btMatch[1]}\\WebSites`);
  }

  const xamppMatch = normalized.match(/^(.*?xampp)(?:\\.*)?$/i);
  if (xamppMatch?.[1]) {
    roots.push(`${xamppMatch[1]}\\htdocs`);
  }

  const wampMatch = normalized.match(/^(.*?wamp64|.*?wamp)(?:\\.*)?$/i);
  if (wampMatch?.[1]) {
    roots.push(`${wampMatch[1]}\\www`);
  }

  return roots;
}

function collectPanelWebRoots(results: AnalysisResult[]): WebRootCandidate[] {
  const panelResult = results.find((result) => result.module_name === 'panel');
  const details = getDetails(panelResult);
  const candidates: WebRootCandidate[] = [];

  const addCandidate = (path: string, source: string) => {
    if (!path) return;
    candidates.push({ path, source });
  };

  getArray(details, ['detected_installs', 'installs']).forEach((install) => {
    const name = readField(install, ['name', 'Name', 'panel_type', 'panelType'], 'Web 面板');
    const siteRoot = readField(install, ['site_root', 'siteRoot', 'SiteRoot', 'www_root', 'wwwRoot']);
    const installPath = readField(install, ['path', 'Path']);
    addCandidate(siteRoot, name);
    deriveWebRootsFromInstallPath(installPath).forEach((root) => addCandidate(root, name));
  });

  getArray(details, ['sites', 'iis_sites']).forEach((site) => {
    const source = readField(site, ['name', 'Name', 'source', 'Source'], 'Web 站点');
    addCandidate(readField(site, ['path', 'Path', 'PhysicalPath', 'physical_path']), source);
  });

  const unique = new Map<string, WebRootCandidate>();
  candidates.forEach((candidate) => {
    unique.set(normalizePath(candidate.path), candidate);
  });
  return Array.from(unique.values());
}

function collectSuspiciousFileRows(results: AnalysisResult[]): Array<{ moduleName: string; row: DetailRecord }> {
  const rows: Array<{ moduleName: string; row: DetailRecord }> = [];
  results
    .filter((result) => ['file_scan', 'suspicious_files', 'webshell_scan'].includes(result.module_name))
    .forEach((result) => {
      const details = getDetails(result);
      getArray(details, ['findings', 'files', 'suspicious_files', 'matches']).forEach((row) => {
        rows.push({ moduleName: result.module_name, row });
      });
    });
  return rows;
}

function buildWebshellFindings(results: AnalysisResult[], findings: RiskFinding[]) {
  const webRoots = collectPanelWebRoots(results);
  const suspiciousFiles = collectSuspiciousFileRows(results);

  suspiciousFiles.forEach(({ moduleName, row }) => {
    const path = readField(row, ['path', 'Path', 'full_path', 'fullPath', 'file', 'filePath']);
    const name = readField(row, ['name', 'Name', 'filename'], path.split(/[\\/]/).pop() || path);
    const reason = readField(row, ['reason', 'suspicious_reason', 'suspiciousReason', 'risk', 'Risk', 'signature', 'match', 'matches']);
    const combined = `${path} ${name} ${reason}`;
    const matchedRoot = webRoots.find((root) => path && isPathUnder(path, root.path));
    const looksLikeWebshell = scriptExtensionPattern.test(path) && webshellPattern.test(combined);

    if (!looksLikeWebshell || !matchedRoot) return;

    pushFinding(findings, {
      id: makeId('webshell', path),
      severity: 'critical',
      title: '疑似 WebShell 文件',
      reason: `Web 目录脚本命中高危执行特征：${reason || 'eval/base64_decode/system 等可疑代码特征'}`,
      confidence: 92,
      affected: [path],
      evidence: [
        {
          moduleName,
          label: name || '可疑脚本',
          value: path,
          time: readField(row, ['last_modified', 'lastModified', 'LastWriteTime', 'time']),
        },
        {
          moduleName: 'panel',
          label: matchedRoot.source,
          value: matchedRoot.path,
        },
      ],
      recommendedActions: [
        '立即隔离该脚本文件并保留样本副本',
        '检查同目录近 7 天新增和修改文件',
        '关联 Web 访问日志、进程和外联连接确认利用时间',
      ],
    });
  });
}

function formatEndpoint(row: DetailRecord): string {
  const address = readField(row, ['remote_address', 'remoteAddress', 'RemoteAddress', 'address']);
  const port = readField(row, ['remote_port', 'remotePort', 'RemotePort', 'port']);
  if (!address && !port) return '';
  if (!port || port === '0') return address;
  return `${address}:${port}`;
}

function buildProcessNetworkFindings(results: AnalysisResult[], findings: RiskFinding[]) {
  const processDetails = getDetails(results.find((result) => result.module_name === 'process'));
  const networkDetails = getDetails(results.find((result) => result.module_name === 'network'));
  const suspiciousProcesses = getArray(processDetails, ['suspicious_list', 'suspicious_processes', 'processes'])
    .filter((row) => readField(row, ['suspicious_reason', 'suspiciousReason']) || row.suspicious === true);
  const externalConnections = getArray(networkDetails, ['external_connections', 'connections']);

  suspiciousProcesses.forEach((process) => {
    const pid = readField(process, ['pid', 'Pid', 'Id']);
    const processName = readField(process, ['name', 'Name', 'process_name', 'processName'], `PID ${pid}`);
    const matchedConnections = externalConnections.filter((connection) => {
      const connectionPid = readField(connection, ['pid', 'Pid', 'OwningProcess']);
      return pid && connectionPid === pid;
    });

    matchedConnections.forEach((connection) => {
      const endpoint = formatEndpoint(connection);
      if (!endpoint) return;
      pushFinding(findings, {
        id: makeId('process-network', `${processName}-${pid}-${endpoint}`),
        severity: 'high',
        title: '可疑进程外联',
        reason: `${processName} 同时被进程分析标记可疑，并存在外联连接 ${endpoint}。`,
        confidence: 86,
        affected: [processName, endpoint],
        evidence: [
          {
            moduleName: 'process',
            label: processName,
            value: readField(process, ['path', 'Path', 'command', 'CommandLine'], `PID ${pid}`),
          },
          {
            moduleName: 'network',
            label: endpoint,
            value: `${readField(connection, ['protocol', 'Protocol'], 'TCP')} ${readField(connection, ['state', 'State'])}`.trim(),
          },
        ],
        recommendedActions: [
          '确认进程路径、签名和父进程',
          '阻断外联地址并抓取进程样本',
          '按 PID 回溯启动时间、用户和命令行',
        ],
      });
    });
  });
}

function buildPersistenceFindings(results: AnalysisResult[], findings: RiskFinding[]) {
  const modules = ['startup', 'cron', 'persistence'];

  modules.forEach((moduleName) => {
    const details = getDetails(results.find((result) => result.module_name === moduleName));
    const rows = getArray(details, [
      'suspicious_items',
      'suspicious_entries',
      'suspicious_tasks',
      'startup_items',
      'tasks',
      'entries',
    ]);

    rows.forEach((row) => {
      const title = readField(row, ['name', 'Name', 'task_name', 'taskName', 'TaskName'], moduleName);
      const command = readField(row, ['command', 'Command', 'actions', 'Actions', 'detail', 'PathName', 'task_to_run', 'taskToRun']);
      const reason = readField(row, ['suspicious_reason', 'suspiciousReason', 'reason', 'Risk']);
      const suspicious = row.suspicious === true || Boolean(reason) || suspiciousCommandPattern.test(command);

      if (!suspicious) return;

      pushFinding(findings, {
        id: makeId('persistence', `${moduleName}-${title}-${command}`),
        severity: suspiciousCommandPattern.test(command) ? 'high' : 'medium',
        title: '可疑持久化入口',
        reason: reason || `${title} 指向高风险命令或用户可写路径。`,
        confidence: suspiciousCommandPattern.test(command) ? 84 : 72,
        affected: uniqueStrings([title, command]),
        evidence: [
          {
            moduleName,
            label: title,
            value: command || readField(row, ['location', 'Location', 'task_path', 'taskPath']),
          },
        ],
        recommendedActions: [
          '导出该持久化项配置和关联文件',
          '确认创建时间、创建用户和触发频率',
          '禁用前先保留命令行、文件哈希和原始配置',
        ],
      });
    });
  });
}

function buildSecurityFindings(results: AnalysisResult[], findings: RiskFinding[]) {
  const securityEvents = getDetails(results.find((result) => result.module_name === 'security_events'));
  getArray(securityEvents, ['suspicious_events', 'events', 'failed_logins']).forEach((event) => {
    const eventId = readField(event, ['event_id', 'eventId', 'EventId']);
    const eventType = readField(event, ['event_type', 'eventType', 'EventType'], `Event ${eventId}`);
    const sourceIp = readField(event, ['source_ip', 'sourceIp', 'SourceIp']);
    const description = readField(event, ['description', 'Description', 'status']);
    const isHighValueEvent = ['1102', '4720', '4732', '4672'].includes(eventId);
    const suspicious = event.is_suspicious === true || event.suspicious === true || isHighValueEvent;

    if (!suspicious) return;

    pushFinding(findings, {
      id: makeId('security-event', `${eventId}-${eventType}-${sourceIp}`),
      severity: eventId === '1102' ? 'critical' : isHighValueEvent ? 'high' : 'medium',
      title: eventId === '1102' ? '安全日志被清除' : '高价值安全事件',
      reason: description || `${eventType} 需要人工复核。`,
      confidence: isHighValueEvent ? 82 : 70,
      affected: uniqueStrings([eventType, sourceIp]),
      evidence: [
        {
          moduleName: 'security_events',
          label: eventType,
          value: sourceIp || description || `Event ${eventId}`,
          time: readField(event, ['time_created', 'timeCreated', 'TimeCreated']),
        },
      ],
      recommendedActions: [
        '按事件时间展开前后 30 分钟日志',
        '核对相关账户、来源 IP 和主机名',
        '检查同时间段进程、网络和持久化变化',
      ],
    });
  });

  const posture = getDetails(results.find((result) => result.module_name === 'security_posture'));
  getArray(posture, ['findings']).forEach((finding) => {
    const name = readField(finding, ['name', 'Name']);
    const detail = readField(finding, ['detail', 'Detail']);
    if (!/(defender|实时防护|排除|防火墙.*关闭|rdp|远程桌面)/i.test(`${name} ${detail}`)) return;

    pushFinding(findings, {
      id: makeId('security-posture', name),
      severity: /defender|实时防护|排除/i.test(`${name} ${detail}`) ? 'high' : 'medium',
      title: '关键安全防护异常',
      reason: detail || name,
      confidence: 78,
      affected: [name],
      evidence: [
        {
          moduleName: 'security_posture',
          label: name,
          value: detail,
        },
      ],
      recommendedActions: [
        '确认是否为授权变更',
        '导出当前安全配置和变更时间',
        '与登录、进程和文件落地时间做关联',
      ],
    });
  });
}

function buildDockerFindings(results: AnalysisResult[], findings: RiskFinding[]) {
  const details = getDetails(results.find((result) => result.module_name === 'docker'));
  getArray(details, ['containers']).forEach((container) => {
    const name = readField(container, ['name', 'Name', 'Names', 'container_id', 'containerId', 'ID']);
    const reason = readField(container, ['suspicious_reason', 'suspiciousReason', 'reason']);
    const ports = readField(container, ['ports', 'Ports']);
    const mounts = readField(container, ['mounts', 'Mounts']);
    const text = `${reason} ${ports} ${mounts}`;
    const suspicious = container.suspicious === true || /(privileged|docker\.sock|\/var\/run\/docker|0\.0\.0\.0|6379|3306|5432|1433)/i.test(text);

    if (!suspicious) return;

    pushFinding(findings, {
      id: makeId('docker', name),
      severity: /privileged|docker\.sock|\/var\/run\/docker/i.test(text) ? 'high' : 'medium',
      title: '可疑容器暴露或挂载',
      reason: reason || '容器存在敏感端口暴露、特权运行或宿主机敏感挂载迹象。',
      confidence: 76,
      affected: uniqueStrings([name, ports]),
      evidence: [
        {
          moduleName: 'docker',
          label: name,
          value: text.trim() || readField(container, ['image', 'Image']),
        },
      ],
      recommendedActions: [
        '检查容器启动参数、挂载和端口映射',
        '确认镜像来源和容器内近期文件变化',
        '避免直接停止关键业务容器，先保留 inspect 输出',
      ],
    });
  });
}

function buildPanelContextFindings(results: AnalysisResult[], findings: RiskFinding[]) {
  const panelResult = results.find((result) => result.module_name === 'panel');
  const details = getDetails(panelResult);
  const installs = getArray(details, ['detected_installs', 'installs']).filter((install) => install.detected !== false);

  installs.forEach((install) => {
    const name = readField(install, ['name', 'Name', 'panel_type', 'panelType'], 'Web 面板');
    const path = readField(install, ['path', 'Path']);
    pushFinding(findings, {
      id: makeId('panel-context', `${name}-${path}`),
      severity: 'medium',
      title: '发现 Web 面板或集成环境',
      reason: '该发现用于提供 Web 入侵面上下文，单独发现面板不等于入侵。',
      confidence: 68,
      affected: uniqueStrings([name, path]),
      evidence: [
        {
          moduleName: 'panel',
          label: name,
          value: path || panelResult?.summary || 'panel detected',
        },
      ],
      recommendedActions: [
        '继续扫描站点目录中的新增脚本和可疑函数',
        '检查面板访问日志、站点日志和数据库配置',
      ],
    });
  });
}

export function buildRiskFindings(results: AnalysisResult[]): RiskFinding[] {
  const findings: RiskFinding[] = [];

  buildWebshellFindings(results, findings);
  buildProcessNetworkFindings(results, findings);
  buildPersistenceFindings(results, findings);
  buildSecurityFindings(results, findings);
  buildDockerFindings(results, findings);
  buildPanelContextFindings(results, findings);

  return mergeRiskFindings([findings]);
}
