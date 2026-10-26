# 0.1.33：Python 缓存摘要误报修复

日期：2026-10-12。只修改 PPT 打包规则，保留当前 0.1.32 业务修复，不修改原装宿主。

## 现场与根因

原装 Desktop 2.0.13 已安装 PPT 0.1.32。旧运行时的 `python/Lib/__pycache__/bz2.cpython-313.pyc` 为 15232 字节，清单记录 15227 字节；对应 `bz2.py` 和发行压缩载荷 SHA-256 均匹配。Windows 并行校验也报告 `base64` 缓存不匹配，说明并非只有一个缓存文件受到影响。

旧包将 566 个可再生 `__pycache__` 文件纳入不可变资源清单。Python 在源码时间戳与缓存不符时可重建缓存，使下一次插件加载被完整性校验拒绝。重新安装相同资源包仍会复用旧的内容寻址目录，不能从根本上解决问题。

Windows 打包现在只排除 Python 目录下具有普通对应源码的缓存，包括 `__pycache__/*.pyc` 和同目录旧式 `.pyc`；无源码字节码与浏览器资源不排除。源码、二进制和压缩载荷继续严格校验，不改变运行时校验器。新清单产生独立运行目录，既有 Deck 与运行中的旧资源不覆盖。

## 验证

- 新增 `integrations/dsh/tests/runtime-package.test.mjs`：真实打包、解包、Python 导入和二次加载。修复前复现 `Runtime file digest changed: python/Lib/__pycache__/cache_probe.cpython-314.pyc`；修复后通过。覆盖源码损坏拒绝、无源码字节码保留、浏览器目录不受过滤影响。
- Linux 插件适配全量：50 通过、2 环境相关跳过。扩展打包边界断言后单独重跑新增回归通过。
- Windows Node：运行时与打包回归 7/7 通过。
- 原装 Desktop Electron Node：新增打包回归与其余资源校验通过；原有“复制当前进程可执行文件”孤儿进程夹具因 Electron 缺少相邻 ICU 资源而失败。该夹具在 Windows Node 下通过，不把 Electron 夹具失败计为通过。
- 原装 Desktop 2.0.13 的实际 Node 环境：复现用户旧缓存失败；从最终包建立新运行时，运行私有 Python 3.13.15 导入 `bz2` 并验证压缩/解压，再次获取运行时成功且目录一致。
- 原装 CLI 隔离 Profile：安装 Harness dev.66、PPT 0.1.32，升级 0.1.33，2062 个安装文件与最终包逐项一致；卸载后原装插件、Harness、数据哨兵均保留。用时约 112 秒。
- 已通过原装 CLI 升级用户当前 desktop Profile 到 0.1.33，原装 bundles 和其他依赖保持一致；未自动重启 Desktop。重启后的真实 Deck 界面与完整业务仍需验收，以上不是全部业务和本机/WSL 联合验收。

## 最终包

`dist/aico-ppt-skill-0.1.33-win32-x64.tgz`，243132195 字节，3334 个运行资源文件。

SHA-256：`f54739fa265d8cbb7e43c3fbb6e454e6e8ab7214770f7912ac58ce899f423026`。

原始资源从旧包压缩载荷逐项校验并提取，不使用已发生变更的用户运行缓存打包。原始日志、打包元数据、Windows 验证及安装脚本在工作区 `.verification/ppt-runtime-0133/`。公开 beta0.1 和官网未更新。
