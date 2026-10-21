# 宿主样式参照

来源：本机 deepseek-harness，提交 687f282e8625c6b8d11ff58211a90524be2e4317。

- host-base.css：packages/client/ui-theme/src/styles/base.css 的只读副本。
- host-theme.css：packages/client/ui-theme/src/styles/design-platform.css 的只读副本。
- 来源项目许可证：MIT。保留来源；本原型没有修改来源项目。
- 设置外壳尺寸参考 packages/client/ui-settings-general/src/client/SettingsRoot.module.css：
  桌面 800 × min(800, viewport - 48)，188px 导航，54px 顶栏，内容区左右 24px。
- 窄屏外壳仅用于承载预览；插件自身的窄屏布局仍由当前客户端源码决定。
- 真实 DSH 在 3080 上要求认证，本轮没有重启或修改运行实例；正式源代码的对照渲染入口为 /reference。
