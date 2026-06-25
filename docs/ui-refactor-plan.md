# UI 重构与 Windows 功能修复计划

## 背景
当前Windows本地分析功能存在以下问题：
1. 多个模块无法正常显示结果（service_list、user_list、logged_users等）
2. 前端UI不匹配暗色/亮色主题
3. 壁纸模式下组件透明度和样式问题
4. 部分PowerShell命令输出格式不匹配前端解析器

## 修复阶段

### 第一阶段：Windows命令修复（核心功能）

**目标**：确保所有Windows本地模块能正常获取和显示数据

#### 1.1 验证现有命令
- [ ] 测试 `user_list` (Get-LocalUser)
- [ ] 测试 `service_list` (Get-Service)
- [ ] 测试 `logged_users` (quser/Get-CimInstance)
- [ ] 测试 `startup` (Win32_StartupCommand)
- [ ] 测试 `process_list` (Get-Process)
- [ ] 测试 `network_conn` (Get-NetTCPConnection)
- [ ] 测试 `listen_ports` (Get-NetTCPConnection -State Listen)
- [ ] 测试 `installed_software` (Get-ItemProperty UninstallKey)
- [ ] 测试 `env_vars` ($env:)
- [ ] 测试 `disk_info` (Get-Volume/Win32_LogicalDisk)
- [ ] 测试 `win_defender` (Get-MpComputerStatus)
- [ ] 测试 `win_firewall` (netsh advfirewall)
- [ ] 测试 `dns_config` (Get-DnsClientServerAddress)
- [ ] 测试 `hosts_file` (Get-Content C:\Windows\System32\drivers\etc\hosts)
- [ ] 测试 `registry` (注册表关键项)
- [ ] 测试 `persistence` (计划任务+服务+启动项)
- [ ] 测试 `cron` (Get-ScheduledTask)
- [ ] 测试 `rdp` (RDP连接+服务+注册表)
- [ ] 测试 `browser` (浏览器痕迹)
- [ ] 测试 `recent_files` (最近访问文件)
- [ ] 测试 `security_events` (Windows事件日志)
- [ ] 测试 `process_anomaly` (进程异常检测)
- [ ] 测试 `database` (数据库服务检测)
- [ ] 测试 `panel` (面板检测)
- [ ] 测试 `docker` (Docker容器)

#### 1.2 修复命令和解析器不匹配问题
对于每个失败的模块：
- 检查PowerShell命令输出格式
- 修复前端JSON解析逻辑
- 确保表格列dataIndex与解析出的数据key匹配
- 添加错误处理和降级方案

### 第二阶段：UI主题适配

**目标**：所有组件正确响应主题切换和壁纸模式

#### 2.1 核心组件主题适配
- [ ] `ModuleDetail.tsx` - 表格、卡片、统计卡片
- [ ] `App.tsx` - 侧边栏、顶栏、背景
- [ ] `Scan.tsx` - 扫描进度界面
- [ ] `Results.tsx` - 结果展示界面
- [ ] `Settings.tsx` - 设置界面
- [ ] `ModeSelect.tsx` - 模式选择界面

#### 2.2 主题颜色规范
**暗色主题**：
- 背景：#141414 (无壁纸) / rgba(0,0,0,0.4) (壁纸模式)
- 卡片：#1f1f1f
- 边框：#303030
- 文字：#fff / rgba(255,255,255,0.85)
- 次要文字：#8c8c8c

**亮色主题**：
- 背景：#f5f5f5 (无壁纸) / rgba(255,255,255,0.4) (壁纸模式)
- 卡片：#ffffff
- 边框：#f0f0f0
- 文字：#000 / rgba(0,0,0,0.85)
- 次要文字：#8c8c8c

**壁纸模式**：
- 添加 backdrop-filter: blur(20px)
- 卡片半透明背景
- 增强边框可见度

#### 2.3 统一样式变量
创建 `src/styles/theme.ts` 统一管理主题颜色：
```typescript
export const getThemeColors = (isDark: boolean, hasWallpaper: boolean) => ({
  background: hasWallpaper 
    ? (isDark ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.4)')
    : (isDark ? '#141414' : '#f5f5f5'),
  cardBg: hasWallpaper
    ? (isDark ? 'rgba(31,31,31,0.7)' : 'rgba(255,255,255,0.7)')
    : (isDark ? '#1f1f1f' : '#ffffff'),
  border: isDark ? '#303030' : '#f0f0f0',
  text: isDark ? '#fff' : '#000',
  textSecondary: '#8c8c8c',
  backdropFilter: hasWallpaper ? 'blur(20px) saturate(1.5)' : 'none',
});
```

### 第三阶段：组件细节优化

#### 3.1 表格优化
- [ ] 统一表格样式（边框、行高、字体）
- [ ] 添加悬停高亮效果
- [ ] 优化滚动条样式
- [ ] 分页器主题适配
- [ ] 空状态优化

#### 3.2 卡片和统计优化
- [ ] 统计卡片渐变背景主题适配
- [ ] 卡片阴影和圆角统一
- [ ] 加载状态优化
- [ ] 错误提示优化

#### 3.3 交互优化
- [ ] 按钮悬停动画
- [ ] 模态框主题适配
- [ ] 下拉菜单主题适配
- [ ] 标签和徽章主题适配

### 第四阶段：测试和验证

#### 4.1 功能测试
- [ ] 每个Windows模块能正常加载数据
- [ ] 表格能正确显示和排序
- [ ] 搜索和过滤功能正常
- [ ] 导出功能正常

#### 4.2 视觉测试
- [ ] 暗色主题下所有页面正常显示
- [ ] 亮色主题下所有页面正常显示
- [ ] 壁纸模式下所有页面正常显示
- [ ] 不同分辨率下布局正常

#### 4.3 性能测试
- [ ] 大量数据时表格渲染流畅
- [ ] 主题切换无卡顿
- [ ] 内存占用正常

## 优先级
1. **P0**：修复核心Windows模块数据获取（user_list、service_list、process_list、network_conn）
2. **P1**：修复主题适配问题（ModuleDetail表格、卡片）
3. **P2**：优化UI细节和交互
4. **P3**：性能优化和边缘情况处理

## 实施步骤
1. 逐个测试Windows命令，记录哪些失败
2. 修复命令或解析器
3. 应用统一主题样式
4. 测试验证

## 成功标准
- ✅ 所有Windows本地模块能正常显示数据
- ✅ 暗色/亮色主题切换正常
- ✅ 壁纸模式下所有组件可读性良好
- ✅ 无明显的样式错误或组件错位
