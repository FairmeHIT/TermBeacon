---
name: TermBeacon Release
description: 提交所有改动、升版本号、打 tag、push 并发布 TermBeacon GitHub Release（含安装包、latest.yml、blockmap 上传与 sha512 校验）。当用户说“发布新版本”“提交并发布”“发版”“升版本号”“push 并发布”“release”“打 tag 发布”“上传安装包”时使用。
---

# TermBeacon 发版流程

本流程固化自 0.1.8 的实际发布过程。适用于本仓库（`FairmeHIT/TermBeacon`，Electron + electron-builder + GitHub Releases 自动更新）。

## 硬性规则

1. **顺序不可颠倒**：先 `git push origin main`，再推送 tag，最后才创建 Release。tag 不存在时 GitHub 会返回 422 `Published releases must have a valid tag`（HANDOFF 6.20 踩过）。
2. **先确认再动手**：版本号（patch/minor）、要提交哪些改动、是否上传安装包，三者若用户没明说，先用一个 question 一次性问清。不要擅自 major 升级。
3. **临时产物不入库**：`artifacts/`、`captures/`、`release/`、`dist/`、`*.log` 都在 `.gitignore` 内。发现未跟踪的缓存目录时不要提交，必要时补 `.gitignore`。
4. **测试与构建必须真跑**：`npm test` 与 `npm run build` 都要看到实际输出，不允许凭印象声称通过。
5. **未签名要如实说明**：没有 `CSC_LINK` 时安装包是未签名的，首次运行会有 SmartScreen 提示，Release 说明和最终回复都要写清楚。
6. **push / 建 Release 属于外部副作用**：用户已明确要求“发布/push”时可一路执行到底，无需逐步再确认。

## 步骤

### 1. 现状检查

```powershell
git status --short
git log --oneline -5
git tag --sort=-creatordate
git ls-remote --tags origin
```

判断：
- 当前版本号：`package.json` 的 `version`。
- 待提交内容：功能改动、文档改动、`.gitignore` 变更。
- 未跟踪目录是产物还是源码，逐条判定，不要 `git add -A` 前不做检查。

### 2. 质量门禁

```powershell
npm test
npm run build
git diff --check
```

`npm test` 必须 0 failed。`npm run build` 允许存在 Vite 的 “chunks larger than 500 kB” 警告，但不得有编译错误。

### 3. 提交功能改动

功能改动与版本号提交分开，历史更清晰：

```powershell
git add -A
git commit -m "<一句话功能摘要>" -m "- 要点 1
- 要点 2"
```

提交信息用英文摘要 + 要点，与本仓库既有历史风格一致（`Add ...` / `Fix ...` / `Refine ...`）。

### 4. 升版本号并补文档

- `package.json`：`version` 递增（本仓库节奏是 patch：0.1.7 → 0.1.8）。
- `README.md`：若出现具体版本号示例，改成通用写法（如 `vX.Y.Z`），避免每次发版都要改。
- `HANDOFF.md`：末尾追加一节 `## 6.NN <主题>（YYYY-MM-DD）`，包含本批改动清单 + 验证结论 + 已知限制。发布完成后再补一节记录 Release 链接与资产大小、sha512 结论。

```powershell
git add -A
git commit -m "Release X.Y.Z"
```

### 5. 推送代码与 tag

```powershell
git push origin main
git tag -a vX.Y.Z -m "Release X.Y.Z"
git push origin vX.Y.Z
```

`git ls-remote origin refs/heads/main refs/tags/vX.Y.Z` 确认远端已更新。注意 PowerShell 下 `git push` 往 stderr 写进度会让管道报 `NativeCommandError`，只要输出里出现 `main -> main` / `[new tag]` 就是成功。

### 6. 构建安装包

```powershell
npm run dist
```

不要直接用 `electron-builder`：`scripts/dist-win.mjs` 会构建到项目外 `D:/temp-termbeacon-build` 再拷回 `release/`，规避本机 filter driver 的 EBUSY 锁（HANDOFF 6.8/6.11）。

构建后必须核对：

```powershell
Get-Content release/latest.yml
# version 必须等于本次版本号，size/sha512 与 exe 一致
```

`release/` 里会累积历史版本安装包，本脚本只上传与目标版本匹配的文件。

### 7. 创建 Release 并上传资产

本机没有 `gh` CLI，用随附脚本（自动取 `GH_TOKEN` / `GITHUB_TOKEN`，否则回退 `git credential fill`）：

```powershell
node .opencode/skills/release/scripts/create-release.mjs `
  --version 0.1.9 `
  --notes-file .release-notes.md `
  --verify-download
```

- 先写 `.release-notes.md`（Markdown，中文）：新增 / 修复与改进 / 已知限制三段；已知限制里写未签名和 PTY 不跨重启。
- 脚本幂等：Release 已存在则复用，只补传缺失资产；上传前校验本地 `latest.yml` 与 exe 的 sha512 一致。
- `--verify-download` 会把线上 exe 重新拉下来算 sha512 并与 `latest.yml` 比对，确认自动更新链路可用（约 95 MB，慢但值得做一次）。
- `--dry-run` 只做本地校验与资产清单打印，不创建不修改。

### 8. 收尾验证

```powershell
node .opencode/skills/release/scripts/create-release.mjs --version 0.1.9 --verify-only
```

或者手工：

```powershell
(Invoke-RestMethod -Uri "https://api.github.com/repos/FairmeHIT/TermBeacon/releases/latest" -Headers @{'User-Agent'='tb'}).tag_name
```

期望输出 `vX.Y.Z`。随后把 Release 链接与资产信息补进 `HANDOFF.md`，再 `git add` / `commit` / `push` 一次。

### 9. 汇报格式

最终回复按「提交 / 验证 / 发布」三段给表格或列表，必须包含：
- 各 commit hash 与内容，tag 名与 hash，远端 `main` HEAD。
- `npm test` 的具体通过数量、构建结论。
- Release 链接、资产名与字节数、sha512 是否一致。
- 未签名提示。

## 已知故障与处置

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| 422 `Published releases must have a valid tag` | 先发布后推 tag | 先推 tag 再重跑脚本；已创建的 Release 删除重建 |
| `EBUSY` 构建失败 | 本机 filter driver 锁 | 用 `npm run dist`（走项目外 scratch），失败后重启再试 |
| `api.github.com` 连接超时 | 网络抖动 | 重试，本机实测第二次即成功；不要改代码绕过 |
| 自动更新检查超时 | electron-updater 读 `github.com/releases.atom`，非 api | 提示用户稍后重试，必要时 `TERMBEACON_DISABLE_UPDATES=1` |
| 安装包体积异常 | 把 `artifacts/`、`release/` 打进包 | 检查 `electron-builder.config.cjs` 的 `files` 排除项 |

更完整的踩坑记录见 `references/lesson-log.md`。