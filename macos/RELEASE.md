# HoMix macOS 正式发布

这套流程用于官网直接下载，不是 Mac App Store 提审。正式发布步骤必须在安装了
Xcode 的 Mac 上运行，并且需要有效的 Apple Developer Program 会员资格。

## 一次性准备

1. 在钥匙串中安装 `Developer ID Application` 证书及其私钥。
2. 安装项目依赖：

   ```sh
   cd macos
   pnpm install --frozen-lockfile
   ```

3. 把 Apple 公证凭据保存到钥匙串。推荐使用 App Store Connect Team API Key：

   ```sh
xcrun notarytool store-credentials "HoMix-notary" \
     --key "/absolute/path/AuthKey_KEYID.p8" \
     --key-id "KEYID" \
     --issuer "ISSUER_UUID"
   ```

凭据只进入 macOS 钥匙串，不要写进仓库或脚本。

## 生成发行包

先取得名称包含 `-unsigned.zip` 的中间构建，再在 Mac 上执行：

```sh
export HOMIX_SIGN_IDENTITY="Developer ID Application: Company Name (TEAMID)"
export HOMIX_NOTARY_PROFILE="HoMix-notary"
cd macos
pnpm release -- ../dist/HoMix-0.20.5-macOS-Apple-Silicon-internal-unsigned.zip
```

Intel 包以相同方式处理。脚本依次完成：

1. 对 Electron、Helper、FFmpeg 和 FFprobe 等全部可执行文件签名；
2. 严格验证代码签名和 Hardened Runtime；
3. 上传 Apple Notary Service 并装订公证票据；
4. 使用 `stapler` 与 Gatekeeper 再次验证；
5. 仅在全部成功后生成不带 `unsigned` 的 ZIP。

任何一步失败都不会生成发行包。最终还应在一台未安装开发证书的 Mac 上下载该 ZIP，
确认首次启动只出现正常的“从互联网下载”提示，并完成导入、预览和导出冒烟测试。
