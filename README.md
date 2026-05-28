# Kindle Auto Classifier

[English](#english) | [中文](#中文)

---

## English

### Overview

A Tampermonkey userscript that automatically classifies your unorganized Kindle books into collections using AI. No more manual sorting through hundreds of books!

### Features

- AI-powered classification with OpenAI-compatible APIs
- Single-page closed loop: scan, classify, and apply on the current page
- Auto Process mode: finish the current page, then continue to the next page automatically
- Batch processing for lower API overhead
- Draggable control panel with progress and logs

### Prerequisites

- A modern web browser (Chrome, Firefox, Edge, etc.)
- [Tampermonkey](https://www.tampermonkey.net/) browser extension
- An OpenAI API key (or compatible API endpoint)

### Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser
2. Click [here](https://github.com/neufvingt/kindle-auto-classifier/raw/main/kindle-classifier.user.js) to install the script
3. Tampermonkey will open - click "Install"

### Usage

1. Go to your [Amazon Kindle Library](https://www.amazon.com/hz/mycd/digital-console/contentlist/booksAll/dateDsc)
2. The Kindle Classifier panel will appear in the top-right corner
3. **First-time setup**:
   - Click "Configuration ▾" to expand settings
   - Enter your API endpoint and API key
   - Click "Save"
4. **Discover collections**:
   - Click "More actions" on any book
   - Select "Add or Remove from Collection"
   - Click the "Refresh" button in the panel
5. **Classify books**:
   - Click "Scan Page" to inspect the current page
   - Click "Classify" to get AI recommendations for that page
   - Click "Apply" to add books to collections on that page
   - Or click "Auto Process" to classify the current page, apply the changes, and move to the next page automatically

### Configuration

- **API Endpoint**: Default is OpenAI, but you can use any compatible API
- **API Key**: Your API key
- **Model**: Default is `gpt-4o-mini` (recommended for cost-effectiveness)
- **Batch Size**: Number of books to classify per API call (default: 10)
- **Request Delay**: Delay between API calls in milliseconds (default: 3000)
- **Next Page Delay**: Delay before moving to the next page in auto mode (default: 2500)

### How It Works

1. **Scan**: Detects books and their classification status on the current page
2. **Classify**: Sends book titles and authors to AI with your collection list
3. **Apply**: Simulates clicking through the UI to add books to collections
4. **Auto Process**: Repeats the same page workflow, then advances to the next page until the library is done

### Privacy & Security

- All data stays local - no third-party tracking
- API key is stored in browser local storage
- Only book titles and authors are sent to the AI API
- No personal information is collected

### Troubleshooting

**Auto Process stopped between pages?**
- Keep the Kindle library tab open and visible while the script is running
- If Amazon loads slowly, try increasing the "Next Page Delay" setting

**Classification failed?**
- Check your API key is valid
- Ensure you have API credits
- Try reducing batch size

**Apply failed?**
- Keep the browser tab visible during application
- Don't interact with the page while applying
- Check browser console for errors

### License

MIT License - see [LICENSE](LICENSE) file

### Author

Created by Claude (Anthropic) with assistance from the user

### Contributing

Issues and pull requests are welcome!

---

## 中文

### 概述

一个 Tampermonkey 用户脚本，使用 AI 自动将未分类的 Kindle 图书整理到合集中。再也不用手动整理数百本书了！

### 功能特性

- 🤖 **AI 智能分类**：使用 OpenAI API（或兼容 API）智能分类图书
- 📚 **多页扫描**：自动扫描 Kindle 图书馆的所有页面
- 🎯 **批量处理**：一次性分类多本图书
- 🔄 **自动应用**：模拟 UI 交互自动添加图书到合集
- 💾 **持久化设置**：本地保存 API 配置
- 🎨 **简洁界面**：可拖动面板，实时进度跟踪

### 前置要求

- 现代浏览器（Chrome、Firefox、Edge 等）
- [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
- OpenAI API 密钥（或兼容的 API 端点）

### 安装方法

1. 在浏览器中安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 点击[这里](https://github.com/neufvingt/kindle-auto-classifier/raw/main/kindle-classifier.user.js)安装脚本
3. Tampermonkey 会打开 - 点击"安装"

### 使用方法

1. 访问你的 [Amazon Kindle 图书馆](https://www.amazon.com/hz/mycd/digital-console/contentlist/booksAll/dateDsc)
2. Kindle Classifier 面板会出现在右上角
3. **首次设置**：
   - 点击 "Configuration ▾" 展开设置
   - 输入 API 端点和 API 密钥
   - 点击 "Save"
4. **发现合集**：
   - 点击任意图书的 "More actions"
   - 选择 "Add or Remove from Collection"
   - 点击面板中的 "Refresh" 按钮
5. **分类图书**：
   - 点击 "Scan All" 扫描所有页面（会自动翻页）
   - 点击 "Classify" 获取 AI 推荐
   - 查看结果
   - 点击 "Apply" 将图书添加到合集

### 配置说明

- **API Endpoint**：默认是 OpenAI，也可以使用兼容的 API
- **API Key**：你的 API 密钥
- **Model**：默认是 `gpt-4o-mini`（推荐，性价比高）
- **Batch Size**：每次 API 调用分类的图书数量（默认：10）
- **Delay**：API 调用之间的延迟毫秒数（默认：3000）

### 工作原理

1. **扫描**：检测所有页面的图书及其分类状态
2. **分类**：将图书标题和作者发送给 AI，附带你的合集列表
3. **应用**：模拟点击 UI 将图书添加到合集

### 隐私与安全

- 所有数据保存在本地 - 无第三方跟踪
- API 密钥存储在浏览器本地存储中
- 只有图书标题和作者会发送到 AI API
- 不收集任何个人信息

### 故障排除

**其他页面的图书检测不到？**
- 脚本现在会自动等待页面内容加载
- 如果问题持续，尝试增加 "Delay" 设置

**分类失败？**
- 检查 API 密钥是否有效
- 确保有 API 额度
- 尝试减少批量大小

**应用失败？**
- 应用期间保持浏览器标签页可见
- 应用时不要操作页面
- 检查浏览器控制台错误

### 许可证

MIT License - 查看 [LICENSE](LICENSE) 文件

### 作者

由 Claude (Anthropic) 创建，用户协助

### 贡献

欢迎提交 Issue 和 Pull Request！
