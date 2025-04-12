# fal.ai OpenAI-compatible API Proxy for Cloudflare Workers

本项目提供了一个 Cloudflare Worker，将 fal.ai API 转成 OpenAI API 兼容格式。

> [!WARNING] 
> 仅支持文本对话，不支持文件/图片上传

## 部署

1.  **Fork 本仓库:** 点击 GitHub 页面右上角的 "Fork" 按钮，将此仓库复制到您的 GitHub 账户下。
2.  **登录 Cloudflare:** 打开浏览器，访问 [Cloudflare Dashboard](https://dash.cloudflare.com/) 并登录您的账户。
3.  **连接 GitHub 账户 (如果尚未连接):**
    *   在 Cloudflare Dashboard 中，导航至 "Workers & Pages"。
    *   点击 "概述 (Overview)" > "连接到 Git (Connect to Git)"。
    *   选择 GitHub 并按照提示授权 Cloudflare 访问您的 GitHub 仓库。
4.  **创建 Worker 服务:**
    *   在 "Workers & Pages" 页面，点击 "创建应用程序 (Create application)" > "Pages" 选项卡 > "连接到 Git (Connect to Git)"。
    *   选择您 Fork 的仓库，点击 "开始设置 (Begin setup)"。
    *   **项目名称 (Project name):** 输入您想要的 Worker 服务名称 (例如 `my-fal-proxy`)。
    *   **设置构建和部署 (Set up builds and deployments):** 此部分所有设置保持默认即可。
    *   点击 "保存并部署 (Save and Deploy)"。
5.  **配置环境变量:**
    *   部署完成后，导航至您新创建的 Worker 服务的设置页面。
    *   选择 "设置 (Settings)" > "变量 (Variables)"。
    *   在 "环境变量 (Environment Variables)" 部分，点击 "添加变量 (Add variable)"，添加以下两个变量：
        *   `FAL_KEY`: 输入您从 fal.ai 获取的 API Key。勾选 "加密 (Encrypt)" 以保护密钥。
        *   `API_KEY`: 输入您希望用于访问此代理服务的自定义 API Key (可以自行设置一个强密码)。勾选 "加密 (Encrypt)"。
    *   点击 "保存 (Save)"。

部署完成后，您的 Worker 服务 URL (例如 `your-worker-name.your-subdomain.workers.dev`) 即为 OpenAI 兼容的 API Endpoint。

## 本地开发

您可以使用 Cloudflare 的 Wrangler CLI 在本地进行开发和测试。您需要安装 [Node.js](https://nodejs.org/) (包含 npm)。

1.  **登录 Wrangler:**
    ```bash
    npx wrangler login
    ```
    这将打开浏览器提示您登录 Cloudflare 账户。
2.  **克隆仓库:**
    ```bash
    git clone <your-forked-repo-url>
    cd <repository-directory>
    ```
3.  **安装依赖:**
    ```bash
    npm install
    # 或者
    # yarn install
    ```
4.  **创建 `.dev.vars` 文件:**
    在项目根目录下创建一个名为 `.dev.vars` 的文件，并添加您的环境变量：
    ```
    FAL_KEY="your_fal_ai_key"
    API_KEY="your_custom_api_key"
    ```
    **注意:** 不要将此文件提交到 Git 仓库。`.gitignore` 文件已配置忽略此文件。
5.  **启动本地开发服务器:**
    ```bash
    npx wrangler dev
    ```
    Wrangler 将启动一个本地服务器 (通常在 `http://localhost:8787`)，模拟 Cloudflare 环境。您可以使用此本地 URL 进行测试。

## 使用

将您的 OpenAI 客户端配置为使用您的 Cloudflare Worker URL 作为 API Base URL，并使用您在环境变量中设置的 `API_KEY` 作为 Bearer Token 进行身份验证。

**示例 (使用 `curl`):**

```bash
curl https://your-worker-name.your-subdomain.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer your_custom_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "fal-ai/Mixtral-8x7B-Instruct-v0.1", # 或其他 fal.ai 支持的模型
    "messages": [{"role": "user", "content": "你好!"}]
  }'
```

将 `your-worker-name.your-subdomain.workers.dev` 替换为您的 Worker URL，并将 `your_custom_api_key` 替换为您设置的 `API_KEY`。将 `"fal-ai/Mixtral-8x7B-Instruct-v0.1"` 替换为您想使用的 fal.ai 模型。
