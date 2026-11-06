# TermBeacon 发版踩坑记录

来源：0.1.1 – 0.1.8 的真实发布过程（`HANDOFF.md` 6.20 / 6.30）。

## 422 Published releases must have a valid tag

electron-builder 的 GitHub provider 设为 `releaseType: "release"` 时，GitHub 要求 tag 已存在。0.1.1 首次发布先跑 `dist:publish`，exe 上传成功但 `latest.yml`、`.blockmap` 缺失，只能事后用 Assets API 手工补传。

**: 顺序固定为** `git tag` → `git push origin <tag>` → 构建/上传。本 skill 的 `create-release.mjs` 在遇到 422 时会直接提示这一点。

## EBUSY / 文件被占用

本机 filter driver 会对项目内新生成的文件保留 delete-pending 句柄，导致 `electron-builder` 解压 Electron dist 时报 EBUSY。

**处置**：始终用 `npm run dist`（`scripts/dist-win.mjs`），它构建到 `D:/temp-termbeacon-build` 再拷回 `release/`。失败残留的 scratch 目录会被改名旁置，重启后自动可清理。

## api.github.com 连接超时

本机对 `api.github.com` 偶发连接超时（`UND_ERR_CONNECT_TIMEOUT` / “无法连接到远程服务器”），同一时刻 `github.com` 正常。

**处置**：重试即可，0.1.8 实测第二次成功。脚本内建 4 次指数退避重试，只对连接层与 5xx 重试，4xx 立即报错。不要为此改配置或代理。

## 自动更新检查的是 github.com 而非 api.github.com

`electron-updater` 的 GitHub provider 读 `releases.atom`，不走 REST API。因此 API 通不代表更新检查通；反之亦然。界面显示失败时让用户稍后重试，或设 `TERMBEACON_DISABLE_UPDATES=1`。

## 未签名安装包

没有 `CSC_LINK` / `CSC_KEY_PASSWORD` 时 electron-builder 输出 “no code signing certificate configured, signing is skipped”。Release 说明必须写明“未签名测试包”，否则用户会以为是漏发的正式版。设 `TERMBEACON_FORCE_SIGNING=1` 可让缺证书的发布构建直接失败。

## 版本号与 latest.yml 不一致

`latest.yml` 的 `version` 来自构建时的 `package.json`。先改 `package.json` 再 `npm run dist`，否则上传的 `latest.yml` 会让老版本客户端下载到错误版本。脚本会在上传前比对 `--version` 与 `latest.yml`，不一致直接失败。

## release/ 目录累积历史包

`release/` 里会留着 0.1.1 / 0.1.6 / 0.1.7 / 0.1.8 等多个安装包，`.gitignore` 已排除。上传脚本只挑 `latest.yml` 引用到的文件 + 对应 `.blockmap` + `latest.yml` 本身，不会误传历史包。

## PowerShell 下 git push 的伪失败

`git push` 把进度写到 stderr，PowerShell 会抛出 `NativeCommandError` 并以退出码 1 结束管道。只要输出里出现 `main -> main` 或 `[new tag]` 就是成功，用 `git ls-remote origin refs/heads/main` 复核。

## 提交前检查未跟踪目录

`artifacts/` 曾累积 19 MB Chromium 缓存与截图，从未入库。发版前 `git status --short` 必须逐项判断；产物目录补进 `.gitignore` 而不是提交。