# Windows 功能修复与 UI 重构实施指南

## 当前状态总结

### ✅ 可用的 Windows 模块（12/14）
- user_list - 本地用户列表
- service_list - 系统服务
- startup - 启动项
- process_list - 进程列表
- network_conn - 网络连接
- listen_ports - 监听端口
- disk_info - 磁盘信息
- env_vars - 环境变量
- installed_software - 已安装软件
- win_defender - Windows Defender
- dns_config - DNS配置
- cron - 计划任务

### ❌ 需要修复的模块（2/14）
1. **logged_users** - `quser` 命令不可用
   - 原因：命令在某些Windows版本不存在
   - 解决方案：已有fallback到PowerShell的实现
   
2. **hosts_file** - 输出非JSON格式
   - 原因：这是纯文本文件
   - 解决方案：前端解析器已经处理文本格式

## UI 主题问题

### 问题清单
1. **表格主题不适配** - 暗色模式下表格背景和边框不正确
2. **卡片透明度问题** - 壁纸模式下卡片可读性差
3. **统计卡片渐变色** - 固定颜色不随主题变化
4. **按钮和标签样式** - 部分组件样式硬编码

### 修复策略

#### 第一步：引入主题工具函数
文件：`src/utils/theme.ts`（已创建）
- 提供 `getThemeColors()` 函数
- 提供 `getCardStyle()` 函数
- 提供 `getTableStyle()` 函数

#### 第二步：修改 ModuleDetail.tsx
需要修改的部分：
1. 导入主题工具
2. 使用 `getCardStyle()` 替换所有手动卡片样式
3. 使用 `getThemeColors()` 获取动态颜色
4. 表格添加主题样式属性

#### 第三步：修改其他页面
- Scan.tsx
- Results.tsx  
- Settings.tsx
- App.tsx（侧边栏、内容区）

## 快速修复方案

### 优先级 P0：修复 ModuleDetail 表格主题

```typescript
// 在 ModuleDetail.tsx 顶部导入
import { getThemeColors, getCardStyle, getTableStyle } from '../utils/theme';

// 在组件内部获取主题颜色
const theme = getThemeColors(isDarkMode, !!wallpaper);

// 修改所有 Card 组件
<Card style={getCardStyle(isDarkMode, !!wallpaper)}>

// 修改 Table 组件
<Table 
  style={getTableStyle(isDarkMode, !!wallpaper)}
  className={isDarkMode ? 'dark-table' : 'light-table'}
/>
```

### 优先级 P1：添加全局 CSS 主题样式

在 `App.css` 中添加：
```css
/* 暗色主题表格 */
.dark-table .ant-table {
  background: rgba(31, 31, 31, 0.7);
  color: #fff;
}

.dark-table .ant-table-thead > tr > th {
  background: rgba(48, 48, 48, 0.8);
  color: #fff;
  border-bottom: 1px solid #303030;
}

.dark-table .ant-table-tbody > tr > td {
  border-bottom: 1px solid #303030;
}

.dark-table .ant-table-tbody > tr:hover > td {
  background: rgba(255, 255, 255, 0.08);
}

/* 亮色主题表格 */
.light-table .ant-table {
  background: #ffffff;
}

.light-table .ant-table-thead > tr > th {
  background: #fafafa;
  border-bottom: 1px solid #f0f0f0;
}

.light-table .ant-table-tbody > tr > td {
  border-bottom: 1px solid #f0f0f0;
}

.light-table .ant-table-tbody > tr:hover > td {
  background: rgba(0, 0, 0, 0.04);
}

/* 壁纸模式 */
.has-wallpaper .ant-table {
  backdrop-filter: blur(20px) saturate(1.5);
  -webkit-backdrop-filter: blur(20px) saturate(1.5);
}

.has-wallpaper .dark-table .ant-table {
  background: rgba(31, 31, 31, 0.7);
}

.has-wallpaper .light-table .ant-table {
  background: rgba(255, 255, 255, 0.7);
}
```

## 实施步骤

### Step 1: 测试当前所有模块
```powershell
cd "E:\solaのtools\emergency\emergency-analyzer-tauri"
.\test-windows-modules.ps1
```

### Step 2: 修复 ModuleDetail.tsx
1. 导入主题工具
2. 批量替换所有卡片样式
3. 添加表格主题类名
4. 测试验证

### Step 3: 添加全局CSS
1. 在 App.css 添加表格主题样式
2. 添加壁纸模式样式
3. 测试所有模块在不同主题下的显示

### Step 4: 运行应用测试
```bash
npm run tauri dev
```

测试清单：
- [ ] 暗色主题 + 无壁纸
- [ ] 暗色主题 + 有壁纸
- [ ] 亮色主题 + 无壁纸
- [ ] 亮色主题 + 有壁纸
- [ ] 所有Windows模块能正常加载数据
- [ ] 表格可读性良好
- [ ] 卡片可读性良好

## 预期结果

完成后应该达到：
- ✅ 所有表格在暗色/亮色主题下样式正确
- ✅ 壁纸模式下所有组件可读性良好
- ✅ 卡片、按钮、标签等组件主题一致
- ✅ 12个Windows核心模块能正常工作
- ✅ 无明显的样式错误或错位

## 下一步优化

1. 为剩余页面添加主题支持
2. 优化加载状态和错误提示
3. 添加更多Windows分析模块
4. 性能优化（大数据表格虚拟滚动）
