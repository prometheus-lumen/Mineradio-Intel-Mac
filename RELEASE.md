# 发布流程

## v1.1.0 发布边界

- `v1.1.0` 是纯净安装发布版，从当前 `resources/app` 可信源码重新构建。
- 不复用旧 `dist/`、旧安装包、旧 `node_modules`、旧备份包或任何历史 packaged build。
- 不生成 `v1.0.10 -> v1.1.0` 快速补丁。
- 不把 `v1.1.0` 设置为旧版软件内更新通道的 latest；`v1.0.10` 用户需要手动下载新版安装包并纯净安装。
- GitHub Release 需要明确提示：`v1.0.10` 及更早安装包有风险，请隔离旧 `.exe` 安装包，不要继续安装或转发。
- 安装包样式继续沿用 `docs/INSTALLER_STYLE.md` 的中文极简黑白蓝格式。

## 发布前检查

- 确认 `package.json` 和 `package-lock.json` 版本号正确。
- 确认 `mineradio.update.owner/repo` 指向正式仓库。
- 确认 `.cookie`、`.qq-cookie`、`updates/`、`node_modules/`、旧 `dist/` 没有进入 git。
- 确认 README/SECURITY/CHANGELOG/Release 正文包含 `v1.0.10` 旧安装包隔离说明。
- 运行语法检查：`git diff --check`、`node --check server.js`、前端内联脚本解析。
- 运行 Git 跟踪风险残留检查，确认没有跟踪 `.exe/.dll/.scr/.bat/.cmd/.ps1/.vbs/.jse/.wsf/.hta/.xlsm` 等可执行/脚本残留。
- 从当前源码执行 `npm run build:win` 生成 Windows 安装包。
- 对新生成的安装包和当前源码执行安全扫描。
- 生成并记录新安装包 SHA256。

## GitHub Release

Release tag：

```text
v1.1.0
```

Release 标题：

```text
Mineradio v1.1.0 纯净安装版
```

建议上传资产：

- `dist/Mineradio-1.1.0-Setup.exe`
- `dist/Mineradio-1.1.0-Setup.exe.blockmap`（可选；本次不作为旧版软件内更新使用）
- `dist/Mineradio-1.1.0-SHA256SUMS.txt`

本次不要上传：

- `latest.yml`
- `v1.0.10 -> v1.1.0` 快速补丁

## 更新检测

应用会请求 GitHub Releases latest。为了避免 `v1.0.10` 旧客户端通过软件内更新直接拉到 `v1.1.0`，本次 GitHub Release 不应设为旧更新通道的 latest。

## 准备发布资产

`release:prepare` 只在本地检查和构建，不会提交代码、创建 tag、推送或上传文件：

```bash
npm run release:prepare
```

需要为指定旧版本生成快速补丁时：

```bash
npm run release:prepare -- --from 1.1.5
```

构建完成后，脚本会生成：

- `dist/Mineradio-update.json`
- `dist/Mineradio-版本-UPLOAD.txt`
- x64/arm64 DMG、`latest-mac.yml` 和可选快速补丁

按照上传清单手动创建并发布 GitHub Release。发布后验证 Latest Release：

```bash
npm run release:verify -- --remote
```

`npm run release:update` 保留为 `release:prepare` 的兼容入口，同样不会操作 Git 或上传大文件。

### 轻量在线更新（无需重新打安装包）

当前 Intel Mac 更新仓库为 `https://github.com/prometheus-lumen/Mineradio-Intel-Mac`，Release 必须发布到该仓库，并设置为 Latest release；发布到原始 Windows 上游仓库时，当前客户端不会检测到。

仓库当前 Latest Release 是 `1.1.3`，但该版本客户端内置的更新源仍是原始 Windows 仓库。因此 `1.1.4` 必须作为一次迁移版重新构建并发布 x64/arm64 DMG，用户手动覆盖安装一次；从 `1.1.4` 升级到后续版本时，才可以稳定只发快速补丁。

Mac 双架构构建产物使用 `Mineradio-版本-架构.dmg` 命名。不要在上传 Release 时手工改名，否则 `latest-mac.yml` 中的路径会与真实资产不一致。

```bash
npm run build:mac:dmg
```

首个支持 `Mineradio-update.json` 的版本必须上传完整 x64/arm64 DMG。之后仅修改 `public/`、`desktop/`、`server.js`、`dj-analyzer.js` 等应用资源，且没有新增运行依赖时，可以附带快速补丁：

```powershell
npm run update:patch -- --from <上一版本的 Git tag 或 commit>
```

命令会比较旧版本与当前工作树，在 `dist/` 生成 `Mineradio-旧版本→新版本.patch.json`，并输出补丁 SHA256。发布时创建高于旧版的新 GitHub Release，只上传该补丁也可以；客户端会自动发现新版本，优先安装补丁并在重启后生效。GitHub 若把文件名中的箭头净化成点号，客户端仍会按补丁内的起止版本精确匹配。

补丁生成前必须先更新 `package.json` 版本号并提交新增文件。若运行依赖有变化、文件操作超过 40 个、补丁超过 12 MB，脚本会拒绝生成，此时必须重新打完整安装包。安装器、Electron 二进制、原生模块和卸载逻辑的变更也必须走完整安装包。

更新清单格式：

```json
{
  "schemaVersion": 1,
  "version": "1.1.6",
  "tag": "1.1.6",
  "releaseUrl": "https://github.com/prometheus-lumen/Mineradio-Intel-Mac/releases/tag/1.1.6",
  "notes": ["更新说明"],
  "assets": {
    "darwin-x64": { "name": "Mineradio-1.1.6-x64.dmg", "size": 123, "sha512": "..." },
    "darwin-arm64": { "name": "Mineradio-1.1.6-arm64.dmg", "size": 123, "sha512": "..." }
  },
  "patches": [
    { "from": "1.1.5", "to": "1.1.6", "name": "Mineradio-1.1.5→1.1.6.patch.json", "size": 123, "sha256": "..." }
  ]
}
```

客户端优先读取此清单。精确补丁成功后自动重启；没有匹配补丁时下载并校验当前架构 DMG，然后自动打开，由用户手动替换应用。
