# LOC-022 清理报告

| 项 | 值 |
|---|---|
| 任务 | LOC-022 开发侧 DSH 运行态残留清理与登记册一致性收敛 |
| 执行时间 | 2026-09-16 |
| 人工确认 | 松哥 2026-09-16 确认：全部清理（含 2 条 WAITING_HUMAN）+ 不停开发实例直接清 |
| 删除方式 | `/usr/bin/trash`（macOS 系统回收站，可恢复；彻底清空由用户决定） |
| 前置快照 | `.scratch/LOC-022-dsh-residue-cleanup/execution/before-snapshot.json`（含 sha256） |
| 待清清单 | `.scratch/LOC-022-dsh-residue-cleanup/execution/cleanup-checklist.md` |

## 一、清理前后对比

| 对象 | 清理前 | 清理后 |
|---|---|---|
| `tasks/` 遗留目录（loc-014-r1） | 1 个（265B） | 0 |
| `workspaces/records/` 记录 | 12 个目录 / 24 文件 / 25 KB | 0 |
| `state.json.workspaces` 条目 | 11 | 0 |
| `state.json.locks` 死锁 | 3 | 0 |
| `state.json.archived` 归档 | 1 | 0 |
| `state.json.timeline` 事件日志 | 63 | 63（**保留**，纯历史事件，无路径引用） |
| 产品侧 `~/.dsh/workspaces/` | 13 文件 | 13 文件，**逐字节一致 ✓** |
| `visual-workflow/` | 60 文件 | 60 文件，**逐字节一致 ✓** |
| 仓库 `.agent-runs/` | 976 文件 | 976 文件，**逐字节一致 ✓** |

## 二、执行明细

1. **删除（回收站）**：`tasks/loc-014-r1/` + `workspaces/records/` 下 12 条记录目录，13 项全部成功，零失败。
2. **state.json 收敛（原子写：临时文件 + `os.replace`，回读校验通过）**：
   - `workspaces` 11 条全部移除（workspace_path 实体均已不存在）；
   - `locks` 3 条全部移除（lk-1 / lk-2 / lk-3，均指向已消失的 uat-loc017-b / uat-loc017-lock-holder 实体）；
   - `archived` 1 条移除（uat-lr-04，指向已消失目录）；
   - 保留：`timeline` 63 条、`ports`(12)、`nextPort`、`lockSeq`、`locksByKey`（空）。
3. **实例处理**：开发 DSH（PID 34823，端口 9527）运行中未停。执行前 `lsof` 证实其未打开 tasks/ 或 workspaces/ 下任何文件；执行后间隔 5 秒两次读取 state.json 哈希一致，**实例未覆写，收敛保持**。

## 三、与呈递清单的差异（如实记录）

- 呈递清单的 C2 仅列 `locks.lk-1`（当时读取截断）；执行前复核发现 `locks` 实含 lk-1 / lk-2 / lk-3 三条。三条均指向已消失实体，与已确认的「移除指向已消失实体的条目」规则一致，同规则处理。除此以外执行内容与确认清单完全一致，无超范围动作。

## 四、不可删除项与失败项

无。本次执行没有任何删除失败、跳过或绕过。

## 五、范围外发现（不处理，仅记录）

1. 🟡 **#185 独占 Home 机制标记仍在被使用**：`tasks/loc-019-r1`（09-13）、`tasks/loc-023-r1`（09-14）在 LOC-020 判定该机制退役之后仍按旧机制注册。与规格「机制已退役」的表述有出入；这两个目录属其他任务运行空间，本任务不动。建议 LOC-020 侧关注机制是否真正停止下发。
2. 远端 git 分支 `vwf/run/uat-budget-01`、`vwf/run/uat-budget-02` 仍在 cnb / mirror 远端存在。git 分支清理不在本任务范围。
3. 产品侧 `~/.dsh/workspaces/.vwf-registry/state.json` 的 7 条登记（含 RUNNING / PAUSED）本次未核实、未清理（规格 §18 已知限制，未来是否收敛另议）。
4. `visual-workflow/` 下运行数据是否含残留未核实（规格 §18 已知限制）。

## 六、验收对照（对应规格 §15）

- [x] 只读盘点清单已输出并可逐项核对（cleanup-checklist.md，执行前重盘）
- [x] 人工逐项确认之后才执行删除（松哥 2026-09-16 确认全清 + 不停实例）
- [x] `tasks/loc-014-r1/` 已清
- [x] 开发侧 12 条工作区记录已清
- [x] `state.json` 不再含指向已消失目录的条目（workspaces 0 / locks 0 / archived 0；保留项 timeline / ports 等有明确理由）
- [x] 产品侧 `~/.dsh/workspaces/` 零改动（sha256 逐字节比对一致）
- [x] `.agent-runs/` 与 `visual-workflow/` 零改动（同上）
- [x] 清理报告落盘（本文件）
