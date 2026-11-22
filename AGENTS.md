# 酒馆扩展开发与发布约定

日常开发和提交直接在 `main` 分支进行。

每次发布功能或修复，都要让已安装此扩展的酒馆能从「扩展 → 管理扩展」拉到更新。

1. 按 README 的发布步骤递增版本并运行 `pnpm run check`。版本钩子负责同步 `manifest.json` 和 JS/CSS 的缓存版本参数。
2. 从 `main` 创建发布提交对应的 `v<版本号>` 标签。将 `main`、标签和旧安装跟踪的 `codex/initial-extension` 一起推送，确保新旧酒馆都能拉到同一次发布。旧分支仅用于兼容已安装的酒馆。

   ```sh
   tag="v$(node -p "require('./package.json').version")"
   git push --atomic origin main main:refs/heads/codex/initial-extension "refs/tags/$tag"
   ```

3. 用 `git ls-remote` 核对两个远端分支和版本标签指向同一发布提交。若本次任务包含更新酒馆实例，再通过该实例的扩展管理器更新并核对加载的版本。
